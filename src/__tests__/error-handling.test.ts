import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import ssh2 from "ssh2"
import { SSHConnection } from "../connection.js"
import type { SSHHostConfig } from "../types.js"

import { createStableEd25519KeyPair } from "./ssh-test-key.js"

const { Server } = ssh2
const hostKey = createStableEd25519KeyPair()

function createTestServer(opts?: { failAuth?: boolean }): Promise<{
  server: InstanceType<typeof Server>
  port: number
  hostConfig: Omit<SSHHostConfig, "id">
  cleanup: () => Promise<void>
}> {
  return new Promise((resolve, reject) => {
    const server = new Server({ hostKeys: [hostKey.private] }, (client: any) => {
      client.on("authentication", (ctx: any) => {
        if (opts?.failAuth) {
          ctx.reject()
          return
        }
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

describe("Error Handling", () => {
  describe("connection errors", () => {
    it("empty chain throws", async () => {
      const conn = new SSHConnection()
      await assert.rejects(
        () => conn.connect({ chain: [], timeout: 5000 }),
        /cannot be empty/i,
      )
    })

    it("connection refused", async () => {
      const conn = new SSHConnection()
      await assert.rejects(
        () => conn.connect({
          chain: [{ id: "t1", name: "refused", host: "127.0.0.1", port: 1, auth: { username: "u", password: "p" } }],
          timeout: 2000,
        }),
      )
    })

    it("wrong password", async () => {
      const srv = await createTestServer()
      try {
        const conn = new SSHConnection()
        await assert.rejects(
          () => conn.connect({
            chain: [{ id: "t1", name: "test", host: "127.0.0.1", port: srv.port, auth: { username: "testuser", password: "wrong" } }],
            timeout: 5000,
          }),
        )
      } finally { await srv.cleanup() }
    })
  })

  describe("state errors", () => {
    it("isConnected returns false initially", () => {
      const conn = new SSHConnection()
      assert.equal(conn.isConnected(), false)
    })

    it("getFinalClient throws when not connected", () => {
      const conn = new SSHConnection()
      assert.throws(() => conn.getFinalClient(), /Not connected/)
    })

    it("getFinalHost throws when not connected", () => {
      const conn = new SSHConnection()
      assert.throws(() => conn.getFinalHost(), /Not connected/)
    })

    it("getHopClients returns empty initially", () => {
      const conn = new SSHConnection()
      assert.deepEqual(conn.getHopClients(), [])
    })

    it("sendData throws when not connected", async () => {
      const conn = new SSHConnection()
      await assert.rejects(() => conn.sendData("test"), /Not connected/)
    })

    it("disconnect emits disconnected without prior connect", async () => {
      const conn = new SSHConnection()
      const events: any[] = []
      conn.on("event", (e: any) => events.push(e))
      await conn.disconnect()
      assert.equal(conn.isConnected(), false)
      assert.ok(events.some((e) => e.type === "disconnected"))
    })

    it("resize is no-op when not connected", async () => {
      const conn = new SSHConnection()
      await conn.resize(80, 24)
    })
  })

  describe("connection events", () => {
    it("emits connecting event before failure", async () => {
      const conn = new SSHConnection()
      const events: any[] = []
      conn.on("event", (e: any) => events.push(e))
      try {
        await conn.connect({
          chain: [{ id: "t1", name: "test", host: "127.0.0.1", port: 1, auth: { username: "u", password: "p" } }],
          timeout: 500,
        })
      } catch {}
      assert.ok(events.some((e) => e.type === "connecting"))
      assert.ok(events.some((e) => e.type === "error"))
    })

    it("passes sessionId in events", async () => {
      const conn = new SSHConnection()
      const events: any[] = []
      conn.on("event", (e: any) => events.push(e))
      try {
        await conn.connect({
          chain: [{ id: "t1", name: "test", host: "127.0.0.1", port: 1, auth: { username: "u", password: "p" } }],
          timeout: 500,
          sessionId: "my-sess-123",
        })
      } catch {}
      const connecting = events.find((e) => e.type === "connecting")
      assert.ok(connecting)
      assert.equal(connecting.sessionId, "my-sess-123")
    })

    it("cleans up hops after failed connection", async () => {
      const conn = new SSHConnection()
      try {
        await conn.connect({
          chain: [{ id: "t1", name: "test", host: "127.0.0.1", port: 1, auth: { username: "u", password: "p" } }],
          timeout: 500,
        })
      } catch {}
      assert.deepEqual(conn.getHopClients(), [])
    })
  })
})
