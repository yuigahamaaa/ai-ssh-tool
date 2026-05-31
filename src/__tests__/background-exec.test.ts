import { describe, it, before, after, afterEach } from "node:test"
import assert from "node:assert/strict"
import ssh2 from "ssh2"
import { SSHConnection } from "../connection.js"
import { BackgroundExecManager } from "../background-exec.js"
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
            stream.write("12345\n")
            stream.write("result\n")
            setTimeout(() => {
              stream.exit(0)
              stream.close()
            }, 50)
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

describe("Background Exec Manager", () => {
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

  describe("start", () => {
    it("starts a background task and returns BackgroundTask", async () => {
      const manager = new BackgroundExecManager()
      const task = await manager.start(conn.getFinalClient(), "echo hello")
      assert.ok(typeof task.id === "string")
      assert.ok(task.id.length > 0)
      assert.equal(task.command, "echo hello")
      assert.ok(task.startedAt > 0)
    })

    it("task status is running immediately", async () => {
      const manager = new BackgroundExecManager()
      const task = await manager.start(conn.getFinalClient(), "echo test")
      assert.equal(task.status, "running")
    })
  })

  describe("getStatus", () => {
    it("returns task by id", async () => {
      const manager = new BackgroundExecManager()
      const task = await manager.start(conn.getFinalClient(), "echo status")
      const status = manager.getStatus(task.id)
      assert.ok(status)
      assert.equal(status!.id, task.id)
    })

    it("returns null for unknown id", () => {
      const manager = new BackgroundExecManager()
      assert.equal(manager.getStatus("nonexistent"), null)
    })
  })

  describe("getOutput", () => {
    it("returns output object", async () => {
      const manager = new BackgroundExecManager()
      const task = await manager.start(conn.getFinalClient(), "echo output")
      await new Promise((r) => setTimeout(r, 200))
      const output = manager.getOutput(task.id)
      assert.ok(output)
      assert.equal(typeof output!.stdout, "string")
      assert.equal(typeof output!.stderr, "string")
    })

    it("returns null for unknown id", () => {
      const manager = new BackgroundExecManager()
      assert.equal(manager.getOutput("nonexistent"), null)
    })
  })

  describe("getOutputSince", () => {
    it("returns partial output from offset", async () => {
      const manager = new BackgroundExecManager()
      const task = await manager.start(conn.getFinalClient(), "echo since")
      await new Promise((r) => setTimeout(r, 200))
      const output = manager.getOutputSince(task.id, 0, 0)
      assert.ok(output)
      assert.equal(typeof output!.stdout, "string")
    })

    it("returns null for unknown id", () => {
      const manager = new BackgroundExecManager()
      assert.equal(manager.getOutputSince("nonexistent", 0, 0), null)
    })
  })

  describe("cancel", () => {
    it("returns false for unknown id", () => {
      const manager = new BackgroundExecManager()
      assert.equal(manager.cancel("nonexistent"), false)
    })

    it("returns false for already completed task", async () => {
      const manager = new BackgroundExecManager()
      const task = await manager.start(conn.getFinalClient(), "echo done")
      await new Promise((r) => setTimeout(r, 300))
      assert.equal(manager.cancel(task.id), false)
    })
  })

  describe("wait", () => {
    it("resolves when task completes", async () => {
      const manager = new BackgroundExecManager()
      const task = await manager.start(conn.getFinalClient(), "echo wait")
      const result = await manager.wait(task.id, 5000)
      assert.ok(result)
      assert.equal(result.id, task.id)
    })

    it("throws for nonexistent task", async () => {
      const manager = new BackgroundExecManager()
      await assert.rejects(() => manager.wait("nonexistent", 5000))
    })
  })

  describe("list", () => {
    it("returns empty array initially", () => {
      const manager = new BackgroundExecManager()
      assert.deepEqual(manager.list(), [])
    })

    it("lists started tasks", async () => {
      const manager = new BackgroundExecManager()
      await manager.start(conn.getFinalClient(), "echo list1")
      await manager.start(conn.getFinalClient(), "echo list2")
      const tasks = manager.list()
      assert.ok(tasks.length >= 2)
    })
  })

  describe("remove", () => {
    it("returns false for unknown id", () => {
      const manager = new BackgroundExecManager()
      assert.equal(manager.remove("nonexistent"), false)
    })
  })
})
