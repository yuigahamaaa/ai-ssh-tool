/**
 * Multi-hop File Transfer Tests
 *
 * Architecture Analysis:
 * Multi-hop file transfer works through this chain:
 *   daemon.handleTransfer(sessionId)
 *     → gateway.sessions.getConnection(sessionId)
 *       → SSHConnection (connected via tunnel chain)
 *         → getFinalClient() → final-hop ssh2 Client
 *           → client.sftp() → SFTP channel (works over tunnel)
 *
 * The critical path for multi-hop file transfer:
 * 1. SSHConnection.connect() establishes a tunnel chain via forwardOut (direct-tcpip)
 * 2. getFinalClient() returns the final-hop client connected through the tunnel
 * 3. client.sftp() opens SFTP channel on the tunneled connection
 * 4. remoteExec() (used by checkOverwrite, folder compression) also works over the tunnel
 *
 * Limitation: ssh2's mock Server does NOT support direct-tcpip channel forwarding,
 * which is required for hop>0 connections. This means we cannot test the full
 * multi-hop file transfer with mock servers. Real SSH servers (sshd) are required
 * for end-to-end multi-hop testing.
 *
 * What we CAN test with mocks:
 * - Single-hop SFTP file transfer (uploadFile, downloadFile)
 * - The connection chain building logic (SSHConnectionChain)
 * - Remote exec through single-hop connection
 */

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { writeFileSync, unlinkSync, existsSync, mkdirSync, readFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import ssh2 from "ssh2"
import { SSHConnection } from "../connection.js"
import { uploadFile, downloadFile } from "../file-transfer.js"
import { remoteExec } from "../remote-shell.js"
import type { SSHHostConfig } from "../types.js"

// Suppress ECONNRESET fired by ssh2's mock Server during teardown — the
// Node test runner reports any post-test async error as a failure even
// though the test itself has already passed. integration.test.ts uses
// the same guard (search for ECONNRESET there) for the same reason.
process.on("uncaughtException", (err: any) => {
  if (err?.code === "ECONNRESET" || err?.code === "ERR_STREAM_PREMATURE_CLOSE") return
  throw err
})

import { createStableEd25519KeyPair } from "./ssh-test-key.js"

const { Server } = ssh2
const hostKey = createStableEd25519KeyPair()
const memFs = new Map<string, Buffer>()

function createTestServer(
  username: string,
  password: string,
): Promise<{
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
        if (ctx.method === "password" && ctx.password === password) ctx.accept()
        else ctx.reject()
      })
      client.on("ready", () => {
        client.on("session", (accept: any) => {
          const session = accept()
          session.on("pty", (accept: any) => accept())
          session.on("shell", (accept: any) => {
            const stream = accept()
            stream.write("welcome\n")
            stream.on("close", () => {})
          })
          session.on("exec", (acceptExec: any) => {
            const stream = acceptExec()
            stream.write("exec ok\n")
            stream.exit(0)
            stream.close()
          })
          // SFTP subsystem - full implementation for file transfer testing
          session.on("sftp", (acceptSftp: any) => {
            const sftpStream = acceptSftp()
            const handles = new Map<number, { path: string; data?: Buffer }>()
            let nextHandle = 1
            sftpStream.on("OPEN", (reqId: any, path: any, flags: any) => {
              const h = nextHandle++
              if (flags & 0x02) {
                handles.set(h, { path, data: Buffer.alloc(0) })
              } else {
                const data = memFs.get(path)
                if (data) handles.set(h, { path, data })
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
        hostConfig: {
          name: "test",
          host: "127.0.0.1",
          port: addr.port,
          auth: { username, password },
        },
        cleanup: () => new Promise<void>((res) => {
          memFs.clear()
          for (const client of clients) {
            // end() is graceful but ssh2's mock Server closes its underlying
            // socket asynchronously, which lets a stray RST race past the
            // outer `after` hook. Forcing the underlying socket closed here
            // makes the teardown synchronous from the kernel's POV.
            try { client.end() } catch {}
            try { (client as any)._sock?.destroy?.() } catch {}
          }
          server.close(() => {
            // Give the kernel enough time to drain any RST that the mock
            // ssh2 server emits as its SFTP/session sockets tear down.
            // 50ms (used by integration.test.ts) is enough when only the
            // shell session is open, but SFTP keeps a richer per-connection
            // state machine, so we wait a bit longer to keep the
            // asynchronous error inside this `after` hook.
            setTimeout(res, 200)
          })
        }),
      })
    })
    server.on("error", reject)
  })
}

describe("Multi-hop File Transfer Tests", () => {
  let srv: Awaited<ReturnType<typeof createTestServer>>
  let conn: SSHConnection
  let tmpDir: string

  before(async () => {
    srv = await createTestServer("testuser", "testpass")
    conn = new SSHConnection()
    await conn.connect({
      chain: [{ id: "t1", ...srv.hostConfig }],
      timeout: 5000,
    })
    memFs.clear()
    tmpDir = join(tmpdir(), "ssh-tool-multi-hop-test")
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true })
  })

  after(async () => {
    await conn.disconnect()
    await srv.cleanup()
    try { unlinkSync(join(tmpDir, "test-multi-hop.txt")) } catch {}
  })

  describe("Single-hop SFTP file transfer (validates multi-hop building blocks)", () => {
    it("should upload a small text file", async () => {
      const localPath = join(tmpDir, "test-multi-hop.txt")
      const content = "Hello from multi-hop test"
      writeFileSync(localPath, content)
      memFs.clear()

      const result = await uploadFile(conn.getFinalClient(), localPath, "/remote/test.txt")

      assert.equal(result.success, true, `Upload failed: ${result.error}`)
      assert.equal(result.size, content.length)
      assert.ok(memFs.has("/remote/test.txt"), "File should be in mock FS")
      assert.equal(memFs.get("/remote/test.txt")?.toString(), content)
    })

    it("should upload a binary file", async () => {
      const localPath = join(tmpDir, "binary.bin")
      const data = Buffer.from([0xDE, 0xAD, 0xBE, 0xEF])
      writeFileSync(localPath, data)
      memFs.clear()

      const result = await uploadFile(conn.getFinalClient(), localPath, "/remote/binary.bin")

      assert.equal(result.success, true, `Binary upload failed: ${result.error}`)
      assert.ok(memFs.has("/remote/binary.bin"))
      assert.deepEqual(memFs.get("/remote/binary.bin"), data)
    })

    it("should download a file from remote", async () => {
      const localPath = join(tmpDir, "downloaded.txt")
      memFs.set("/remote/source.txt", Buffer.from("downloaded content"))
      memFs.set("/remote/source.txt", Buffer.from("downloaded content")) // ensure it's set

      const result = await downloadFile(conn.getFinalClient(), "/remote/source.txt", localPath)

      assert.equal(result.success, true, `Download failed: ${result.error}`)
      assert.ok(existsSync(localPath), "Local file should exist")
      assert.equal(readFileSync(localPath, "utf-8"), "downloaded content", "Content should match")
    })

    it("should overwrite existing file", async () => {
      const localPath = join(tmpDir, "overwrite.txt")
      writeFileSync(localPath, "new content")
      memFs.set("/remote/overwrite.txt", Buffer.from("old content"))

      const result = await uploadFile(conn.getFinalClient(), localPath, "/remote/overwrite.txt", {
        overwrite: true,
      })

      assert.equal(result.success, true)
      assert.equal(memFs.get("/remote/overwrite.txt")?.toString(), "new content")
    })
  })

  describe("Remote exec through connection (used by folder transfer + overwrite checks)", () => {
    it("should execute commands and return stdout/stderr", async () => {
      const result = await remoteExec(conn.getFinalClient(), "echo hello exec", { timeout: 5000 })
      assert.equal(result.code, 0)
      assert.ok(result.stdout.includes("hello exec") || result.stdout.trim() !== "", "Should have output")
    })

    it("should support remote exec and return output (used by folder transfer)", async () => {
      const result = await remoteExec(conn.getFinalClient(), "echo EXISTS", { timeout: 5000 })
      // The mock exec just returns "exec ok", but we verify the exec mechanism works
      assert.equal(result.code, 0, "Remote exec should succeed")
      assert.ok(typeof result.stdout === "string", "Should have stdout")
    })
  })

  describe("Multi-hop architecture verification", () => {
    it("SSHConnection supports multi-hop chains (code analysis)", () => {
      // Verify SSHConnection.connectThrough uses forwardOut for hop>0
      // This is the mechanism that enables multi-hop file transfer
      const connectThrough = (SSHConnection.prototype as any).connectThrough
      assert.ok(connectThrough, "connectThrough method should exist")
      // The method should use forwardOut on the previous hop's client
      const source = connectThrough.toString()
      assert.ok(source.includes("forwardOut"), "connectThrough should use forwardOut for tunneling")
    })

    it("getFinalClient returns the last hop's SSH client", () => {
      const client = conn.getFinalClient()
      assert.ok(client, "getFinalClient should return a client")
      // The final client is the one at the end of the hop chain
      const hops = (conn as any).hops
      const lastHop = hops[hops.length - 1]
      assert.equal(lastHop.client, client, "getFinalClient should return the final hop's client")
    })

    it("handleTransfer uses getFinalClient for multi-hop support", async () => {
      // Verify daemon.handleTransfer uses getFinalClient
      // This means transfers work through any number of hops
      const { readFileSync } = await import("fs")
      const daemonSrc = readFileSync(
        join(process.cwd(), "dist", "daemon.js"),
        "utf-8"
      )
      assert.ok(
        daemonSrc.includes("getFinalClient()"),
        "daemon.handleTransfer should use getFinalClient() for multi-hop support"
      )
    })

    it("uploadFile uses client.sftp() which works over tunneled connections", async () => {
      // SFTP over SSH works through any SSH channel, including tunneled ones
      const { readFileSync } = await import("fs")
      const fileTransferSrc = readFileSync(
        join(process.cwd(), "dist", "file-transfer.js"),
        "utf-8"
      )
      assert.ok(
        fileTransferSrc.includes("client.sftp("),
        "uploadFile should use client.sftp()"
      )
      assert.ok(
        fileTransferSrc.includes("remoteExec("),
        "uploadFile should use remoteExec for path checks (also works over tunnel)"
      )
    })
  })

  describe("Limitation note for multi-hop testing", () => {
    it("should document that full multi-hop test requires real sshd", async () => {
      // ssh2's mock Server does not support direct-tcpip forwarding (forwardOut).
      // The gateway (hop 0) would need to handle 'tcpip' channel open requests
      // and bridge connections to the next hop - this is not implemented in mock servers.
      //
      // In production, real SSH servers (sshd) handle this transparently.
      // The architecture is correct: forwardOut tunnel → getFinalClient → client.sftp()
      //
      // To test with real servers, you would need:
      // 1. A real SSH server acting as the gateway (with GatewayPorts enabled)
      // 2. Another real SSH server as the target
      // 3. Or use SSH's ProxyJump (-J) which is handled natively by ssh2

      // For now, we verify the building blocks work:
      assert.ok(conn.isConnected(), "Single-hop connection should work")
      const client = conn.getFinalClient()
      assert.ok(client, "getFinalClient should work")

      // SFTP should work on the single-hop connection
      await new Promise<void>((resolve, reject) => {
        client.sftp((err: Error | undefined, sftp) => {
          if (err) { reject(new Error(`SFTP failed: ${err.message}`)); return }
          sftp.stat("/remote/test.txt", () => {
            sftp.end()
            resolve()
          })
        })
      })
    })
  })
})
