import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mock } from "node:test"
import { EventEmitter } from "events"
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { Readable, Writable } from "stream"

import { uploadFolder, downloadFolder, assertTarMembersWithin, setTarSpawn } from "../file-transfer.js"
import { clearDialectCache, putCachedDialect } from "../remote-dialect/cache.js"

describe("assertTarMembersWithin", () => {
  it("accepts plain relative members", () => {
    assert.doesNotThrow(() =>
      assertTarMembersWithin(["src/a.txt", "src/deep/b.txt", "."], "/extract"),
    )
  })

  it("rejects members escaping via ../", () => {
    assert.throws(
      () => assertTarMembersWithin(["../evil.txt"], "/extract"),
      /escape|outside/i,
    )
  })

  it("rejects absolute members", () => {
    assert.throws(
      () => assertTarMembersWithin(["/etc/passwd"], "/extract"),
      /escape|outside/i,
    )
  })

  it("rejects members that normalize outside the target", () => {
    assert.throws(
      () => assertTarMembersWithin(["a/../../evil.txt"], "/extract"),
      /escape|outside/i,
    )
  })
})

function makeMockClient() {
  const client = new EventEmitter() as any
  client.exec = mock.fn((_cmd: string, cb: Function) => {
    const stream = new EventEmitter() as any
    stream.stderr = new EventEmitter()
    stream.write = mock.fn(() => {})
    stream.close = mock.fn(() => stream.emit("close", 0))
    cb(null, stream)
    process.nextTick(() => stream.emit("close", 0))
    return stream
  })
  return client
}

function makeMockSpawn() {
  const children: any[] = []
  const spawn = mock.fn(() => {
    const child: any = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.pid = 12345
    child.kill = mock.fn((_sig?: string) => {
      child.killed = true
      return true
    })
    children.push(child)
    return child
  })
  return { spawn, children }
}

/**
 * SFTP mock：内存文件系统 Map 驱动，支持 SFTP 递归分支所需的
 * mkdir/readdir/stat/createReadStream/createWriteStream/end。
 */
function makeSftpClient(remoteFs: Map<string, Buffer>) {
  const calls = { mkdirs: [] as string[], puts: [] as string[] }
  const sftp: any = new EventEmitter()
  sftp.end = () => {}
  sftp.mkdir = (p: string, optsOrCb: any, maybeCb?: any) => {
    const cb = typeof optsOrCb === "function" ? optsOrCb : maybeCb
    calls.mkdirs.push(String(p))
    cb(null)
  }
  sftp.readdir = (p: string, cb: any) => {
    const dir = String(p).replace(/\/+$/, "")
    const prefix = dir === "" ? "" : `${dir}/`
    const seen = new Map<string, boolean>()
    for (const path of remoteFs.keys()) {
      if (!path.startsWith(prefix)) continue
      const rest = path.slice(prefix.length)
      const seg = rest.split("/")[0]
      if (!seg) continue
      if (rest.includes("/")) seen.set(seg, true)
      else if (!seen.has(seg)) seen.set(seg, false)
    }
    cb(null, [...seen.entries()].map(([filename, isDir]) => ({
      filename,
      attrs: { isDirectory: () => isDir, isSymbolicLink: () => false },
    })))
  }
  sftp.stat = (p: string, cb: any) => cb(null, { size: remoteFs.get(String(p))?.length ?? 0, mode: 0o644 })
  sftp.createReadStream = (p: string) => {
    const r = new Readable({ read() {} })
    process.nextTick(() => { r.push(remoteFs.get(String(p)) ?? Buffer.from("")); r.push(null) })
    return r
  }
  sftp.createWriteStream = (p: string) => {
    calls.puts.push(String(p))
    const w = new Writable({ write(chunk, _enc, cb) { remoteFs.set(String(p), Buffer.concat([remoteFs.get(String(p)) ?? Buffer.alloc(0), chunk])); cb() } })
    return w
  }
  sftp.fastPut = (_l: string, r: string, _o: any, cb: any) => cb(null)
  sftp.fastGet = (r: string, l: string, _o: any, cb: any) => {
    writeFileSync(l, remoteFs.get(String(r)) ?? Buffer.from(""))
    cb(null)
  }
  const client: any = new EventEmitter()
  client.exec = mock.fn((_cmd: string, cb: Function) => {
    const stream = new EventEmitter() as any
    stream.stderr = new EventEmitter()
    stream.write = mock.fn(() => {})
    stream.close = mock.fn(() => stream.emit("close", 0))
    cb(null, stream)
    process.nextTick(() => stream.emit("close", 0))
    return stream
  })
  client.sftp = mock.fn((cb: Function) => cb(null, sftp))
  return { client, sftp, calls }
}

describe("uploadFolder async tar", () => {
  it("rejects invalid compression levels before starting transfer", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "ft-folder-"))
    try {
      await assert.rejects(
        () => uploadFolder(makeMockClient(), tmp, "/remote/dir", { compressionLevel: 10 }),
        /compressionLevel must be an integer from 1 to 9/,
      )
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("compresses with spawn and cleans up temp files on tar failure", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "ft-folder-"))
    const tmpFilesBefore = new Set(readdirSync(tmpdir()).filter((f) => f.startsWith("ssh-upload-")))
    const { spawn, children } = makeMockSpawn()
    setTarSpawn(spawn as any)
    let result: any
    try {
      result = await uploadFolder(makeMockClient(), tmp, "/remote/dir", { timeout: 200 })
    } finally {
      setTarSpawn(null)
    }

    assert.equal(result.success, false)
    assert.equal(result.action, "failed")
    // spawn used (not execSync), tar child killed on the timeout/failure path
    assert.ok(spawn.mock.callCount() >= 1)
    assert.ok(children.some((c) => c.killed))
    // local temp archive removed by TransferScope cleanup
    const tmpFilesAfter = readdirSync(tmpdir()).filter((f) => f.startsWith("ssh-upload-"))
    assert.ok(
      tmpFilesAfter.every((f) => tmpFilesBefore.has(f)),
      "no new ssh-upload-* temp files left behind",
    )
    rmSync(tmp, { recursive: true, force: true })
  })

  it("keeps the SIGKILL backstop alive after a timeout (TERM then KILL)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "ft-folder-"))
    const { spawn, children } = makeMockSpawn()
    setTarSpawn(spawn as any)
    try {
      await uploadFolder(makeMockClient(), tmp, "/remote/dir", { timeout: 50 })
    } finally {
      setTarSpawn(null)
    }
    rmSync(tmp, { recursive: true, force: true })

    // The mock child never exits, so the timeout path must (1) SIGTERM first,
    // then (2) still fire the 500ms SIGKILL follow-up even though the promise
    // already settled with code 124.
    const child = children[0]
    assert.ok(child, "a tar child must have been spawned")
    assert.equal(child.kill.mock.calls[0]?.arguments[0], "SIGTERM")
    await new Promise((r) => setTimeout(r, 650))
    const signals = child.kill.mock.calls.map((c: any) => c.arguments[0])
    assert.ok(signals.includes("SIGKILL"), `expected a SIGKILL follow-up, got: ${signals.join(",")}`)
  })
})

describe("folder transfer via SFTP recursion (non-posix dialect)", () => {
  it("uploads recursively via SFTP without tar when the session dialect is cmd", async () => {
    putCachedDialect("u@h:22", { kind: "cmd", sub: "cmd", detectedAt: Date.now() })
    try {
      const tmp = mkdtempSync(join(tmpdir(), "ft-sftp-up-"))
      writeFileSync(join(tmp, "a.txt"), "aaa")
      mkdirSync(join(tmp, "sub"), { recursive: true })
      writeFileSync(join(tmp, "sub", "b.txt"), "bbb")
      const remoteFs = new Map<string, Buffer>()
      const { client, calls } = makeSftpClient(remoteFs)

      const result = await uploadFolder(client, tmp, "C:/remote/dir", {
        sessionKey: "u@h:22",
        overwrite: "overwrite",
        timeout: 5000,
      })

      assert.equal(result.success, true)
      assert.ok(calls.mkdirs.length >= 1, `expected remote mkdir calls, got ${JSON.stringify(calls.mkdirs)}`)
      assert.equal(remoteFs.get("C:/remote/dir/a.txt")?.toString(), "aaa")
      assert.equal(remoteFs.get("C:/remote/dir/sub/b.txt")?.toString(), "bbb")
      const execCmds = client.exec.mock.calls.map((c: any) => String(c.arguments[0]))
      assert.ok(!execCmds.some((c: any) => c.includes("tar")), `unexpected tar exec: ${JSON.stringify(execCmds)}`)
      rmSync(tmp, { recursive: true, force: true })
    } finally {
      clearDialectCache()
    }
  })

  it("downloads recursively via SFTP without tar when the session dialect is cmd", async () => {
    putCachedDialect("u@h:22", { kind: "cmd", sub: "cmd", detectedAt: Date.now() })
    try {
      const tmp = mkdtempSync(join(tmpdir(), "ft-sftp-dl-"))
      const remoteFs = new Map<string, Buffer>()
      remoteFs.set("C:/remote/dir/a.txt", Buffer.from("aaa"))
      remoteFs.set("C:/remote/dir/sub/b.txt", Buffer.from("bbb"))
      const { client } = makeSftpClient(remoteFs)

      const result = await downloadFolder(client, "C:/remote/dir", tmp, {
        sessionKey: "u@h:22",
        overwrite: "overwrite",
        timeout: 5000,
      })

      assert.equal(result.success, true)
      assert.equal(readFileSync(join(tmp, "dir", "a.txt"), "utf8"), "aaa")
      assert.equal(readFileSync(join(tmp, "dir", "sub", "b.txt"), "utf8"), "bbb")
      const execCmds = client.exec.mock.calls.map((c: any) => String(c.arguments[0]))
      assert.ok(!execCmds.some((c: any) => c.includes("tar")), `unexpected tar exec: ${JSON.stringify(execCmds)}`)
      rmSync(tmp, { recursive: true, force: true })
    } finally {
      clearDialectCache()
    }
  })
})
