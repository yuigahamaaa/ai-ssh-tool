import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import ssh2 from "ssh2"
import { SSHConnection } from "../connection.js"
import { remoteExec } from "../remote-shell.js"
import { BackgroundExecManager } from "../background-exec.js"
import { PortForwardManager } from "../port-forwarding.js"
import { createRemoteTools } from "../remote-tools.js"
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
          session.on("pty", (accept: any) => accept())
          session.on("window-change", (accept: any) => { if (accept) accept() })
          session.on("shell", (accept: any) => {
            const stream = accept()
            stream.on("close", () => {})
          })
          session.on("exec", (acceptExec: any) => {
            const stream = acceptExec()
            stream.write("ok\n")
            stream.exit(0)
            stream.close()
          })
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
        hostConfig: { name: "test", host: "127.0.0.1", port: addr.port, auth: { username: "testuser", password: "testpass" } },
        cleanup: () => new Promise<void>((res) => { server.close(() => setTimeout(res, 50)) }),
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
    it("BackgroundExecManager starts and tracks tasks", async () => {
      const manager = new BackgroundExecManager()
      const task = await manager.start(conn.getFinalClient(), "echo bg-mcp")
      assert.ok(task.id)
      assert.equal(task.command, "echo bg-mcp")

      const list = manager.list()
      assert.ok(list.length >= 1)

      const status = manager.getStatus(task.id)
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
