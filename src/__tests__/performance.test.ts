import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { writeFileSync, mkdirSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import ssh2 from "ssh2"
import { SSHConnection } from "../connection.js"
import { remoteExec } from "../remote-shell.js"
import { uploadFile, downloadFile } from "../file-transfer.js"
import type { SSHHostConfig } from "../types.js"

const { Server, utils } = ssh2
const hostKey = utils.generateKeyPairSync("ed25519")

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
          session.on("shell", (accept: any) => { const s = accept(); s.on("close", () => {}) })
          session.on("exec", (acceptExec: any) => {
            const stream = acceptExec()
            stream.write("ok\n")
            stream.exit(0)
            stream.close()
          })
          session.on("sftp", (acceptSftp: any) => {
            const sftpStream = acceptSftp()
            const handles = new Map<number, { path: string; data?: Buffer }>()
            let nextHandle = 1
            sftpStream.on("OPEN", (reqId: any, path: any, flags: any) => {
              const h = nextHandle++
              if (flags & 0x02) {
                handles.set(h, { path, data: Buffer.alloc(0) })
              } else {
                sftpStream.status(reqId, 2)
                return
              }
              const buf = Buffer.alloc(4)
              buf.writeUInt32BE(h, 0)
              sftpStream.handle(reqId, buf)
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
              handles.delete(h)
              sftpStream.status(reqId, 0)
            })
            sftpStream.on("STAT", (reqId: any) => {
              sftpStream.status(reqId, 2)
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
        cleanup: () => new Promise<void>((res) => { server.close(() => setTimeout(res, 50)) }),
      })
    })
    server.on("error", reject)
  })
}

function measureMemory(): number {
  if (global.gc) global.gc()
  return process.memoryUsage().heapUsed / (1024 * 1024)
}

describe("Performance Tests", () => {
  let srv: Awaited<ReturnType<typeof createTestServer>>
  let conn: SSHConnection

  before(async () => {
    srv = await createTestServer()
    conn = new SSHConnection()
    await conn.connect({ chain: [{ id: "t1", ...srv.hostConfig }], timeout: 5000 })
  })

  after(async () => {
    await conn.disconnect()
    await srv.cleanup()
  })

  describe("connection performance", () => {
    it("single hop connect < 2s", async () => {
      const start = Date.now()
      const c = new SSHConnection()
      await c.connect({ chain: [{ id: "perf1", ...srv.hostConfig }], timeout: 5000 })
      const duration = Date.now() - start
      assert.ok(duration < 2000, `Connection took ${duration}ms, should be < 2000ms`)
      await c.disconnect()
    })

    it("session reconnect < 500ms", async () => {
      const c1 = new SSHConnection()
      await c1.connect({ chain: [{ id: "r1", ...srv.hostConfig }], timeout: 5000 })
      await c1.disconnect()

      const start = Date.now()
      const c2 = new SSHConnection()
      await c2.connect({ chain: [{ id: "r2", ...srv.hostConfig }], timeout: 5000 })
      const duration = Date.now() - start
      assert.ok(duration < 500, `Reconnect took ${duration}ms, should be < 500ms`)
      await c2.disconnect()
    })
  })

  describe("remote command performance", () => {
    it("single exec < 500ms", async () => {
      const start = Date.now()
      await remoteExec(conn.getFinalClient(), "echo fast", { timeout: 5000 })
      const duration = Date.now() - start
      assert.ok(duration < 500, `Exec took ${duration}ms, should be < 500ms`)
    })

    it("10 sequential execs < 5s", async () => {
      const start = Date.now()
      for (let i = 0; i < 10; i++) {
        await remoteExec(conn.getFinalClient(), `echo seq-${i}`, { timeout: 5000 })
      }
      const duration = Date.now() - start
      assert.ok(duration < 5000, `10 execs took ${duration}ms, should be < 5000ms`)
    })

    it("10 concurrent execs < 3s", async () => {
      const start = Date.now()
      const tasks = Array.from({ length: 10 }, (_, i) =>
        remoteExec(conn.getFinalClient(), `echo par-${i}`, { timeout: 5000 }),
      )
      await Promise.all(tasks)
      const duration = Date.now() - start
      assert.ok(duration < 3000, `10 concurrent execs took ${duration}ms, should be < 3000ms`)
    })
  })

  describe("file transfer performance", () => {
    it("1KB upload < 500ms", async () => {
      const tmpDir = join(tmpdir(), "ssh-perf-test")
      if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true })
      const filePath = join(tmpDir, "perf-1k.bin")
      writeFileSync(filePath, Buffer.alloc(1024, 0xAB))

      const start = Date.now()
      const result = await uploadFile(conn.getFinalClient(), filePath, "/tmp/perf-1k.bin")
      const duration = Date.now() - start
      assert.ok(result.success)
      assert.ok(duration < 500, `1KB upload took ${duration}ms, should be < 500ms`)
    })

    it("100KB upload < 1s", async () => {
      const tmpDir = join(tmpdir(), "ssh-perf-test")
      if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true })
      const filePath = join(tmpDir, "perf-100k.bin")
      writeFileSync(filePath, Buffer.alloc(100 * 1024, 0xCD))

      const start = Date.now()
      const result = await uploadFile(conn.getFinalClient(), filePath, "/tmp/perf-100k.bin")
      const duration = Date.now() - start
      assert.ok(result.success)
      assert.ok(duration < 1000, `100KB upload took ${duration}ms, should be < 1000ms`)
    })

    it("1MB upload < 3s", async () => {
      const tmpDir = join(tmpdir(), "ssh-perf-test")
      if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true })
      const filePath = join(tmpDir, "perf-1m.bin")
      writeFileSync(filePath, Buffer.alloc(1024 * 1024, 0xEF))

      const start = Date.now()
      const result = await uploadFile(conn.getFinalClient(), filePath, "/tmp/perf-1m.bin")
      const duration = Date.now() - start
      assert.ok(result.success)
      assert.ok(duration < 3000, `1MB upload took ${duration}ms, should be < 3000ms`)
    })
  })

  describe("memory stability", () => {
    it("repeated execs do not leak memory significantly", async () => {
      measureMemory()
      const before = measureMemory()

      for (let i = 0; i < 20; i++) {
        await remoteExec(conn.getFinalClient(), `echo mem-${i}`, { timeout: 5000 })
      }

      const after = measureMemory()
      const growth = after - before
      assert.ok(growth < 20, `Memory grew ${growth.toFixed(1)}MB, should be < 20MB`)
    })
  })
})
