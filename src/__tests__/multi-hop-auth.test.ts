import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import ssh2 from "ssh2"
import { createConnection } from "net"
import { SSHConnection } from "../connection.js"
import { remoteExec } from "../remote-shell.js"
import type { SSHHostConfig } from "../types.js"

import { createStableEd25519KeyPair } from "./ssh-test-key.js"

const { Server } = ssh2
const hostKey = createStableEd25519KeyPair()
const userPrivateKey = createStableEd25519KeyPair()

function createTestServer(opts?: {
  authMethods?: ("password" | "publickey")[]
  enableForwarding?: boolean
}): Promise<{
  server: InstanceType<typeof Server>
  port: number
  cleanup: () => Promise<void>
}> {
  return new Promise((resolve, reject) => {
    const allowedAuth = opts?.authMethods ?? ["password", "publickey"]
    const clients = new Set<any>()
    const forwardSockets = new Set<any>()
    const server = new Server(
      { hostKeys: [hostKey.private] },
      (client: any) => {
        clients.add(client)
        client.on("close", () => clients.delete(client))
        client.on("error", () => {})
        client.on("authentication", (ctx: any) => {
          if (allowedAuth.includes("password") && ctx.method === "password" && ctx.password === "testpass") {
            ctx.accept()
          } else if (allowedAuth.includes("publickey") && ctx.method === "publickey") {
            ctx.accept()
          } else {
            ctx.reject()
          }
        })
        client.on("ready", () => {
          if (opts?.enableForwarding) {
            client.on("tcpip", (accept: any, rejectConn: any, info: any) => {
              const sock = createConnection(info.destPort, info.destIP, () => {
                forwardSockets.add(sock)
                const stream = accept()
                stream.on("error", () => {})
                sock.on("data", (d: any) => { try { stream.write(d) } catch {} })
                stream.on("data", (d: any) => { try { sock.write(d) } catch {} })
                sock.on("error", () => { forwardSockets.delete(sock); try { stream.close() } catch {} })
                sock.on("close", () => { forwardSockets.delete(sock); try { stream.close() } catch {} })
                stream.on("close", () => { forwardSockets.delete(sock); try { sock.destroy() } catch {} })
              })
              sock.on("error", () => { try { rejectConn?.() } catch {} })
            })
          }
          client.on("session", (accept: any) => {
            const session = accept()
            session.on("pty", (accept: any) => { accept() })
          session.on("window-change", (accept: any) => { if (accept) accept() })
          session.on("shell", (accept: any) => { const s = accept(); s.on("error", () => {}); s.on("close", () => {}) })
          session.on("exec", (acceptExec: any, _rejectExec: any, info: any) => {
              const stream = acceptExec()
              stream.on("error", () => {})
              const command = String(info?.command ?? "").replace(/^echo\s+"SSH_TOOL_PID:\$\$"\s+>&2;\s+exec\s+/, "")
              if (command.startsWith("echo ")) stream.write(`${command.slice(5)}\n`)
              else stream.write("ok\n")
              stream.exit(0)
              stream.close()
            })
          })
        })
      },
    )
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      if (!addr || typeof addr === "string") { reject(new Error("Failed")); return }
      resolve({
        server,
        port: addr.port,
        cleanup: () => new Promise<void>((res) => {
          for (const sock of forwardSockets) { try { sock.destroy() } catch {} }
          forwardSockets.clear()
          for (const client of clients) { try { client.end() } catch {}; try { (client as any)._sock?.destroy?.() } catch {} }
          server.close(() => setTimeout(res, 200))
        }),
      })
    })
    server.on("error", reject)
  })
}

describe("Multi-hop Mixed Authentication", () => {
  describe("1-hop: single auth method", () => {
    it("password auth", async () => {
      const srv = await createTestServer({ authMethods: ["password"] })
      try {
        const conn = new SSHConnection()
        await conn.connect({
          chain: [{ id: "t1", name: "test-pw", host: "127.0.0.1", port: srv.port, auth: { username: "testuser", password: "testpass" } }],
          timeout: 5000,
        })
        assert.equal(conn.isConnected(), true)
        const result = await remoteExec(conn.getFinalClient(), "echo test", { timeout: 5000 })
        assert.ok(result.stdout.includes("test"))
        await conn.disconnect()
      } finally { await srv.cleanup() }
    })

    it("publickey auth", async () => {
      const srv = await createTestServer({ authMethods: ["publickey"] })
      try {
        const conn = new SSHConnection()
        await conn.connect({
          chain: [{ id: "t1", name: "test-key", host: "127.0.0.1", port: srv.port, auth: { username: "testuser", privateKey: userPrivateKey.private } }],
          timeout: 5000,
        })
        assert.equal(conn.isConnected(), true)
        await conn.disconnect()
      } finally { await srv.cleanup() }
    })
  })

  describe("2-hop: mixed auth methods", () => {
    it("hop1: password, hop2: password", async () => {
      const gw = await createTestServer({ authMethods: ["password"], enableForwarding: true })
      const target = await createTestServer({ authMethods: ["password"] })
      try {
        const conn = new SSHConnection()
        await conn.connect({
          chain: [
            { id: "gw", name: "gateway", host: "127.0.0.1", port: gw.port, auth: { username: "u1", password: "testpass" } },
            { id: "t1", name: "target", host: "127.0.0.1", port: target.port, auth: { username: "u2", password: "testpass" } },
          ],
          timeout: 10000,
        })
        assert.equal(conn.isConnected(), true)
        const result = await remoteExec(conn.getFinalClient(), "echo pw-pw", { timeout: 5000 })
        assert.ok(result.stdout.includes("pw-pw"))
        await conn.disconnect()
      } finally { await gw.cleanup(); await target.cleanup() }
    })

    it("hop1: password, hop2: publickey", async () => {
      const gw = await createTestServer({ authMethods: ["password"], enableForwarding: true })
      const target = await createTestServer({ authMethods: ["publickey"] })
      try {
        const conn = new SSHConnection()
        await conn.connect({
          chain: [
            { id: "gw", name: "gateway", host: "127.0.0.1", port: gw.port, auth: { username: "u1", password: "testpass" } },
            { id: "t1", name: "target", host: "127.0.0.1", port: target.port, auth: { username: "u2", privateKey: userPrivateKey.private } },
          ],
          timeout: 10000,
        })
        assert.equal(conn.isConnected(), true)
        await conn.disconnect()
      } finally { await gw.cleanup(); await target.cleanup() }
    })

    it("hop1: publickey, hop2: password", async () => {
      const gw = await createTestServer({ authMethods: ["publickey"], enableForwarding: true })
      const target = await createTestServer({ authMethods: ["password"] })
      try {
        const conn = new SSHConnection()
        await conn.connect({
          chain: [
            { id: "gw", name: "gateway", host: "127.0.0.1", port: gw.port, auth: { username: "u1", privateKey: userPrivateKey.private } },
            { id: "t1", name: "target", host: "127.0.0.1", port: target.port, auth: { username: "u2", password: "testpass" } },
          ],
          timeout: 10000,
        })
        assert.equal(conn.isConnected(), true)
        await conn.disconnect()
      } finally { await gw.cleanup(); await target.cleanup() }
    })

    it("hop1: publickey, hop2: publickey", async () => {
      const gw = await createTestServer({ authMethods: ["publickey"], enableForwarding: true })
      const target = await createTestServer({ authMethods: ["publickey"] })
      try {
        const conn = new SSHConnection()
        await conn.connect({
          chain: [
            { id: "gw", name: "gateway", host: "127.0.0.1", port: gw.port, auth: { username: "u1", privateKey: userPrivateKey.private } },
            { id: "t1", name: "target", host: "127.0.0.1", port: target.port, auth: { username: "u2", privateKey: userPrivateKey.private } },
          ],
          timeout: 10000,
        })
        assert.equal(conn.isConnected(), true)
        await conn.disconnect()
      } finally { await gw.cleanup(); await target.cleanup() }
    })
  })

  describe("3-hop: mixed auth methods", () => {
    it("pw -> pw -> key", async () => {
      const gw1 = await createTestServer({ authMethods: ["password"], enableForwarding: true })
      const gw2 = await createTestServer({ authMethods: ["password"], enableForwarding: true })
      const target = await createTestServer({ authMethods: ["publickey"] })
      try {
        const conn = new SSHConnection()
        await conn.connect({
          chain: [
            { id: "gw1", name: "gw1", host: "127.0.0.1", port: gw1.port, auth: { username: "u1", password: "testpass" } },
            { id: "gw2", name: "gw2", host: "127.0.0.1", port: gw2.port, auth: { username: "u2", password: "testpass" } },
            { id: "t1", name: "target", host: "127.0.0.1", port: target.port, auth: { username: "u3", privateKey: userPrivateKey.private } },
          ],
          timeout: 15000,
        })
        assert.equal(conn.isConnected(), true)
        await conn.disconnect()
      } finally { await gw1.cleanup(); await gw2.cleanup(); await target.cleanup() }
    })

    it("key -> pw -> pw", async () => {
      const gw1 = await createTestServer({ authMethods: ["publickey"], enableForwarding: true })
      const gw2 = await createTestServer({ authMethods: ["password"], enableForwarding: true })
      const target = await createTestServer({ authMethods: ["password"] })
      try {
        const conn = new SSHConnection()
        await conn.connect({
          chain: [
            { id: "gw1", name: "gw1", host: "127.0.0.1", port: gw1.port, auth: { username: "u1", privateKey: userPrivateKey.private } },
            { id: "gw2", name: "gw2", host: "127.0.0.1", port: gw2.port, auth: { username: "u2", password: "testpass" } },
            { id: "t1", name: "target", host: "127.0.0.1", port: target.port, auth: { username: "u3", password: "testpass" } },
          ],
          timeout: 15000,
        })
        assert.equal(conn.isConnected(), true)
        await conn.disconnect()
      } finally { await gw1.cleanup(); await gw2.cleanup(); await target.cleanup() }
    })
  })

  describe("authentication failures", () => {
    it("wrong password on hop1 fails", async () => {
      const srv = await createTestServer({ authMethods: ["password"] })
      try {
        const conn = new SSHConnection()
        await assert.rejects(
          () => conn.connect({
            chain: [{ id: "t1", name: "test", host: "127.0.0.1", port: srv.port, auth: { username: "testuser", password: "wrong" } }],
            timeout: 5000,
          }),
        )
        assert.equal(conn.isConnected(), false)
      } finally { await srv.cleanup() }
    })

    it("wrong auth method rejects", async () => {
      const srv = await createTestServer({ authMethods: ["publickey"] })
      try {
        const conn = new SSHConnection()
        await assert.rejects(
          () => conn.connect({
            chain: [{ id: "t1", name: "test", host: "127.0.0.1", port: srv.port, auth: { username: "testuser", password: "testpass" } }],
            timeout: 5000,
          }),
        )
        assert.equal(conn.isConnected(), false)
      } finally { await srv.cleanup() }
    })
  })
})
