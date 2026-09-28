import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import ssh2 from "ssh2"
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { Writable } from "stream"
import { SSHConnection } from "../connection.js"
import { remoteExec } from "../remote-shell.js"
import { getGlobalTaskManager } from "../exec-task-manager.js"
import { PortForwardManager } from "../port-forwarding.js"
import { createRemoteTools } from "../remote-tools.js"
import type { SSHHostConfig } from "../types.js"

import { createStableEd25519KeyPair } from "./ssh-test-key.js"
import { buildCwdGuidance, assertLocalPathSafeForTransfer, writeRemoteFileViaSftp, buildExistsCommand, buildHostLoadCommands } from "../mcp-server.js"
import { clearDialectCache, putCachedDialect } from "../remote-dialect/cache.js"

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
            const rawCommand = String(info?.command ?? "")
            const wrapped = rawCommand.match(/^echo\s+"SSH_TOOL_PID:\$\$"\s+>&2;\s+exec\s+sh\s+-c\s+'([\s\S]*)'$/)
            const command = (wrapped ? wrapped[1].replace(/'\\''/g, "'") : rawCommand.replace(/^echo\s+"SSH_TOOL_PID:\$\$"\s+>&2;\s+exec\s+/, ""))
            if (command.startsWith("echo ")) {
              stream.write(`${command.slice(5)}\n`)
            } else if (command.includes("size_bytes=") && command.includes("total_lines=")) {
              stream.write("size_bytes=9\ntotal_lines=1\nbinary_detected=false\nencoding=utf-8\n")
            } else if (command.includes("sed -n") || command.includes("head -c")) {
              stream.write("hello mcp\n")
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
      assert.equal(typeof result, "object")
      tools.dispose()
    })

    it("listDir lists directory", async () => {
      const tools = await createRemoteTools({ sessionId: "mcp", client: conn.getFinalClient(), cwd: "/tmp" })
      const result = await tools.listDir.execute({ path: "/tmp" })
      assert.equal(typeof result, "object")
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
      assert.equal(typeof result, "object")
      tools.dispose()
    })

    it("find finds files", async () => {
      const tools = await createRemoteTools({ sessionId: "mcp", client: conn.getFinalClient(), cwd: "/tmp" })
      const result = await tools.find.execute({ path: "/tmp" })
      assert.equal(typeof result, "object")
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

  describe("ssh_get_cwd guidance", () => {
    it("appends guidance when no virtual cwd is set", () => {
      const guidance = buildCwdGuidance(null)
      assert.equal(guidance.length, 1)
      assert.match(guidance[0], /ssh_cd/)
    })

    it("returns no guidance when a virtual cwd exists", () => {
      const guidance = buildCwdGuidance("/workspace/project")
      assert.deepEqual(guidance, [])
    })
  })

  describe("assertLocalPathSafeForTransfer", () => {
    let symlinkDir: string
    before(() => { symlinkDir = mkdtempSync(join(tmpdir(), "mcp-symlink-")) })
    after(() => { try { rmSync(symlinkDir, { recursive: true, force: true }) } catch {} })

    it("allows a regular file path", () => {
      const file = join(symlinkDir, "real.txt")
      writeFileSync(file, "x")
      assert.doesNotThrow(() => assertLocalPathSafeForTransfer(file, "upload"))
    })

    it("allows a missing destination path", () => {
      assert.doesNotThrow(() => assertLocalPathSafeForTransfer(join(symlinkDir, "new.txt"), "download"))
    })

    it("rejects a symbolic link root", () => {
      const target = join(symlinkDir, "secret.txt")
      const link = join(symlinkDir, "link.txt")
      writeFileSync(target, "secret")
      symlinkSync(target, link)
      assert.throws(() => assertLocalPathSafeForTransfer(link, "upload"), /symbolic link/)
    })
  })

  describe("ssh_write_file via SFTP", () => {
    it("mkdirs parents and writes via sftp without a base64 echo pipeline", async () => {
      const mkdirs: string[] = []
      const writes: Array<{ path: string; data: string }> = []
      const sftp: any = {
        mkdir: (p: string, cb: any) => { mkdirs.push(String(p)); cb(null) },
        stat: (_p: string, cb: any) => cb(new Error("not found")),
        createWriteStream: (p: string) => {
          const w = new Writable({
            write(chunk, _enc, cb) { writes.push({ path: String(p), data: chunk.toString() }); cb() },
          })
          return w
        },
        end: () => {},
      }
      const client: any = {
        sftp: (cb: any) => cb(null, sftp),
        exec: () => { throw new Error("exec must not be called") },
      }

      await writeRemoteFileViaSftp(client, "/remote/deep/file.txt", "hello", "644")

      assert.ok(mkdirs.includes("/remote/deep"), `expected recursive mkdir, got: ${JSON.stringify(mkdirs)}`)
      assert.equal(writes[0]?.path, "/remote/deep/file.txt")
      assert.equal(writes[0]?.data, "hello")
    })
  })

  describe("dialect-aware mcp commands", () => {
    it("keeps the posix exists command byte-identical without a sessionKey", () => {
      assert.equal(buildExistsCommand("/x"), `test -e '/x' && echo "exists" || echo "not_found"`)
    })

    it("builds a Test-Path exists command for a powershell session", () => {
      putCachedDialect("u@h:22", { kind: "powershell", sub: "powershell", detectedAt: Date.now() })
      try {
        const cmd = buildExistsCommand("/x", "u@h:22")
        assert.ok(cmd.includes("Test-Path"), cmd)
      } finally {
        clearDialectCache()
      }
    })

    it("builds a cmd exists command with double quotes (cmd ignores single quotes)", () => {
      putCachedDialect("u@h:22", { kind: "cmd", sub: "powershell", detectedAt: Date.now() })
      try {
        const cmd = buildExistsCommand("C:/Users/x/a.txt", "u@h:22")
        // cmd 只认双引号：单引号会被当成路径字面量的一部分，永远 not_found（现场 188 实测）
        assert.match(cmd, /^if exist "C:\/Users\/x\/a\.txt" \(echo exists\) else \(echo not_found\)$/, cmd)
      } finally {
        clearDialectCache()
      }
    })

    it("builds portable posix host load commands", () => {
      const c = buildHostLoadCommands()
      assert.ok(c.uptime.includes("/proc/loadavg"), c.uptime)
      assert.ok(c.memory.includes("/proc/meminfo"), c.memory)
      assert.ok(c.proc.includes("ps -e -o comm"), c.proc)
    })

    it("builds powershell host load commands", () => {
      putCachedDialect("u@h:22", { kind: "powershell", sub: "powershell", detectedAt: Date.now() })
      try {
        const c = buildHostLoadCommands("u@h:22")
        assert.ok(c.uptime.includes("Get-CimInstance"), c.uptime)
        assert.ok(c.memory.includes("TotalVisibleMemorySize"), c.memory)
        assert.ok(c.proc.includes("Get-Process"), c.proc)
      } finally {
        clearDialectCache()
      }
    })

    it("builds cmd host load commands via explicit powershell invocation", () => {
      putCachedDialect("u@h:22", { kind: "cmd", sub: "powershell", detectedAt: Date.now() })
      try {
        const c = buildHostLoadCommands("u@h:22")
        // cmd 无原生负载命令：必须显式调 powershell -EncodedCommand，避免
        // cmd /c "..." 内层双引号转义问题（现场 188 即 cmd 默认 shell）
        for (const cmd of [c.uptime, c.memory, c.proc]) {
          assert.match(cmd, /^powershell -NoProfile -EncodedCommand /, cmd)
        }
      } finally {
        clearDialectCache()
      }
    })
  })
})
