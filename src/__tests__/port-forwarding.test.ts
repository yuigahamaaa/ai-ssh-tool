import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import ssh2 from "ssh2"
import { SSHConnection } from "../connection.js"
import { PortForwardManager } from "../port-forwarding.js"
import type { SSHHostConfig } from "../types.js"

const { Server, utils } = ssh2
const hostKey = utils.generateKeyPairSync("ed25519")

function createTestServer(opts?: { enableForwarding?: boolean }): Promise<{
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
        if (opts?.enableForwarding) {
          client.on("tcpip", (accept: any, rejectConn: any) => { try { rejectConn?.() } catch {} })
        }
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

describe("Port Forwarding - Local Forward", () => {
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

  describe("localForward", () => {
    it("creates a local forward and returns PortForward", async () => {
      const manager = new PortForwardManager(conn.getFinalClient())
      const fwd = await manager.localForward("127.0.0.1", 0, "127.0.0.1", 22)
      assert.ok(typeof fwd.id === "string")
      assert.ok(fwd.id.length > 0)
      assert.equal(fwd.type, "local")
      assert.equal(fwd.status, "active")
      assert.ok(fwd.bindPort > 0)
      assert.ok(fwd.createdAt > 0)
      await manager.stopAll()
    })

    it("auto-assigns port when bindPort is 0", async () => {
      const manager = new PortForwardManager(conn.getFinalClient())
      const fwd = await manager.localForward("127.0.0.1", 0, "127.0.0.1", 22)
      assert.ok(fwd.bindPort > 0)
      assert.notEqual(fwd.bindPort, 0)
      await manager.stopAll()
    })
  })

  describe("list", () => {
    it("lists all active forwards", async () => {
      const manager = new PortForwardManager(conn.getFinalClient())
      await manager.localForward("127.0.0.1", 0, "127.0.0.1", 22)
      await manager.localForward("127.0.0.1", 0, "127.0.0.1", 80)
      const list = manager.list()
      assert.ok(list.length >= 2)
      assert.equal(list[0].type, "local")
      await manager.stopAll()
    })

    it("returns empty when no forwards exist", () => {
      const manager = new PortForwardManager(conn.getFinalClient())
      assert.deepEqual(manager.list(), [])
    })
  })

  describe("get", () => {
    it("returns forward by id", async () => {
      const manager = new PortForwardManager(conn.getFinalClient())
      const fwd = await manager.localForward("127.0.0.1", 0, "127.0.0.1", 22)
      const found = manager.get(fwd.id)
      assert.ok(found)
      assert.equal(found!.id, fwd.id)
      assert.equal(found!.type, "local")
      await manager.stopAll()
    })

    it("returns null for unknown id", () => {
      const manager = new PortForwardManager(conn.getFinalClient())
      assert.equal(manager.get("nonexistent"), null)
    })
  })

  describe("stop", () => {
    it("stops a specific forward", async () => {
      const manager = new PortForwardManager(conn.getFinalClient())
      const fwd = await manager.localForward("127.0.0.1", 0, "127.0.0.1", 22)
      const result = await manager.stop(fwd.id)
      assert.equal(result, true)
      assert.equal(manager.get(fwd.id), null)
    })

    it("returns false for unknown id", async () => {
      const manager = new PortForwardManager(conn.getFinalClient())
      const result = await manager.stop("nonexistent")
      assert.equal(result, false)
    })
  })

  describe("stopAll", () => {
    it("stops all forwards", async () => {
      const manager = new PortForwardManager(conn.getFinalClient())
      await manager.localForward("127.0.0.1", 0, "127.0.0.1", 22)
      await manager.localForward("127.0.0.1", 0, "127.0.0.1", 80)
      assert.ok(manager.list().length >= 2)
      await manager.stopAll()
      assert.equal(manager.list().length, 0)
    })

    it("handles empty state", async () => {
      const manager = new PortForwardManager(conn.getFinalClient())
      await manager.stopAll()
      assert.equal(manager.list().length, 0)
    })
  })
})
