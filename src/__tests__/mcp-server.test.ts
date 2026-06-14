import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import ssh2 from "ssh2"
import { SSHConnection } from "../connection.js"
import { remoteExec } from "../remote-shell.js"
import { getGlobalTaskManager } from "../exec-task-manager.js"
import { PortForwardManager } from "../port-forwarding.js"
import { createRemoteTools } from "../remote-tools.js"
import type { SSHHostConfig } from "../types.js"

import { createStableEd25519KeyPair } from "./ssh-test-key.js"

const { Server } = ssh2
const hostKey = createStableEd25519KeyPair()
const memFs = new Map<string, Buffer>()

function createTestServer(): Promise<{
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
      client.on("error", () => {})
      client.on("authentication", (ctx: any) => {
        if (ctx.method === "password" && ctx.password === "testpass") ctx.accept()
        else ctx.reject()
      })
      client.on("ready", () => {
        client.on("session", (accept: any) => {
          const session = accept()
          session.on("pty", (accept: any) => accept())
          session.on("window-change", (accept: any) => { if (accept) accept() })
          session.on("shell", (accept: any) => {
            const stream = accept()
            stream.on("error", () => {})
            stream.on("close", () => {})
          })
          session.on("exec", (acceptExec: any, _rejectExec: any, info: any) => {
            const stream = acceptExec()
            stream.on("error", () => {})
            const command = String(info?.command ?? "").replace(/^echo\s+"SSH_TOOL_PID:\$\$"\s+>&2;\s+exec\s+/, "")
            if (command.startsWith("echo ")) {
              stream.write(`${command.slice(5)}\n`)
            } else if (command.startsWith("grep ")) {
              stream.write("mcp match\n")
            } else if (command.startsWith("find ")) {
              stream.write("/tmp/mcp-test.txt\n")
            } else {
              stream.write("ok\n")
            }
            stream.exit(0)
            stream.close()
          })
          session.on("sftp", (acceptSftp: any) => {
            const sftpStream = acceptSftp()
            sftpStream.on("error", () => {})
            const handles = new Map<number, { path: string; data?: Buffer; readDirDone?: boolean }>()
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
              const entry = handles.get(handle.readUInt32BE(0))
              if (!entry?.data) { sftpStream.status(reqId, 2); return }
              if (offset >= entry.data.length) { sftpStream.status(reqId, 1); return }
              sftpStream.data(reqId, entry.data.subarray(offset, offset + len))
            })
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
              const h = handle.readUInt32BE(0); const entry = handles.get(h)
              if (entry?.data && entry.path) memFs.set(entry.path, entry.data)
              handles.delete(h); sftpStream.status(reqId, 0)
            })
            sftpStream.on("STAT", (reqId: any, path: any) => {
              if (path === "/tmp") { sftpStream.attrs(reqId, { mode: 0o040755, size: 0, uid: 0, gid: 0, atime: 0, mtime: 0 }); return }
              const data = memFs.get(path)
              if (data) sftpStream.attrs(reqId, { mode: 0o100644, size: data.length, uid: 0, gid: 0, atime: 0, mtime: 0 })
              else sftpStream.status(reqId, 2)
            })
            sftpStream.on("OPENDIR", (reqId: any, path: any) => {
              if (path !== "/tmp") { sftpStream.status(reqId, 2); return }
              const h = nextHandle++; handles.set(h, { path }); const buf = Buffer.alloc(4); buf.writeUInt32BE(h, 0); sftpStream.handle(reqId, buf)
            })
            sftpStream.on("READDIR", (reqId: any, handle: any) => {
              const entry = handles.get(handle.readUInt32BE(0))
              if (!entry) { sftpStream.status(reqId, 2); return }
              if (entry.readDirDone) { sftpStream.status(reqId, 1); return }
              entry.readDirDone = true
              const files = Array.from(memFs.keys()).filter(p => p.startsWith("/tmp/")).map(p => ({ filename: p.slice(5), longname: `-rw-r--r-- 1 0 0 ${memFs.get(p)?.length ?? 0} Jan 1 00:00 ${p.slice(5)}`, attrs: { mode: 0o100644, size: memFs.get(p)?.length ?? 0 } }))
              sftpStream.name(reqId, files)
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
        cleanup: () => new Promise<void>((res) => {
          memFs.clear()
          for (const client of clients) {
            try { client.end() } catch {}
            try { (client as any)._sock?.destroy?.() } catch {}
          }
          server.close(() => setTimeout(res, 200))
        }),
      })
    })
    server.on("error", reject)
  })
}

describe("MCP Server Tool Integration", () => {
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

  describe("remote_exec tool", () => {
    it("executes command and returns stdout", async () => {
      const result = await remoteExec(conn.getFinalClient(), "echo mcp-test", { timeout: 5000 })
      assert.ok(result.stdout.includes("mcp-test"))
      assert.equal(result.code, 0)
    })
  })

  describe("remote filesystem tools", () => {
    it("writeFile writes content", async () => {
      const tools = await createRemoteTools({ sessionId: "mcp", client: conn.getFinalClient(), cwd: "/tmp" })
      const result = await tools.writeFile.execute({ path: "/tmp/mcp-test.txt", content: "hello mcp" })
      assert.ok(result.includes("Written"))
      tools.dispose()
    })

    it("readFile reads content", async () => {
      const tools = await createRemoteTools({ sessionId: "mcp", client: conn.getFinalClient(), cwd: "/tmp" })
      const result = await tools.readFile.execute({ path: "/tmp/mcp-test.txt" })
      assert.ok(typeof result === "string")
      tools.dispose()
    })

    it("listDir lists directory", async () => {
      const tools = await createRemoteTools({ sessionId: "mcp", client: conn.getFinalClient(), cwd: "/tmp" })
      const result = await tools.listDir.execute({ path: "/tmp" })
      assert.ok(typeof result === "string")
      tools.dispose()
    })

    it("exists returns boolean", async () => {
      const tools = await createRemoteTools({ sessionId: "mcp", client: conn.getFinalClient(), cwd: "/tmp" })
      const result = await tools.exists.execute({ path: "/tmp" })
      assert.equal(typeof result, "boolean")
      tools.dispose()
    })

    it("stat returns file stats", async () => {
      const tools = await createRemoteTools({ sessionId: "mcp", client: conn.getFinalClient(), cwd: "/tmp" })
      const result = await tools.stat.execute({ path: "/tmp" })
      assert.ok(typeof result === "object")
      tools.dispose()
    })

    it("grep searches files", async () => {
      const tools = await createRemoteTools({ sessionId: "mcp", client: conn.getFinalClient(), cwd: "/tmp" })
      const result = await tools.grep.execute({ pattern: "mcp", path: "/tmp" })
      assert.ok(typeof result === "string")
      tools.dispose()
    })

    it("find finds files", async () => {
      const tools = await createRemoteTools({ sessionId: "mcp", client: conn.getFinalClient(), cwd: "/tmp" })
      const result = await tools.find.execute({ path: "/tmp" })
      assert.ok(typeof result === "string")
      tools.dispose()
    })

    it("cd changes directory", async () => {
      const tools = await createRemoteTools({ sessionId: "mcp", client: conn.getFinalClient(), cwd: "/tmp" })
      const result = await tools.cd.execute({ path: "/tmp" })
      assert.ok(result.includes("Changed directory"))
      tools.dispose()
    })
  })

  describe("background exec tools", () => {
    it("ExecTaskManager starts and tracks tasks", async () => {
      const manager = getGlobalTaskManager()
      const { id } = manager.start(conn.getFinalClient(), "echo bg-mcp")
      const task = manager.getStatus(id)
      assert.ok(task)
      assert.equal(task.command, "echo bg-mcp")

      const list = manager.list()
      assert.ok(list.length >= 1)

      const status = manager.getStatus(id)
      assert.ok(status)
    })
  })

  describe("port forward tools", () => {
    it("PortForwardManager creates and lists forwards", async () => {
      const manager = new PortForwardManager(conn.getFinalClient())
      const fwd = await manager.localForward("127.0.0.1", 0, "127.0.0.1", 22)
      assert.ok(fwd.id)
      assert.equal(fwd.type, "local")

      const list = manager.list()
      assert.ok(list.length >= 1)

      const got = manager.get(fwd.id)
      assert.ok(got)
      assert.equal(got!.id, fwd.id)

      await manager.stopAll()
    })
  })

  describe("tool parameter validation", () => {
    it("all remote tools have name and parameters", async () => {
      const tools = await createRemoteTools({ sessionId: "mcp", client: conn.getFinalClient(), cwd: "/tmp" })
      assert.ok(tools.readFile.name)
      assert.ok(tools.writeFile.name)
      assert.ok(tools.exec.name)
      assert.ok(tools.listDir.name)
      assert.ok(tools.exists.name)
      assert.ok(tools.stat.name)
      assert.ok(tools.grep.name)
      assert.ok(tools.find.name)
      assert.ok(tools.cd.name)

      assert.ok(tools.readFile.parameters)
      assert.ok(tools.writeFile.parameters)
      assert.ok(tools.exec.parameters)

      assert.equal(tools.readFile.parameters.type, "object")
      assert.ok(tools.readFile.parameters.properties.path)
      assert.deepEqual(tools.readFile.parameters.required, ["path"])

      tools.dispose()
    })
  })
})
