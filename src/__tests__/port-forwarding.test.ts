import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { createConnection, createServer, type Server as NetServer } from "net"
import ssh2 from "ssh2"
import { SSHConnection } from "../connection.js"
import { PortForwardManager } from "../port-forwarding.js"
import type { SSHHostConfig } from "../types.js"

import { createStableEd25519KeyPair } from "./ssh-test-key.js"

const { Server } = ssh2
const hostKey = createStableEd25519KeyPair()

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address()
      const port = typeof addr === "object" && addr ? addr.port : 0
      probe.close(() => resolve(port))
    })
  })
}

function createTestServer(opts?: { enableForwarding?: boolean; enableRemoteForwarding?: boolean }): Promise<{
  server: InstanceType<typeof Server>
  port: number
  hostConfig: Omit<SSHHostConfig, "id">
  cleanup: () => Promise<void>
}> {
  return new Promise((resolve, reject) => {
    // net.Server instances created for remote-forward (tcpip-forward)
    // requests, tracked so cleanup can release the bound ports.
    const remoteServers = new Map<string, NetServer>()
    const server = new Server({ hostKeys: [hostKey.private] }, (client: any) => {
      client.on("authentication", (ctx: any) => {
        if (ctx.method === "password" && ctx.password === "testpass") ctx.accept()
        else ctx.reject()
      })
      client.on("ready", () => {
        if (opts?.enableForwarding) {
          client.on("tcpip", (accept: any, rejectConn: any) => { try { rejectConn?.() } catch {} })
        }
        if (opts?.enableRemoteForwarding) {
          // Emulate a real sshd for `ssh -R`: bind the requested address
          // and tunnel incoming connections back through the SSH channel.
          client.on("request", (accept: any, rejectReq: any, name: string, data: any) => {
            if (name === "tcpip-forward") {
              const key = `${data.bindAddr}:${data.bindPort}`
              const listener = createServer((sock: any) => {
                // boundAddr/boundPort must be the address the remote client
                // connected to on the SSH server (our forwardIn bind) — the
                // client routes on `${destIP}:${destPort}`.
                client.forwardOut(
                  data.bindAddr,
                  data.bindPort,
                  sock.remoteAddress ?? "127.0.0.1",
                  sock.remotePort ?? 0,
                  (err: Error | undefined, stream: any) => {
                    if (err) {
                      try { sock.destroy() } catch {}
                      return
                    }
                    stream.on("error", () => {})
                    sock.on("error", () => {})
                    sock.pipe(stream).pipe(sock)
                  },
                )
              })
              listener.on("error", () => { try { rejectReq?.() } catch {} })
              listener.listen(data.bindPort, data.bindAddr, () => { try { accept?.() } catch {} })
              remoteServers.set(key, listener)
              return
            }
            if (name === "cancel-tcpip-forward") {
              const key = `${data.bindAddr}:${data.bindPort}`
              const listener = remoteServers.get(key)
              if (listener) {
                try { listener.close() } catch {}
                remoteServers.delete(key)
              }
              try { accept?.() } catch {}
            }
          })
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
        cleanup: () => new Promise<void>((res) => {
          for (const listener of remoteServers.values()) {
            try { listener.close() } catch {}
          }
          remoteServers.clear()
          server.close(() => setTimeout(res, 50))
        }),
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

  describe("idempotent stop and drain", () => {
    it("coalesces concurrent stop calls into one close", async () => {
      const manager = new PortForwardManager(conn.getFinalClient())
      const fwd = await manager.localForward("127.0.0.1", 0, "127.0.0.1", 22)
      // Instrument the underlying server so we can assert close() runs once.
      const entry = (manager as any).forwards.get(fwd.id)
      const server = entry.server
      const origClose = server.close.bind(server)
      let closeCalls = 0
      server.close = (...args: unknown[]) => {
        closeCalls++
        return origClose(...args)
      }
      const results = await Promise.all([manager.stop(fwd.id), manager.stop(fwd.id)])
      assert.deepEqual(results, [true, true])
      assert.equal(closeCalls, 1, "the underlying server should be closed exactly once")
      assert.equal(manager.get(fwd.id), null)
      // Second stop of a removed forward is a no-op returning false.
      assert.equal(await manager.stop(fwd.id), false)
    })

    it("drains active connections when the SSH client disconnects", async () => {
      const manager = new PortForwardManager(conn.getFinalClient())
      await manager.localForward("127.0.0.1", 0, "127.0.0.1", 22)
      let destroyed = 0
      const fakeConn = { destroy: () => { destroyed++ } }
      // Seed an in-flight connection the same way a live socket would be
      // registered, then lose the client and expect the drain to destroy it.
      ;(manager as any).activeConnections.add(fakeConn)
      ;(manager as any).handleClientDisconnect()
      assert.equal(destroyed, 1)
      assert.equal((manager as any).activeConnections.size, 0)
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

describe("Port Forwarding - Remote Forward (end-to-end)", () => {
  let srv: Awaited<ReturnType<typeof createTestServer>>
  let conn: SSHConnection
  let echoServer: NetServer
  let echoPort: number

  before(async () => {
    srv = await createTestServer({ enableRemoteForwarding: true })
    conn = new SSHConnection()
    await conn.connect({ chain: [{ id: "t1", ...srv.hostConfig }], timeout: 5000 })

    // Local echo target that the remote forward must reach through SSH.
    echoPort = await getFreePort()
    echoServer = createServer((socket) => {
      socket.on("error", () => {})
      socket.on("data", (d) => { try { socket.write(d) } catch {} })
    })
    await new Promise<void>((resolve, reject) => {
      echoServer.once("error", reject)
      echoServer.listen(echoPort, "127.0.0.1", () => resolve())
    })
  })

  after(async () => {
    if (echoServer) {
      await new Promise<void>((res) => { try { echoServer.close(() => res()) } catch { res() } })
    }
    await conn.disconnect()
    await srv.cleanup()
  })

  it("forwards real data through the remote tunnel (P1-1)", async () => {
    const manager = new PortForwardManager(conn.getFinalClient())
    const remoteBindPort = await getFreePort()
    const fwd = await manager.remoteForward("127.0.0.1", remoteBindPort, "127.0.0.1", echoPort)
    assert.equal(fwd.type, "remote")
    assert.equal(fwd.status, "active")

    // Connect to the port the (mock) sshd bound for us. Traffic must flow
    // client -> SSH server -> agent -> echo target and back.
    const payload = "ping-remote-forward"
    const echoed = await new Promise<string>((resolve, reject) => {
      const sock = createConnection(remoteBindPort, "127.0.0.1", () => {
        sock.write(payload)
      })
      const chunks: Buffer[] = []
      const timer = setTimeout(() => {
        sock.destroy()
        reject(new Error("timed out waiting for remote-forward echo"))
      }, 10000)
      sock.on("error", (e) => { clearTimeout(timer); reject(e) })
      sock.on("data", (d) => {
        chunks.push(d)
        const data = Buffer.concat(chunks).toString()
        if (data.length >= payload.length) {
          clearTimeout(timer)
          resolve(data)
          sock.end()
        }
      })
    })

    assert.equal(echoed, payload)
    await manager.stopAll()
  })

  it("rejects connections after the remote forward is stopped", async () => {
    const manager = new PortForwardManager(conn.getFinalClient())
    const remoteBindPort = await getFreePort()
    const fwd = await manager.remoteForward("127.0.0.1", remoteBindPort, "127.0.0.1", echoPort)
    assert.equal(await manager.stop(fwd.id), true)
    assert.equal(manager.get(fwd.id), null)

    // The mock sshd has closed its listener, so a fresh connection attempt
    // must fail (ECONNREFUSED) rather than silently hang.
    await assert.rejects(
      new Promise<void>((resolve, reject) => {
        const sock = createConnection(remoteBindPort, "127.0.0.1")
        sock.once("error", reject)
        sock.once("connect", () => { sock.destroy(); reject(new Error("expected connection to be refused")) })
        setTimeout(() => { try { sock.destroy() } catch {}; reject(new Error("connection did not fail fast")) }, 5000)
      }),
    )
  })
})
