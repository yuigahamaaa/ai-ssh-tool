import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import ssh2 from "ssh2"
import { SSHConnection } from "../connection.js"
import { BackgroundExecManager } from "../background-exec.js"
import type { SSHHostConfig } from "../types.js"

const { Server, utils } = ssh2
const hostKey = utils.generateKeyPairSync("ed25519")
const executedCommands: string[] = []

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
            let receivedData = ""
            stream.on("data", (data: Buffer) => {
              receivedData += data.toString()
            })
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
        cleanup: () => new Promise<void>((res) => { executedCommands.length = 0; server.close(() => setTimeout(res, 50)) }),
      })
    })
    server.on("error", reject)
  })
}

describe("Background Exec Manager - Basic Functionality", () => {
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

  it("returns task by id with getStatus", async () => {
    const manager = new BackgroundExecManager()
    const task = await manager.start(conn.getFinalClient(), "echo status")
    const status = manager.getStatus(task.id)
    assert.ok(status)
    assert.equal(status!.id, task.id)
  })

  it("returns null for unknown id with getStatus", () => {
    const manager = new BackgroundExecManager()
    assert.equal(manager.getStatus("nonexistent"), null)
  })

  it("returns output object with getOutput", async () => {
    const manager = new BackgroundExecManager()
    const task = await manager.start(conn.getFinalClient(), "echo output")
    await new Promise((r) => setTimeout(r, 200))
    const output = manager.getOutput(task.id)
    assert.ok(output)
    assert.equal(typeof output!.stdout, "string")
    assert.equal(typeof output!.stderr, "string")
  })
})

describe("Background Exec Manager - Cancel Functionality", () => {
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

  it("returns false for unknown id with cancel", () => {
    const manager = new BackgroundExecManager()
    assert.equal(manager.cancel("nonexistent"), false)
  })

  it("returns false for already completed task with cancel", async () => {
    const manager = new BackgroundExecManager()
    const task = await manager.start(conn.getFinalClient(), "echo done")
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(manager.cancel(task.id), false)
  })

  it("sets task status to cancelled when cancel is called", async () => {
    const manager = new BackgroundExecManager()
    const task = await manager.start(conn.getFinalClient(), "sleep 10")
    const cancelResult = manager.cancel(task.id)
    assert.equal(cancelResult, true)
    const status = manager.getStatus(task.id)
    assert.equal(status!.status, "cancelled")
  })
})

describe("Background Exec Manager - Persistent Mode", () => {
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

  it("starts task with persistent mode enabled", async () => {
    const manager = new BackgroundExecManager()
    const task = await manager.start(conn.getFinalClient(), "echo persistent test", { persistent: true })
    assert.equal(task.status, "running")
    assert.ok(task.id.length > 0)
  })

  it("starts task with detached mode enabled", async () => {
    const manager = new BackgroundExecManager()
    const task = await manager.start(conn.getFinalClient(), "echo detached test", { detached: true })
    assert.equal(task.status, "running")
  })
})

describe("Background Exec Manager - List & Remove", () => {
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

  it("returns empty array initially with list", () => {
    const manager = new BackgroundExecManager()
    assert.deepEqual(manager.list(), [])
  })

  it("lists started tasks with list", async () => {
    const manager = new BackgroundExecManager()
    await manager.start(conn.getFinalClient(), "echo list1")
    await manager.start(conn.getFinalClient(), "echo list2")
    const tasks = manager.list()
    assert.ok(tasks.length >= 2)
  })

  it("returns false for unknown id with remove", () => {
    const manager = new BackgroundExecManager()
    assert.equal(manager.remove("nonexistent"), false)
  })
})

describe("Background Exec Manager - Wait Functionality", () => {
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

  it("resolves when task completes with wait", async () => {
    const manager = new BackgroundExecManager()
    const task = await manager.start(conn.getFinalClient(), "echo wait")
    const result = await manager.wait(task.id, 5000)
    assert.ok(result)
    assert.equal(result.id, task.id)
  })

  it("throws for nonexistent task with wait", async () => {
    const manager = new BackgroundExecManager()
    await assert.rejects(() => manager.wait("nonexistent", 5000))
  })
})
