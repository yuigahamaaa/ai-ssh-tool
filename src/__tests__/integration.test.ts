/**
 * Integration tests - uses real ssh2 Server instances for end-to-end testing
 */

import { describe, it, before, after } from "node:test"
import assert from "node:assert"
import { createConnection } from "net"
import ssh2 from "ssh2"

// Suppress ECONNRESET during test cleanup (TCP forwarding sockets)
process.on("uncaughtException", (err: any) => {
  if (err?.code === "ECONNRESET" || err?.code === "ERR_STREAM_PREMATURE_CLOSE") return
  throw err
})

const { Server, utils } = ssh2
import { SSHConnection } from "../connection.js"
import { SSHSessionManager } from "../session-manager.js"
import { SSHGateway } from "../gateway.js"
import { createRemoteTools } from "../remote-tools.js"
import { remoteExec } from "../remote-shell.js"
import type { SecurityPolicy, SSHHostConfig } from "../types.js"

// Generate test keys once
const hostKey = utils.generateKeyPairSync("ed25519")
const userPrivateKey = utils.generateKeyPairSync("ed25519")

// In-memory filesystem for SFTP tests
const memFs = new Map<string, Buffer>()

function createTestServer(opts?: {
  execHandler?: (command: string) => { stdout: string; stderr: string; code: number }
  enableForwarding?: boolean
}): Promise<{
  server: InstanceType<typeof Server>
  port: number
  hostConfig: Omit<SSHHostConfig, "id">
  cleanup: () => Promise<void>
}> {
  return new Promise((resolve, reject) => {
    const server = new Server(
      {
        hostKeys: [hostKey.private],
      },
      (client: any) => {
        client.on("authentication", (ctx: any) => {
          if (ctx.method === "password" && ctx.password === "testpass") {
            ctx.accept()
          } else if (ctx.method === "publickey" && ctx.key.algo === "ssh-ed25519") {
            // Accept any ed25519 key for testing
            ctx.accept()
          } else {
            ctx.reject()
          }
        })

        client.on("ready", () => {
          if (opts?.enableForwarding) {
            client.on("tcpip", (accept: any, reject: any, info: any) => {
              // Tunnel traffic to the actual target
              const sock = createConnection(info.destPort, info.destIP, () => {
                const stream = accept()
                sock.on("data", (d: any) => { try { stream.write(d) } catch {} })
                stream.on("data", (d: any) => { try { sock.write(d) } catch {} })
                sock.on("error", () => { try { stream.close() } catch {} })
                sock.on("close", () => { try { stream.close() } catch {} })
                stream.on("close", () => { try { sock.destroy() } catch {} })
              })
              sock.on("error", () => {
                try { reject() } catch {}
              })
            })
          }

          client.on("session", (accept: any) => {
            const session = accept()

            session.on("pty", (accept: any, reject: any, info: any) => {
              accept()
            })

            session.on("window-change", (accept: any, reject: any, info: any) => {
              if (accept) accept()
            })

            session.on("shell", (accept: any, reject: any) => {
              const stream = accept()
              // Keep shell open until client closes it
              stream.on("close", () => {})
            })

            session.on("exec", (acceptExec: any, rejectExec: any, info: any) => {
              const stream = acceptExec()
              const command = info.command

              const handler = opts?.execHandler ?? defaultExecHandler
              const result = handler(command)

              if (result.stdout) stream.write(result.stdout)
              if (result.stderr) stream.stderr.write(result.stderr)
              stream.exit(result.code)
              stream.close()
            })

            session.on("sftp", (acceptSftp: any) => {
              const sftpStream = acceptSftp()

              // Minimal SFTP server for testing
              const handles = new Map<number, { path: string; data?: Buffer; pos: number }>()
              let nextHandle = 1

              sftpStream.on("OPEN", (reqId: any, path: any, flags: any, attrs: any) => {
                const h = nextHandle++
                if (flags & 0x02) {
                  // WRITE (SSH_FXF_WRITE = 0x02)
                  handles.set(h, { path, data: Buffer.alloc(0), pos: 0 })
                } else {
                  // READ
                  const data = memFs.get(path)
                  if (data) {
                    handles.set(h, { path, data, pos: 0 })
                  } else {
                    sftpStream.status(reqId, 2) // NO_SUCH_FILE
                    return
                  }
                }
                const buf = Buffer.alloc(4)
                buf.writeUInt32BE(h, 0)
                sftpStream.handle(reqId, buf)
              })

              sftpStream.on("READ", (reqId: any, handle: any, offset: any, len: any) => {
                const h = handle.readUInt32BE(0)
                const entry = handles.get(h)
                if (!entry?.data) {
                  sftpStream.status(reqId, 2) // NO_SUCH_FILE
                  return
                }
                if (offset >= entry.data.length) {
                  sftpStream.status(reqId, 1) // EOF
                  return
                }
                const chunk = entry.data.subarray(offset, offset + len)
                sftpStream.data(reqId, chunk)
              })

              sftpStream.on("WRITE", (reqId: any, handle: any, offset: any, data: any) => {
                const h = handle.readUInt32BE(0)
                const entry = handles.get(h)
                if (!entry) {
                  sftpStream.status(reqId, 2) // NO_SUCH_FILE
                  return
                }
                // Grow buffer if needed, then write at offset
                const needed = offset + data.length
                if (!entry.data || entry.data.length < needed) {
                  const grown = Buffer.alloc(needed)
                  if (entry.data) entry.data.copy(grown)
                  entry.data = grown
                }
                data.copy(entry.data, offset)
                sftpStream.status(reqId, 0) // OK
              })

              sftpStream.on("CLOSE", (reqId: any, handle: any) => {
                const h = handle.readUInt32BE(0)
                const entry = handles.get(h)
                if (entry?.data && entry.path) {
                  memFs.set(entry.path, entry.data)
                }
                handles.delete(h)
                sftpStream.status(reqId, 0) // OK
              })

              sftpStream.on("STAT", (reqId: any, path: any) => {
                const data = memFs.get(path)
                if (data) {
                  sftpStream.attrs(reqId, {
                    mode: 0o100644,
                    size: data.length,
                    uid: 0,
                    gid: 0,
                    atime: Math.floor(Date.now() / 1000),
                    mtime: Math.floor(Date.now() / 1000),
                  })
                } else {
                  sftpStream.status(reqId, 2) // NO_SUCH_FILE
                }
              })

              sftpStream.on("REALPATH", (reqId: any, path: any) => {
                sftpStream.name(reqId, [{ filename: path, longname: "", attrs: {} as any }])
              })

              sftpStream.on("OPENDIR", (reqId: any, path: any) => {
                const h = nextHandle++
                handles.set(h, { path, pos: 0 })
                const buf = Buffer.alloc(4)
                buf.writeUInt32BE(h, 0)
                sftpStream.handle(reqId, buf)
              })

              sftpStream.on("READDIR", (reqId: any, handle: any) => {
                const h = handle.readUInt32BE(0)
                const entry = handles.get(h)
                if (!entry) {
                  sftpStream.status(reqId, 2) // NO_SUCH_FILE
                  return
                }
                if (entry.pos > 0) {
                  sftpStream.status(reqId, 1) // EOF
                  return
                }
                entry.pos++
                const entries = Array.from(memFs.keys())
                  .filter(p => p.startsWith(entry.path) && p !== entry.path)
                  .map(p => ({
                    filename: p.split("/").pop() ?? p,
                    longname: `-rw-r--r-- 1 0 0 ${memFs.get(p)?.length ?? 0} Jan 1 00:00 ${p.split("/").pop()}`,
                    attrs: {
                      mode: 0o100644,
                      size: memFs.get(p)?.length ?? 0,
                      uid: 0,
                      gid: 0,
                      atime: Math.floor(Date.now() / 1000),
                      mtime: Math.floor(Date.now() / 1000),
                    },
                  }))
                sftpStream.name(reqId, entries)
              })
            })
          })
        })
      },
    )

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to get server address"))
        return
      }

      resolve({
        server,
        port: addr.port,
        hostConfig: {
          name: "test-server",
          host: "127.0.0.1",
          port: addr.port,
          auth: { username: "testuser", password: "testpass" },
        },
        cleanup: () =>
          new Promise<void>((res) => {
            memFs.clear()
            server.close(() => {
              // Allow pending connections to finish
              setTimeout(res, 50)
            })
          }),
      })
    })

    server.on("error", reject)
  })
}

function defaultExecHandler(command: string): { stdout: string; stderr: string; code: number } {
  // Strip "cd ... && " prefix that remoteExec adds
  const stripped = command.replace(/^cd\s+"[^"]*"\s*&&\s*/, "")
  if (stripped === "echo hello") return { stdout: "hello\n", stderr: "", code: 0 }
  if (stripped === "echo test123") return { stdout: "test123\n", stderr: "", code: 0 }
  if (stripped === "whoami") return { stdout: "testuser\n", stderr: "", code: 0 }
  if (stripped.startsWith("echo ")) {
    const msg = stripped.slice(5)
    return { stdout: msg + "\n", stderr: "", code: 0 }
  }
  if (stripped === "false") return { stdout: "", stderr: "", code: 1 }
  if (stripped === "pwd") return { stdout: "/home/testuser\n", stderr: "", code: 0 }
  if (stripped.startsWith("cat ")) return { stdout: "file-content\n", stderr: "", code: 0 }
  if (stripped === "ls") return { stdout: "file1\nfile2\n", stderr: "", code: 0 }
  // grep and find commands
  if (stripped.startsWith("grep ") || stripped.startsWith("find ")) return { stdout: "match\n", stderr: "", code: 0 }
  return { stdout: "", stderr: `unknown command: ${stripped}\n`, code: 127 }
}

// --- Tests ---

describe("Integration Tests", () => {
  describe("Direct Connection (0-hop)", () => {
    let srv: Awaited<ReturnType<typeof createTestServer>>

    before(async () => {
      srv = await createTestServer()
    })

    after(async () => {
      await srv.cleanup()
    })

    it("connects with password auth", async () => {
      const conn = new SSHConnection()
      await conn.connect({
        chain: [{ id: "t", ...srv.hostConfig }],
        timeout: 5000,
      })
      assert.strictEqual(conn.isConnected(), true)
      await conn.disconnect()
    })

    it("connects with public key auth", async () => {
      const conn = new SSHConnection()
      await conn.connect({
        chain: [
          {
            id: "t",
            name: "test-server",
            host: "127.0.0.1",
            port: srv.port,
            auth: { username: "testuser", privateKey: userPrivateKey.private },
          },
        ],
        timeout: 5000,
      })
      assert.strictEqual(conn.isConnected(), true)
      await conn.disconnect()
    })

    it("executes remote commands", async () => {
      const conn = new SSHConnection()
      await conn.connect({
        chain: [{ id: "t", ...srv.hostConfig }],
        timeout: 5000,
      })

      const client = conn.getFinalClient()
      const result = await remoteExec(client, "echo hello", { timeout: 5000 })
      assert.strictEqual(result.stdout.trim(), "hello")
      assert.strictEqual(result.code, 0)

      await conn.disconnect()
    })

    it("captures exit codes", async () => {
      const conn = new SSHConnection()
      await conn.connect({
        chain: [{ id: "t", ...srv.hostConfig }],
        timeout: 5000,
      })

      const client = conn.getFinalClient()
      const result = await remoteExec(client, "false", { timeout: 5000 })
      assert.strictEqual(result.code, 1)

      await conn.disconnect()
    })
  })

  describe("SFTP File Operations", () => {
    let srv: Awaited<ReturnType<typeof createTestServer>>

    before(async () => {
      srv = await createTestServer()
    })

    after(async () => {
      await srv.cleanup()
    })

    it("writes and reads a file", async () => {
      const conn = new SSHConnection()
      await conn.connect({
        chain: [{ id: "t", ...srv.hostConfig }],
        timeout: 5000,
      })

      const client = conn.getFinalClient()
      const sftp = await new Promise<import("ssh2").SFTPWrapper>((resolve, reject) => {
        client.sftp((err, s) => {
          if (err) reject(err)
          else resolve(s)
        })
      })

      // Write
      const writeData = Buffer.from("hello integration test")
      await new Promise<void>((resolve, reject) => {
        const ws = sftp.createWriteStream("/tmp/test.txt")
        ws.on("error", reject)
        ws.on("close", resolve)
        ws.end(writeData)
      })

      // Read
      const readData = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = []
        const rs = sftp.createReadStream("/tmp/test.txt")
        rs.on("error", reject)
        rs.on("data", (chunk: Buffer) => chunks.push(chunk))
        rs.on("end", () => resolve(Buffer.concat(chunks)))
      })

      assert.strictEqual(readData.toString(), "hello integration test")

      sftp.end()
      await conn.disconnect()
    })
  })

  describe("2-hop Connection Chain", () => {
    let gw: Awaited<ReturnType<typeof createTestServer>>
    let target: Awaited<ReturnType<typeof createTestServer>>

    before(async () => {
      gw = await createTestServer({ enableForwarding: true })
      target = await createTestServer()
    })

    after(async () => {
      // Small delay to let TCP forwarding sockets close gracefully
      await new Promise((r) => setTimeout(r, 100))
      await gw.cleanup()
      await target.cleanup()
    })

    it("connects through a jump host", async () => {
      const conn = new SSHConnection()
      await conn.connect({
        chain: [
          { id: "gw", ...gw.hostConfig },
          { id: "target", ...target.hostConfig },
        ],
        timeout: 10000,
      })

      assert.strictEqual(conn.isConnected(), true)

      // Verify we can exec on the target through the chain
      const client = conn.getFinalClient()
      const result = await remoteExec(client, "echo hello", { timeout: 5000 })
      assert.strictEqual(result.stdout.trim(), "hello")

      await conn.disconnect()
    })
  })

  describe("SessionManager", () => {
    let srv: Awaited<ReturnType<typeof createTestServer>>

    before(async () => {
      srv = await createTestServer()
    })

    after(async () => {
      await srv.cleanup()
    })

    it("manages sessions with connect/list/disconnect", async () => {
      const manager = new SSHSessionManager({ maxSessions: 10 })

      const session = await manager.connect({
        chain: [{ id: "t", ...srv.hostConfig }],
        name: "test-session",
        timeout: 5000,
      })

      assert.strictEqual(session.status, "connected")
      assert.strictEqual(manager.listSessions().length, 1)

      await manager.disconnect(session.id)
      assert.strictEqual(manager.listSessions().length, 0)
    })
  })

  describe("Gateway + RemoteTools", () => {
    let srv: Awaited<ReturnType<typeof createTestServer>>

    before(async () => {
      srv = await createTestServer()
    })

    after(async () => {
      await srv.cleanup()
    })

    it("connects via gateway and uses remote tools", async () => {
      const gateway = new SSHGateway({ connectionTimeout: 5000 })

      const session = await gateway.connectSimple({
        host: "127.0.0.1",
        port: srv.port,
        username: "testuser",
        password: "testpass",
        jumpHosts: [],
      })

      assert.strictEqual(session.status, "connected")

      const tools = await gateway.getRemoteTools(session.id)
      const result = await tools.exec.execute({ command: "echo hello" })
      assert.strictEqual(result.stdout.trim(), "hello")

      await gateway.disconnectAll()
    })
  })

  describe("Security Policy", () => {
    let srv: Awaited<ReturnType<typeof createTestServer>>

    before(async () => {
      srv = await createTestServer()
    })

    after(async () => {
      await srv.cleanup()
    })

    it("blocks write operations in readOnly mode", async () => {
      const conn = new SSHConnection()
      await conn.connect({
        chain: [{ id: "t", ...srv.hostConfig }],
        timeout: 5000,
      })

      const client = conn.getFinalClient()

      // Create a test file first (without security policy)
      const setupTools = await createRemoteTools({ sessionId: "setup", client, cwd: "/tmp" })
      await setupTools.writeFile.execute({ path: "/tmp/readonly-test.txt", content: "test data" })
      setupTools.dispose()

      const tools = await createRemoteTools(
        { sessionId: "test", client, cwd: "/tmp" },
        { readOnly: true },
      )

      // readFile should work
      await assert.doesNotReject(() => tools.readFile.execute({ path: "/tmp/readonly-test.txt" }))

      // writeFile should be blocked
      await assert.rejects(
        () => tools.writeFile.execute({ path: "/tmp/test.txt", content: "blocked" }),
        { message: /read-only mode/ },
      )

      tools.dispose()
      await conn.disconnect()
    })

    it("blocks blacklisted commands", async () => {
      const conn = new SSHConnection()
      await conn.connect({
        chain: [{ id: "t", ...srv.hostConfig }],
        timeout: 5000,
      })

      const client = conn.getFinalClient()
      const tools = await createRemoteTools(
        { sessionId: "test", client, cwd: "/tmp" },
        { commandBlacklist: ["rm", "dd"] },
      )

      // echo should work
      const result = await tools.exec.execute({ command: "echo hello" })
      assert.strictEqual(result.stdout.trim(), "hello")

      // rm should be blocked
      await assert.rejects(
        () => tools.exec.execute({ command: "rm -rf /" }),
        { message: /blacklisted/ },
      )

      // dd should be blocked
      await assert.rejects(
        () => tools.exec.execute({ command: "dd if=/dev/zero of=/dev/sda" }),
        { message: /blacklisted/ },
      )

      tools.dispose()
      await conn.disconnect()
    })

    it("only allows whitelisted commands", async () => {
      const conn = new SSHConnection()
      await conn.connect({
        chain: [{ id: "t", ...srv.hostConfig }],
        timeout: 5000,
      })

      const client = conn.getFinalClient()
      const tools = await createRemoteTools(
        { sessionId: "test", client, cwd: "/tmp" },
        { commandWhitelist: ["echo", "ls"] },
      )

      // echo should work
      const result = await tools.exec.execute({ command: "echo hello" })
      assert.strictEqual(result.stdout.trim(), "hello")

      // cat should be blocked
      await assert.rejects(
        () => tools.exec.execute({ command: "cat /etc/passwd" }),
        { message: /not in whitelist/ },
      )

      tools.dispose()
      await conn.disconnect()
    })

    it("enforces max command length", async () => {
      const conn = new SSHConnection()
      await conn.connect({
        chain: [{ id: "t", ...srv.hostConfig }],
        timeout: 5000,
      })

      const client = conn.getFinalClient()
      const tools = await createRemoteTools(
        { sessionId: "test", client, cwd: "/tmp" },
        { maxCommandLength: 10 },
      )

      // Short command should work
      await assert.doesNotReject(() => tools.exec.execute({ command: "echo hi" }))

      // Long command should be blocked
      await assert.rejects(
        () => tools.exec.execute({ command: "echo " + "x".repeat(100) }),
        { message: /maximum length/ },
      )

      tools.dispose()
      await conn.disconnect()
    })

    it("blocks write to specific paths", async () => {
      const conn = new SSHConnection()
      await conn.connect({
        chain: [{ id: "t", ...srv.hostConfig }],
        timeout: 5000,
      })

      const client = conn.getFinalClient()
      const tools = await createRemoteTools(
        { sessionId: "test", client, cwd: "/tmp" },
        { blockedPaths: ["/etc/*", "/boot/*"] },
      )

      // Writing to /tmp should work
      await assert.doesNotReject(() =>
        tools.writeFile.execute({ path: "/tmp/ok.txt", content: "test" }),
      )

      // Writing to /etc should be blocked
      await assert.rejects(
        () => tools.writeFile.execute({ path: "/etc/passwd", content: "blocked" }),
        { message: /blocked by security policy/ },
      )

      tools.dispose()
      await conn.disconnect()
    })
  })
})
