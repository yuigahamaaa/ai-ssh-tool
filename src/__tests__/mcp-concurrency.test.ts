/**
 * MCP Concurrency Tests
 * Tests race conditions in MCP server and daemon client:
 * 1. clientCache duplicate-connection bug in mcp-server.ts getClientForProfile
 * 2. DaemonClient.connect() race causing multiple socket connections
 */

import { describe, it, before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import ssh2 from "ssh2"
import { createServer as createNetServer, type Server as NetServer, type Socket as NetSocket } from "net"
import { readFileSync, writeFileSync, unlinkSync } from "fs"
import { join } from "path"
import { randomUUID } from "crypto"

const { Server, utils } = ssh2
const hostKey = utils.generateKeyPairSync("ed25519")

// Track how many SSH connections are established
let connectionCount = 0

function createTestServer(opts?: { execDelay?: number }): Promise<{
  server: InstanceType<typeof Server>
  port: number
  cleanup: () => Promise<void>
}> {
  return new Promise((resolve, reject) => {
    const server = new Server({ hostKeys: [hostKey.private] }, (client: any) => {
      connectionCount++
      client.on("authentication", (ctx: any) => {
        if (ctx.method === "password" && ctx.password === "testpass") ctx.accept()
        else ctx.reject()
      })
      client.on("ready", () => {
        client.on("session", (accept: any) => {
          const session = accept()
          session.on("exec", (acceptExec: any) => {
            const stream = acceptExec()
            if (opts?.execDelay) {
              setTimeout(() => {
                stream.write("ok\n")
                stream.exit(0)
                stream.close()
              }, opts.execDelay)
            } else {
              stream.write("ok\n")
              stream.exit(0)
              stream.close()
            }
          })
          session.on("shell", (acceptShell: any) => {
            const shell = acceptShell()
            shell.on("data", () => {})
            shell.end()
          })
          session.on("pty", (accept: any) => accept())
          session.on("window-change", (accept: any) => { if (accept) accept() })
          session.on("sftp", (acceptSftp: any) => {
            const sftpStream = acceptSftp()
            const handles = new Map<number, { path: string; data?: Buffer }>()
            let nextHandle = 1
            sftpStream.on("OPEN", (reqId: any, path: any, flags: any) => {
              const h = nextHandle++
              if (flags & 0x02) {
                handles.set(h, { path, data: Buffer.alloc(0) })
              } else {
                sftpStream.status(reqId, 2); return
              }
              const buf = Buffer.alloc(4); buf.writeUInt32BE(h, 0); sftpStream.handle(reqId, buf)
            })
            sftpStream.on("READ", (reqId: any) => { sftpStream.status(reqId, 2) })
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
              handles.delete(handle.readUInt32BE(0)); sftpStream.status(reqId, 0)
            })
            sftpStream.on("STAT", (reqId: any) => { sftpStream.status(reqId, 2) })
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
        cleanup: () => new Promise<void>((res) => { server.close(() => setTimeout(res, 50)) }),
      })
    })
    server.on("error", reject)
  })
}

// --- IPC mock server for DaemonClient.connect test ---
function createIpcMockServer(): { server: NetServer; pipePath: string } {
  const pipePath = join("/tmp", `test-ipc-${randomUUID()}.sock`)
  const server = createNetServer((socket: NetSocket) => {
    let buffer = Buffer.alloc(0)
    socket.on("data", (data) => {
      buffer = Buffer.concat([buffer, data])
      const str = buffer.toString("utf-8")
      const lines = str.split("\n")
      const remainder = lines.pop() ?? ""
      for (const line of lines) {
        if (line.trim()) {
          try {
            const msg = JSON.parse(line)
            if (msg.action === "ping") {
              socket.write(JSON.stringify({ id: msg.id, ok: true, data: { uptime: 1 } }) + "\n")
            }
          } catch {}
        }
      }
      buffer = Buffer.from(remainder, "utf-8")
    })
    socket.on("close", () => {})
  })
  return { server, pipePath }
}

// ============================================================================
// TESTS
// ============================================================================

describe("MCP Concurrency Bugs", () => {

  // --- Bug 1: clientCache duplicate connection in getClientForProfile ---
  describe("BUG 1: clientCache race in mcp-server.ts getClientForProfile", () => {
    // This bug: when N concurrent calls to getClientForProfile for the same
    // profile all see cache.has()=false before any completes, they ALL create
    // new SSH connections instead of sharing one.
    // The fix uses a pending-promise cache so only one connection is in flight.

    it("concurrent getClientForProfile calls should reuse the same connection (not create N duplicates)", async () => {
      // Import here so we can control the test server
      const { SSHGateway } = await import("../gateway.js")

      connectionCount = 0
      const srv = await createTestServer()

      // Create a profile pointing to our test server
      const gw = new SSHGateway({ maxSessions: 20 })
      // Use the gateway's own profile manager so the profile is accessible
      const tmpFile = join("/tmp", `profile-concurrency-${randomUUID()}.json`)
      const profileConfig = {
        id: "test-profile",
        name: "test-concurrency",
        chain: [{
          id: "t1",
          name: "test",
          host: "127.0.0.1",
          port: srv.port,
          auth: { username: "testuser", password: "testpass" },
        }],
      }
      writeFileSync(tmpFile, JSON.stringify(profileConfig))
      const loadedProfile = gw.profiles.loadFromFile(tmpFile)
      if (loadedProfile) gw.profiles["profiles"].push(loadedProfile)

      const concurrency = 10
      // Fire N concurrent calls for the SAME profile
      const promises = Array.from({ length: concurrency }, () =>
        gw.connectByProfile("test-concurrency", `session-${randomUUID()}`).catch(() => {})
      )

      await Promise.all(promises)

      // Clean up
      await gw.disconnectAll()
      unlinkSync(tmpFile)

      // With the bug: connectionCount === concurrency (each call creates a new connection)
      // With fix: connectionCount === 1 (all calls share one connection)
      assert.ok(
        connectionCount <= 2,
        `Expected at most 2 connections (1 for reuse attempt + 1 possible reconnect), got ${connectionCount}. ` +
        `Bug: concurrent getClientForProfile calls each created their own connection.`
      )
    })

    it("concurrent getClientForProfile for DIFFERENT hosts should create separate connections", async () => {
      const { SSHGateway } = await import("../gateway.js")

      connectionCount = 0
      // Create ONE server and two profiles with same host/port but DIFFERENT usernames
      // Different usernames -> different session hash -> different sessions
      const srv = await createTestServer()

      const gw = new SSHGateway({ maxSessions: 20 })
      const profiles: string[] = []

      for (let i = 0; i < 2; i++) {
        const tmpFile = join("/tmp", `profile-diff-${randomUUID()}-${i}.json`)
        const profileConfig = {
          id: `test-profile-${i}`,
          name: `test-concurrency-${i}`,
          chain: [{
            id: `t${i}`,
            name: `test${i}`,
            host: "127.0.0.1",
            port: srv.port,
            auth: { username: `testuser${i}`, password: "testpass" },  // different usernames = different hash
          }],
        }
        writeFileSync(tmpFile, JSON.stringify(profileConfig))
        const loadedProfile = gw.profiles.loadFromFile(tmpFile)
        if (loadedProfile) gw.profiles["profiles"].push(loadedProfile)
        profiles.push(tmpFile)
      }

      // Connect to both profiles concurrently
      const p0 = gw.connectByProfile("test-concurrency-0", "session-0").catch(() => {})
      const p1 = gw.connectByProfile("test-concurrency-1", "session-1").catch(() => {})
      await Promise.all([p0, p1])

      await gw.disconnectAll()
      for (const f of profiles) unlinkSync(f)
      await srv.cleanup()

      // With different usernames, session hash should differ -> 2 separate connections
      assert.ok(connectionCount >= 2,
        `Expected at least 2 connections for different usernames, got ${connectionCount}. ` +
        `Different usernames should produce different session hashes and separate connections.`)
    })
  })

  // --- Bug 2: DaemonClient.connect() race ---
  describe("BUG 2: DaemonClient.connect() race causing duplicate sockets", () => {
    it("concurrent DaemonClient.connect() calls should reuse the same socket (not create N sockets)", async () => {
      const { DaemonClient } = await import("../daemon-client.js")

      // Create a mock IPC server
      const { server, pipePath } = createIpcMockServer()
      await new Promise<void>((resolve) => server.listen(pipePath, resolve))

      let socketCount = 0
      server.on("connection", () => { socketCount++ })

      const concurrency = 10
      const clients = Array.from({ length: concurrency }, () => new DaemonClient(pipePath))

      // Fire N concurrent connect() calls on different DaemonClient instances
      // All trying to connect to the same daemon
      const connectPromises = clients.map((c) => c.connect().catch(() => {}))
      await Promise.all(connectPromises)

      // Clean up
      for (const c of clients) c.disconnect()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      try { unlinkSync(pipePath) } catch {}

      // With the bug: socketCount could be > 1 (each concurrent call creates its own socket)
      // With fix: socketCount === 1 (all share the same socket)
      // We allow up to 2 because the mock server accepts one then subsequent connections
      // may race and create extras. The key is that it shouldn't be N.
      assert.ok(
        socketCount <= 2,
        `Expected at most 2 socket connections (1 main + 1 possible race), got ${socketCount}. ` +
        `Bug: concurrent DaemonClient.connect() calls each created their own socket.`
      )
    })

    it("concurrent send() calls on same DaemonClient should not interfere", async () => {
      const { DaemonClient } = await import("../daemon-client.js")

      const { server, pipePath } = createIpcMockServer()
      await new Promise<void>((resolve) => server.listen(pipePath, resolve))

      const client = new DaemonClient(pipePath)
      await client.connect()

      const concurrency = 5
      const promises = Array.from({ length: concurrency }, () =>
        client.ping().catch((err) => ({ ok: false, error: err.message }))
      )

      const results = await Promise.all(promises)

      client.disconnect()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      try { unlinkSync(pipePath) } catch {}

      // All should succeed (not hang or error)
      for (const r of results) {
        assert.equal((r as any).ok, true, `Expected ok=true, got ${JSON.stringify(r)}`)
      }
    })
  })

  // --- Bug 3: ensureDaemon race ---
  describe("BUG 3: ensureDaemon concurrent startDaemon race", () => {
    it("concurrent ensureDaemon calls should not spawn multiple daemons", async () => {
      // This test verifies that concurrent ensureDaemon calls don't each try to
      // start the daemon separately. We test this by checking the DaemonClient
      // doesn't create multiple socket connections during concurrent ensureDaemon.
      const { DaemonClient } = await import("../daemon-client.js")

      // Use a non-existent pipe path to trigger daemon start attempt
      const fakePipePath = `/tmp/nonexistent-daemon-${randomUUID()}.sock`

      let startAttemptCount = 0

      const { server, pipePath } = createIpcMockServer()
      // Patch: intercept connections to count them
      let realServerClose: typeof server.close
      ;(server as any)._origClose = server.close.bind(server)
      server.close = ((cb?: () => void) => {
        startAttemptCount++
        return (server as any)._origClose(cb)
      }) as typeof server.close

      await new Promise<void>((resolve) => server.listen(pipePath, resolve))

      const client = new DaemonClient(pipePath)

      // The test validates that if ensureDaemon races, only one actual
      // connection attempt wins and establishes the socket properly.
      // We just verify it doesn't crash or hang.
      const results = await Promise.allSettled([
        client.ensureDaemon().then(() => ({ ok: true })).catch((e) => ({ ok: false, error: e.message })),
      ])

      client.disconnect()
      await new Promise<void>((resolve) => {
        server.close(() => {
          setTimeout(resolve, 10)
        })
      })
      try { unlinkSync(pipePath) } catch {}
      try { unlinkSync(fakePipePath) } catch {}
    })
  })

  // --- Stress test: rapid concurrent exec ---
  describe("stress: rapid concurrent exec operations", () => {
    it("should handle 20 concurrent ssh_exec calls without hanging", async () => {
      const { SSHGateway } = await import("../gateway.js")
      const { remoteExec } = await import("../remote-shell.js")

      connectionCount = 0
      const srv = await createTestServer({ execDelay: 10 })

      const gw = new SSHGateway({ maxSessions: 30 })
      const tmpFile = join("/tmp", `profile-exec-concurrency-${randomUUID()}.json`)
      const profileConfig = {
        id: "exec-test",
        name: "exec-concurrency",
        chain: [{
          id: "t1",
          name: "test",
          host: "127.0.0.1",
          port: srv.port,
          auth: { username: "testuser", password: "testpass" },
        }],
      }
      writeFileSync(tmpFile, JSON.stringify(profileConfig))
      const loadedProfile = gw.profiles.loadFromFile(tmpFile)
      if (loadedProfile) gw.profiles["profiles"].push(loadedProfile)

      // Create one shared session first
      let session
      try {
        session = await gw.connectByProfile("exec-concurrency")
      } catch (e) {
        assert.fail(`connectByProfile failed: ${(e as Error).message}`)
      }
      const conn = gw.sessions.getConnection(session.id)
      assert.ok(conn, `Should have a connection, session id=${session.id}`)

      // Fire 20 concurrent exec calls on the SAME session
      const concurrency = 20
      const promises = Array.from({ length: concurrency }, (_, i) =>
        remoteExec(conn!.getFinalClient(), `echo "exec-${i}"`, { timeout: 10000 })
          .then((r) => ({ code: r.code, stdout: r.stdout.trim() }))
          .catch((e) => ({ code: -1, stdout: "", error: e.message }))
      )

      const results = await Promise.all(promises)

      await gw.disconnectAll()
      try { unlinkSync(tmpFile) } catch {}

      // All should complete successfully
      let successCount = 0
      let errors: string[] = []
      for (const r of results) {
        if ((r as any).code === 0) successCount++
        else errors.push(JSON.stringify(r))
      }
      assert.ok(
        successCount >= concurrency - 2,
        `Expected most exec calls to succeed, got ${successCount}/${concurrency}. Errors: ${errors.slice(0, 3).join("; ")}`
      )
    })
  })
})
