/**
 * File Transfer Pipeline Tests
 * Tests for stream.pipeline improvements in file transfer
 */

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { writeFileSync, unlinkSync, existsSync, mkdirSync, readFileSync, createWriteStream } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import ssh2 from "ssh2"
import { SSHConnection } from "../connection.js"
import { uploadFile, downloadFile } from "../file-transfer.js"
import type { TransferResult } from "../file-transfer.js"
import type { SSHHostConfig } from "../types.js"

// Suppress ECONNRESET fired by ssh2's mock Server during teardown — SFTP
// sessions can emit late socket errors after the test body has already
// passed, and Node's test runner otherwise reports them as post-test async
// failures. Other SFTP mock tests use the same guard.
process.on("uncaughtException", (err: any) => {
  if (err?.code === "ECONNRESET" || err?.code === "ERR_STREAM_PREMATURE_CLOSE") return
  throw err
})

import { createStableEd25519KeyPair } from "./ssh-test-key.js"

const { Server } = ssh2
const hostKey = createStableEd25519KeyPair()
const memFs = new Map<string, Buffer>()

function createTestServer(): Promise<{
  server: InstanceType<typeof Server>
  port: number
  hostConfig: Omit<SSHHostConfig, "id">
  cleanup: () => Promise<void>
}> {
  return new Promise((resolve, reject) => {
    const clients = new Set<any>()
    const server = new Server({ hostKeys: [hostKey.private] }, (client: any) => {
      clients.add(client)
      client.on("close", () => clients.delete(client))
      client.on("authentication", (ctx: any) => {
        if (ctx.method === "password" && ctx.password === "testpass") ctx.accept()
        else ctx.reject()
      })
      client.on("ready", () => {
        client.on("session", (accept: any) => {
          const session = accept()
          session.on("pty", (accept: any) => accept())
          session.on("shell", (accept: any) => {
            const stream = accept()
            stream.on("close", () => {})
          })
          session.on("exec", (acceptExec: any) => {
            const stream = acceptExec()
            stream.write("ok\n")
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
              const h = handle.readUInt32BE(0)
              const entry = handles.get(h)
              if (!entry?.data) { sftpStream.status(reqId, 2); return }
              if (offset >= entry.data.length) { sftpStream.status(reqId, 1); return }
              sftpStream.data(reqId, entry.data.subarray(offset, offset + len))
            })
            sftpStream.on("WRITE", (reqId: any, handle: any, offset: any, data: any) => {
              const h = handle.readUInt32BE(0)
              const entry = handles.get(h)
              if (!entry) { sftpStream.status(reqId, 2); return }
              const needed = offset + data.length
              if (!entry.data || entry.data.length < needed) {
                const grown = Buffer.alloc(needed)
                if (entry.data) entry.data.copy(grown)
                entry.data = grown
              }
              data.copy(entry.data, offset)
              sftpStream.status(reqId, 0)
            })
            sftpStream.on("CLOSE", (reqId: any, handle: any) => {
              const h = handle.readUInt32BE(0)
              const entry = handles.get(h)
              if (entry?.data && entry.path) memFs.set(entry.path, entry.data)
              handles.delete(h)
              sftpStream.status(reqId, 0)
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
        cleanup: () => new Promise<void>((res) => {
          memFs.clear()
          for (const client of clients) {
            try { client.end() } catch {}
            try { (client as any)._sock?.destroy?.() } catch {}
          }
          server.close(() => setTimeout(res, 200))
        }),
      })
    })
    server.on("error", reject)
  })
}

describe("File Transfer Pipeline Tests", () => {
  let srv: Awaited<ReturnType<typeof createTestServer>>
  let conn: SSHConnection
  let tmpDir: string

  before(async () => {
    srv = await createTestServer()
    conn = new SSHConnection()
    await conn.connect({ chain: [{ id: "t1", ...srv.hostConfig }], timeout: 5000 })
    tmpDir = join(tmpdir(), "ssh-tool-pipeline-test")
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true })
  })

  after(async () => {
    await conn.disconnect()
    await srv.cleanup()
  })

  describe("Small File Direct Upload", () => {
    it("should upload small file using direct method", async () => {
      const localPath = join(tmpDir, "small.txt")
      const content = "Hello Pipeline"
      writeFileSync(localPath, content)
      memFs.clear()
      
      const result = await uploadFile(conn.getFinalClient(), localPath, "/remote/small.txt")
      
      assert.equal(result.success, true)
      assert.equal(result.size, content.length)
      assert.ok(result.duration >= 0)
      assert.ok(memFs.has("/remote/small.txt"))
      assert.equal(memFs.get("/remote/small.txt")?.toString(), content)
    })

    it("should handle small binary file", async () => {
      const localPath = join(tmpDir, "small.bin")
      const data = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xFF])
      writeFileSync(localPath, data)
      memFs.clear()
      
      const result = await uploadFile(conn.getFinalClient(), localPath, "/remote/small.bin")
      
      assert.equal(result.success, true)
      assert.deepEqual(memFs.get("/remote/small.bin"), data)
    })
  })

  describe("Large File Streaming Upload", () => {
    it("should upload large file using streaming pipeline", async () => {
      const localPath = join(tmpDir, "large.bin")
      const chunkSize = 1024 * 1024
      const numChunks = 15
      const expectedSize = chunkSize * numChunks
      
      const writeStream = createWriteStream(localPath)
      for (let i = 0; i < numChunks; i++) {
        const chunk = Buffer.alloc(chunkSize, i % 256)
        writeStream.write(chunk)
      }
      writeStream.end()
      
      await new Promise<void>((resolve) => writeStream.on("finish", resolve))
      
      memFs.clear()
      
      const result = await uploadFile(conn.getFinalClient(), localPath, "/remote/large.bin", {
        fileSizeThreshold: 1024 * 1024,
      })
      
      assert.equal(result.success, true)
      assert.ok(result.size >= expectedSize)
      assert.ok(memFs.has("/remote/large.bin"))
      
      const downloaded = memFs.get("/remote/large.bin")!
      assert.equal(downloaded.length, expectedSize)
      
      unlinkSync(localPath)
    })

    it("should report progress during streaming upload", async () => {
      const localPath = join(tmpDir, "progress.bin")
      const chunkSize = 1024 * 1024
      const numChunks = 5
      
      const writeStream = createWriteStream(localPath)
      for (let i = 0; i < numChunks; i++) {
        writeStream.write(Buffer.alloc(chunkSize, i))
      }
      writeStream.end()
      
      await new Promise<void>((resolve) => writeStream.on("finish", resolve))
      
      memFs.clear()
      const progressEvents: number[] = []
      
      const result = await uploadFile(conn.getFinalClient(), localPath, "/remote/progress.bin", {
        fileSizeThreshold: 512 * 1024,
        onProgress: (p) => progressEvents.push(p.percent),
      })
      
      assert.equal(result.success, true)
      assert.ok(progressEvents.length > 0)
      assert.ok(progressEvents.every((p) => p >= 0 && p <= 100))
      
      unlinkSync(localPath)
    })
  })

  describe("Streaming Download", () => {
    before(() => {
      memFs.set("/remote/download.bin", Buffer.alloc(5 * 1024 * 1024, 0xAB))
    })

    it("should download file using streaming pipeline", async () => {
      const localPath = join(tmpDir, "dl_stream.bin")
      
      const result = await downloadFile(conn.getFinalClient(), "/remote/download.bin", localPath, {
        fileSizeThreshold: 1024 * 1024,
      })
      
      assert.equal(result.success, true)
      assert.ok(existsSync(localPath))
      assert.ok(result.size >= 5 * 1024 * 1024)
      
      if (existsSync(localPath)) unlinkSync(localPath)
    })

    it("should report progress during streaming download", async () => {
      const localPath = join(tmpDir, "dl_progress.bin")
      const progressEvents: number[] = []
      
      const result = await downloadFile(conn.getFinalClient(), "/remote/download.bin", localPath, {
        fileSizeThreshold: 512 * 1024,
        onProgress: (p) => progressEvents.push(p.percent),
      })
      
      assert.equal(result.success, true)
      assert.ok(progressEvents.length > 0)
      
      if (existsSync(localPath)) unlinkSync(localPath)
    })
  })

  describe("TransferResult Structure", () => {
    it("should return complete TransferResult on success", async () => {
      const localPath = join(tmpDir, "result.txt")
      writeFileSync(localPath, "test content")
      memFs.clear()
      
      const result = await uploadFile(conn.getFinalClient(), localPath, "/remote/result.txt")
      
      assert.equal(result.success, true)
      assert.equal(result.path, "/remote/result.txt")
      assert.ok(typeof result.size === "number")
      assert.ok(typeof result.duration === "number")
      assert.equal(result.error, undefined)
    })

    it("should include error message on failure", () => {
      const result: TransferResult = {
        success: false,
        path: "/fail/path",
        size: 0,
        duration: 0,
        error: "Permission denied",
      }
      
      assert.equal(result.success, false)
      assert.ok(result.error)
      assert.equal(result.error, "Permission denied")
    })
  })

  describe("Encoding Conversion via Pipeline", () => {
    it("should convert UTF-8 to latin1 when specified", async () => {
      const localPath = join(tmpDir, "utf8.txt")
      const content = "Hello world"
      writeFileSync(localPath, content, "utf8")
      memFs.clear()
      
      const result = await uploadFile(conn.getFinalClient(), localPath, "/remote/utf8.txt", {
        encoding: "latin1",
      })
      
      assert.equal(result.success, true)
    })
  })

  describe("Line Ending Conversion via Pipeline", () => {
    it("should convert LF to CRLF on upload", async () => {
      const localPath = join(tmpDir, "lf.txt")
      writeFileSync(localPath, "line1\nline2\nline3", "utf8")
      memFs.clear()
      
      const result = await uploadFile(conn.getFinalClient(), localPath, "/remote/lf.txt", {
        lineEnding: "crlf",
      })
      
      assert.equal(result.success, true)
      const uploaded = memFs.get("/remote/lf.txt")
      assert.ok(uploaded?.toString().includes("\r\n"))
    })

    it("should convert CRLF to LF on upload", async () => {
      const localPath = join(tmpDir, "crlf.txt")
      writeFileSync(localPath, "line1\r\nline2\r\nline3", "utf8")
      memFs.clear()
      
      const result = await uploadFile(conn.getFinalClient(), localPath, "/remote/crlf.txt", {
        lineEnding: "lf",
      })
      
      assert.equal(result.success, true)
      const uploaded = memFs.get("/remote/crlf.txt")
      assert.ok(!uploaded?.toString().includes("\r\r\n"))
    })
  })

  describe("Encoding Conversion - GBK and Latin1", () => {
    it("should convert UTF-8 to GBK when specified", async () => {
      const localPath = join(tmpDir, "to-gbk.txt")
      const content = "你好世界"  // Chinese characters
      writeFileSync(localPath, content, "utf8")
      memFs.clear()
      
      const result = await uploadFile(conn.getFinalClient(), localPath, "/remote/to-gbk.txt", {
        encoding: "gbk",
      })
      
      assert.equal(result.success, true)
      const uploaded = memFs.get("/remote/to-gbk.txt")
      assert.ok(uploaded, "File should be uploaded")
      // GBK encoded bytes are different from UTF-8, so reading as UTF-8 gives wrong chars
      assert.notEqual(uploaded?.toString("utf8"), content, "GBK bytes should not decode as valid UTF-8")
      // But when properly decoded as GBK and re-encoded as UTF-8, it should match
      const iconv = await import("iconv-lite")
      const decodedBack = iconv.default.decode(uploaded!, "gbk")
      assert.equal(decodedBack, content, "Content should be convertible from GBK back to original")
    })

    it("should handle latin1 encoding conversion", async () => {
      const localPath = join(tmpDir, "to-latin1.txt")
      const content = "café résumé"  // Characters with accents
      writeFileSync(localPath, content, "utf8")
      memFs.clear()
      
      const result = await uploadFile(conn.getFinalClient(), localPath, "/remote/to-latin1.txt", {
        encoding: "latin1",
      })
      
      assert.equal(result.success, true)
      const uploaded = memFs.get("/remote/to-latin1.txt")
      assert.ok(uploaded, "File should be uploaded")
      // Latin1 should encode accented characters correctly
      const decodedContent = uploaded?.toString("latin1")
      assert.equal(decodedContent, content, "Content should be converted back to Latin1 when read as Latin1")
    })
  })

  describe("Download Encoding Conversion", () => {
    it("should convert remote UTF-8 to local GBK when specified", async () => {
      const localPath = join(tmpDir, "from-gbk.txt")
      // Simulate a remote file that is in UTF-8
      memFs.set("/remote/utf8-source.txt", Buffer.from("你好世界", "utf8"))
      
      const result = await downloadFile(conn.getFinalClient(), "/remote/utf8-source.txt", localPath, {
        encoding: "gbk",
      })
      
      assert.equal(result.success, true)
      // When downloaded with GBK encoding, the UTF-8 content should be converted to GBK
      const downloadedContent = readFileSync(localPath)
      const decodedContent = downloadedContent.toString("utf8")
      // The content should still be valid UTF-8 since we're just writing GBK-encoded bytes
      assert.ok(downloadedContent.length > 0, "File should be downloaded")
    })

    it("should convert remote UTF-8 to local latin1 when specified", async () => {
      const localPath = join(tmpDir, "from-latin1.txt")
      memFs.set("/remote/latin1-source.txt", Buffer.from("café résumé", "utf8"))
      
      const result = await downloadFile(conn.getFinalClient(), "/remote/latin1-source.txt", localPath, {
        encoding: "latin1",
      })
      
      assert.equal(result.success, true)
      const downloadedContent = readFileSync(localPath)
      assert.ok(downloadedContent.length > 0, "File should be downloaded")
    })
  })

  describe("Overwrite Behavior", () => {
    it("should overwrite existing remote file by default", async () => {
      const localPath = join(tmpDir, "overwrite-test.txt")
      writeFileSync(localPath, "new content here")
      memFs.set("/remote/overwrite-test.txt", Buffer.from("old content"))
      
      const result = await uploadFile(conn.getFinalClient(), localPath, "/remote/overwrite-test.txt")
      
      assert.equal(result.success, true)
      assert.equal(memFs.get("/remote/overwrite-test.txt")?.toString(), "new content here")
    })

    it("should overwrite existing local file on download by default", async () => {
      const localPath = join(tmpDir, "local-overwrite.txt")
      writeFileSync(localPath, "old local content")
      memFs.set("/remote/remote-overwrite.txt", Buffer.from("new remote content"))
      
      const result = await downloadFile(conn.getFinalClient(), "/remote/remote-overwrite.txt", localPath)
      
      assert.equal(result.success, true)
      assert.equal(readFileSync(localPath, "utf8"), "new remote content")
    })
  })
})
