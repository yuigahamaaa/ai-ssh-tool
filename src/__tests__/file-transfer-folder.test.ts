import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mock } from "node:test"
import { EventEmitter } from "events"
import { mkdtempSync, rmSync, readdirSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

import { uploadFolder, assertTarMembersWithin, setTarSpawn } from "../file-transfer.js"

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

describe("uploadFolder async tar", () => {
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
