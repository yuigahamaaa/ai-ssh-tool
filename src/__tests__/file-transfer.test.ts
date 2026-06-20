import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { writeFileSync, unlinkSync, existsSync, mkdirSync, readFileSync, symlinkSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import ssh2 from "ssh2"
import { SSHConnection } from "../connection.js"
import { uploadFile, downloadFile } from "../file-transfer.js"
import type { TransferResult } from "../file-transfer.js"
import type { SSHHostConfig } from "../types.js"

import { createStableEd25519KeyPair } from "./ssh-test-key.js"

const { Server } = ssh2
const hostKey = createStableEd25519KeyPair()
const memFs = new Map<string, Buffer>()
const remoteExecResults = new Map<string, { stdout: string, stderr: string }>()
const remoteExecQueue: Array<{ stdout: string, stderr?: string }> = []

function enqueueExecResponse(stdout: string, stderr = "") {
  remoteExecQueue.push({ stdout, stderr })
}

function unquoteShellSingle(value: string): string {
  return value.slice(1, -1).replace(/'\\''/g, "'")
}

function createTestServer(): Promise<{
  server: InstanceType<typeof Server>
  port: number
  hostConfig: Omit<SSHHostConfig, "id">
  cleanup: () => Promise<void>
}> {
  return new Promise((resolve, reject) => {
    const server = new Server({ hostKeys: [hostKey.private] }, (client: any) => {
      client.on("authentication", (ctx: any) => {
        if (ctx.method === "password" && ctx.password === "testpass") ctx.accept()
        else ctx.reject()
      })
      client.on("ready", () => {
        client.on("session", (accept: any) => {
          const session = accept()
          session.on("pty", (accept: any) => { accept() })
          session.on("window-change", (accept: any) => { if (accept) accept() })
          session.on("shell", (accept: any) => {
            const stream = accept()
            stream.on("close", () => {})
          })
          session.on("exec", (acceptExec: any, _rejectExec: any, info: any) => {
            const stream = acceptExec()
            const queuedResult = remoteExecQueue.shift()
            const testResult = remoteExecResults.get("test")
            if (queuedResult) {
              stream.write(queuedResult.stdout)
              stream.write(queuedResult.stderr ?? "")
            } else if (testResult) {
              stream.write(testResult.stdout)
              stream.write(testResult.stderr)
              remoteExecResults.delete("test")
            } else if (typeof info?.command === "string") {
              const existsMatch = info.command.match(/test -e ('(?:'\\''|[^'])*'|"(?:\\.|[^"])*") && echo "YES" \|\| echo "NO"/)
              if (existsMatch) {
                const remotePath = existsMatch[1].startsWith("'")
                  ? unquoteShellSingle(existsMatch[1])
                  : JSON.parse(existsMatch[1])
                stream.write(memFs.has(remotePath) ? "YES\n" : "NO\n")
              } else {
                stream.write("ok\n")
              }
            } else {
              stream.write("ok\n")
            }
            stream.exit(0)
            stream.close()
          })
          session.on("sftp", (acceptSftp: any) => {
            const sftpStream = acceptSftp()
            const handles = new Map<number, { path: string; data?: Buffer; pos: number }>()
            let nextHandle = 1
            sftpStream.on("OPEN", (reqId: any, path: any, flags: any) => {
              const h = nextHandle++
              if (flags & 0x02) {
                handles.set(h, { path, data: Buffer.alloc(0), pos: 0 })
              } else {
                const data = memFs.get(path)
                if (data) handles.set(h, { path, data, pos: 0 })
                else { sftpStream.status(reqId, 2); return }
              }
              const buf = Buffer.alloc(4); buf.writeUInt32BE(h, 0); sftpStream.handle(reqId, buf)
            })
            sftpStream.on("READ", (reqId: any, handle: any, offset: any, len: any) => {
              const h = handle.readUInt32BE(0); const entry = handles.get(h)
              if (!entry?.data) { sftpStream.status(reqId, 2); return }
              if (offset >= entry.data.length) { sftpStream.status(reqId, 1); return }
              sftpStream.data(reqId, entry.data.subarray(offset, offset + len))
            })
            sftpStream.on("WRITE", (reqId: any, handle: any, offset: any, data: any) => {
              const h = handle.readUInt32BE(0); const entry = handles.get(h)
              if (!entry) { sftpStream.status(reqId, 2); return }
              const needed = offset + data.length
              if (!entry.data || entry.data.length < needed) {
                const grown = Buffer.alloc(needed); if (entry.data) entry.data.copy(grown); entry.data = grown
              }
              data.copy(entry.data, offset); sftpStream.status(reqId, 0)
            })
            sftpStream.on("CLOSE", (reqId: any, handle: any) => {
              const h = handle.readUInt32BE(0); const entry = handles.get(h)
              if (entry?.data && entry.path) memFs.set(entry.path, entry.data)
              handles.delete(h); sftpStream.status(reqId, 0)
            })
            sftpStream.on("STAT", (reqId: any, path: any) => {
              const data = memFs.get(path)
              if (data) sftpStream.attrs(reqId, { mode: 0o100644, size: data.length, uid: 0, gid: 0, atime: 0, mtime: 0 })
              else sftpStream.status(reqId, 2)
            })
            sftpStream.on("REALPATH", (reqId: any, path: any) => {
              sftpStream.name(reqId, [{ filename: path, longname: "", attrs: {} as any }])
            })
          })
        })
      })
    })
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      if (!addr || typeof addr === "string") { reject(new Error("Failed")); return }
      resolve({
        server,
        port: addr.port,
        hostConfig: { name: "test", host: "127.0.0.1", port: addr.port, auth: { username: "testuser", password: "testpass" } },
        cleanup: () => new Promise<void>((res) => { memFs.clear(); server.close(() => setTimeout(res, 50)) }),
      })
    })
    server.on("error", reject)
  })
}

describe("File Transfer - Upload Basic", () => {
  let srv: Awaited<ReturnType<typeof createTestServer>>
  let conn: SSHConnection
  let tmpDir: string

  before(async () => {
    srv = await createTestServer()
    conn = new SSHConnection()
    await conn.connect({ chain: [{ id: "t1", ...srv.hostConfig }], timeout: 5000 })
    tmpDir = join(tmpdir(), "ssh-tool-test-upload")
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true })
  })

  after(async () => {
    await conn.disconnect()
    await srv.cleanup()
  })

  it("uploads a small text file", async () => {
    const localPath = join(tmpDir, "test.txt")
    writeFileSync(localPath, "Hello World")
    memFs.clear()
    const result = await uploadFile(conn.getFinalClient(), localPath, "/remote/test.txt")
    assert.equal(result.success, true)
    assert.equal(result.size, 11)
    assert.ok(result.duration >= 0)
    assert.ok(memFs.has("/remote/test.txt"))
    assert.equal(memFs.get("/remote/test.txt")?.toString(), "Hello World")
  })

  it("uploads a file into an existing remote directory using the local basename", async () => {
    const localPath = join(tmpDir, "dir-target.txt")
    writeFileSync(localPath, "directory target")
    memFs.clear()
    enqueueExecResponse("NO\n")

    const result = await uploadFile(conn.getFinalClient(), localPath, "/remote/uploads/")

    assert.equal(result.success, true)
    assert.equal(result.path, "/remote/uploads/dir-target.txt")
    assert.equal(result.finalPath, "/remote/uploads/dir-target.txt")
    assert.equal(result.targetType, "file")
    assert.equal(result.action, "uploaded")
    assert.equal(memFs.get("/remote/uploads/dir-target.txt")?.toString(), "directory target")
  })

  it("uploads binary content", async () => {
    const localPath = join(tmpDir, "binary.bin")
    const data = Buffer.from([0x00, 0x01, 0x02, 0xFF, 0xFE])
    writeFileSync(localPath, data)
    memFs.clear()
    const result = await uploadFile(conn.getFinalClient(), localPath, "/remote/binary.bin")
    assert.equal(result.success, true)
    assert.deepEqual(memFs.get("/remote/binary.bin"), data)
  })

  it("reports progress via callback", async () => {
    const localPath = join(tmpDir, "test.txt")
    writeFileSync(localPath, "Progress test data")
    const progressEvents: number[] = []
    await uploadFile(conn.getFinalClient(), localPath, "/remote/progress.txt", {
      onProgress: (p) => { progressEvents.push(p.percent) },
    })
    assert.ok(progressEvents.length > 0)
  })
})

describe("File Transfer - Overwrite Strategies", () => {
  let srv: Awaited<ReturnType<typeof createTestServer>>
  let conn: SSHConnection
  let tmpDir: string

  before(async () => {
    srv = await createTestServer()
    conn = new SSHConnection()
    await conn.connect({ chain: [{ id: "t1", ...srv.hostConfig }], timeout: 5000 })
    tmpDir = join(tmpdir(), "ssh-tool-test-overwrite")
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true })
  })

  after(async () => {
    await conn.disconnect()
    await srv.cleanup()
  })

  it("overwrites existing file by default", async () => {
    const localPath = join(tmpDir, "overwrite.txt")
    writeFileSync(localPath, "new content")
    memFs.set("/remote/overwrite.txt", Buffer.from("old content"))
    const result = await uploadFile(conn.getFinalClient(), localPath, "/remote/overwrite.txt", { overwrite: "overwrite" })
    assert.equal(result.success, true)
    assert.equal(memFs.get("/remote/overwrite.txt")?.toString(), "new content")
  })

  it("skips existing file with skip strategy", async () => {
    const localPath = join(tmpDir, "skip.txt")
    writeFileSync(localPath, "new content")
    memFs.set("/remote/skip.txt", Buffer.from("old content"))
    const result = await uploadFile(conn.getFinalClient(), localPath, "/remote/skip.txt", { overwrite: "skip" })
    assert.equal(result.success, true)
    assert.equal(result.size, 0)
    assert.equal(result.action, "skipped")
    assert.equal(result.skipped, true)
    assert.equal(result.finalPath, "/remote/skip.txt")
    assert.equal(memFs.get("/remote/skip.txt")?.toString(), "old content")
  })
})

describe("File Transfer - Line Ending Conversion", () => {
  let srv: Awaited<ReturnType<typeof createTestServer>>
  let conn: SSHConnection
  let tmpDir: string

  before(async () => {
    srv = await createTestServer()
    conn = new SSHConnection()
    await conn.connect({ chain: [{ id: "t1", ...srv.hostConfig }], timeout: 5000 })
    tmpDir = join(tmpdir(), "ssh-tool-test-lineendings")
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true })
  })

  after(async () => {
    await conn.disconnect()
    await srv.cleanup()
  })

  it("converts LF to CRLF when specified", async () => {
    const localPath = join(tmpDir, "lf.txt")
    writeFileSync(localPath, "line1\nline2\nline3", "utf8")
    memFs.clear()
    const result = await uploadFile(conn.getFinalClient(), localPath, "/remote/lf.txt", { lineEnding: "crlf" })
    assert.equal(result.success, true)
    const content = memFs.get("/remote/lf.txt")?.toString()
    assert.ok(content?.includes("\r\n"))
    assert.equal(content?.includes("\0"), false)
  })

  it("preserves binary mode", async () => {
    const localPath = join(tmpDir, "binary2.bin")
    const data = Buffer.from([0x0d, 0x0a, 0x0a, 0x0d])
    writeFileSync(localPath, data)
    memFs.clear()
    const result = await uploadFile(conn.getFinalClient(), localPath, "/remote/binary2.bin", { lineEnding: "binary" })
    assert.equal(result.success, true)
    assert.deepEqual(memFs.get("/remote/binary2.bin"), data)
  })
})

describe("File Transfer - Symbolic Links", () => {
  let srv: Awaited<ReturnType<typeof createTestServer>>
  let conn: SSHConnection
  let tmpDir: string

  before(async () => {
    srv = await createTestServer()
    conn = new SSHConnection()
    await conn.connect({ chain: [{ id: "t1", ...srv.hostConfig }], timeout: 5000 })
    tmpDir = join(tmpdir(), "ssh-tool-test-symlinks")
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true })
  })

  after(async () => {
    await conn.disconnect()
    await srv.cleanup()
  })

  it("skips symbolic link when skipSymlinks is true", async () => {
    const targetPath = join(tmpDir, "real.txt")
    const symlinkPath = join(tmpDir, "link.txt")
    writeFileSync(targetPath, "target content")
    try { symlinkSync(targetPath, symlinkPath) } catch {}
    memFs.clear()
    const result = await uploadFile(conn.getFinalClient(), symlinkPath, "/remote/link.txt", { skipSymlinks: true })
    assert.equal(result.success, true)
    assert.equal(result.size, 0)
  })
})

describe("File Transfer - Download Basic", () => {
  let srv: Awaited<ReturnType<typeof createTestServer>>
  let conn: SSHConnection
  let tmpDir: string

  before(async () => {
    srv = await createTestServer()
    conn = new SSHConnection()
    await conn.connect({ chain: [{ id: "t1", ...srv.hostConfig }], timeout: 5000 })
    tmpDir = join(tmpdir(), "ssh-tool-test-download")
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true })
    memFs.set("/remote/download.txt", Buffer.from("downloaded content"))
  })

  after(async () => {
    await conn.disconnect()
    await srv.cleanup()
    try { unlinkSync(join(tmpDir, "download.txt")) } catch {}
  })

  it("downloads an existing file", async () => {
    const localPath = join(tmpDir, "download.txt")
    const result = await downloadFile(conn.getFinalClient(), "/remote/download.txt", localPath)
    assert.equal(result.success, true)
    assert.ok(existsSync(localPath))
  })

  it("downloads a file into an existing local directory using the remote basename", async () => {
    const localDir = join(tmpDir, "downloads")
    mkdirSync(localDir, { recursive: true })
    memFs.set("/remote/nested/report.txt", Buffer.from("report content"))

    const result = await downloadFile(conn.getFinalClient(), "/remote/nested/report.txt", localDir)

    const expectedPath = join(localDir, "report.txt")
    assert.equal(result.success, true)
    assert.equal(result.path, expectedPath)
    assert.equal(readFileSync(expectedPath, "utf8"), "report content")
  })
})

describe("File Transfer - TransferResult structure", () => {
  it("has all required fields", () => {
    const result: TransferResult = { success: true, path: "/test", size: 100, duration: 50 }
    assert.equal(result.success, true)
    assert.equal(result.path, "/test")
    assert.equal(result.size, 100)
    assert.equal(result.duration, 50)
    assert.equal(result.error, undefined)
  })

  it("supports error field", () => {
    const result: TransferResult = { success: false, path: "/fail", size: 0, duration: 10, error: "disk full" }
    assert.equal(result.success, false)
    assert.equal(result.error, "disk full")
  })
})
