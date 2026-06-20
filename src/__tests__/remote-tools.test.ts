/**
 * RemoteTools Unit Tests
 * Tests tool definitions (readFile, writeFile, exec, listDir, exists, stat, grep, find, cd)
 * Uses mock SFTP and mock ssh2 exec.
 *
 * HOME redirect: createRemoteTools imports remote-shell which lazily builds
 * a global ExecTaskManager → SchedulerService that writes under
 * `~/.ssh-tool/...`. We redirect HOME to a tmpdir before first module
 * evaluation so sandboxed environments don't EPERM.
 */

import { describe, it, beforeEach, before, after, mock } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "events"
import { rmSync, mkdirSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { MAX_READ_FILE_BYTES } from "../remote-file-tools.js"

const testHome = join(tmpdir(), `remote-tools-${Date.now()}-${process.pid}`)
const origHome = process.env.HOME
let createRemoteTools: typeof import("../remote-tools.js").createRemoteTools

before(async () => {
  mkdirSync(testHome, { recursive: true })
  process.env.HOME = testHome
  const mod = await import(`../remote-tools.js?t=${Date.now()}`)
  createRemoteTools = mod.createRemoteTools
})

after(() => {
  process.env.HOME = origHome
  try { rmSync(testHome, { recursive: true, force: true }) } catch {}
})

// --- Mock SFTP ---
function createMockSftp() {
  const sftp: any = new EventEmitter()

  sftp.realpath = mock.fn((_path: string, cb: Function) => {
    cb(null, "/home/testuser")
  })

  sftp.createReadStream = mock.fn((_path: string) => {
    const stream = new EventEmitter()
    process.nextTick(() => {
      stream.emit("data", Buffer.from("hello world\nline 2\nline 3\n"))
      stream.emit("end")
    })
    return stream
  })

  sftp.createWriteStream = mock.fn((_path: string, _opts?: any) => {
    const stream: any = new EventEmitter()
    stream.end = mock.fn(() => process.nextTick(() => stream.emit("close")))
    return stream
  })

  sftp.stat = mock.fn((_path: string, cb: Function) => {
    if (_path.includes("nonexistent")) {
      cb(new Error("No such file"))
    } else {
      cb(null, {
        size: 1024,
        uid: 1000,
        gid: 1000,
        mode: _path.includes("dir") ? 0o040755 : 0o100644,
        atime: 1000,
        mtime: 2000,
      })
    }
  })

  sftp.readdir = mock.fn((_path: string, cb: Function) => {
    cb(null, [
      {
        filename: "file.txt",
        longname: "-rw-r--r-- 1 user group 1024 Jan 1 00:00 file.txt",
        attrs: { size: 1024, uid: 1000, gid: 1000, mode: 0o100644, atime: 1000, mtime: 2000 },
      },
      {
        filename: ".hidden",
        longname: "-rw-r--r-- 1 user group 100 Jan 1 00:00 .hidden",
        attrs: { size: 100, uid: 1000, gid: 1000, mode: 0o100644, atime: 1000, mtime: 2000 },
      },
      {
        filename: "subdir",
        longname: "drwxr-xr-x 2 user group 4096 Jan 1 00:00 subdir",
        attrs: { size: 4096, uid: 1000, gid: 1000, mode: 0o040755, atime: 1000, mtime: 2000 },
      },
    ])
  })

  sftp.end = mock.fn(() => {})

  return sftp
}

// --- Mock ssh2 Client ---
function createMockClient(opts?: { sftp?: any; execHandler?: Function }) {
  const sftp = opts?.sftp ?? createMockSftp()
  const client = new EventEmitter() as any

  client.sftp = mock.fn((cb: Function) => cb(null, sftp))

  client.exec = opts?.execHandler
    ?? mock.fn((cmd: string, cb: Function) => {
      const stream = new EventEmitter() as any
      stream.stderr = new EventEmitter()
      stream.write = mock.fn(() => {})
      stream.close = mock.fn(() => stream.emit("close", 0))

      cb(null, stream)
      process.nextTick(() => {
        if (cmd.includes("size_bytes=")) {
          stream.emit("data", Buffer.from("size_bytes=24\ntotal_lines=3\nbinary_detected=false\nencoding=utf-8\n"))
        } else if (cmd.includes("sed -n")) {
          stream.emit("data", Buffer.from("hello world\nline 2\nline 3\n"))
        } else if (cmd.includes("stat -c")) {
          stream.emit("data", Buffer.from("regular file\t1024\t644\tuser\tgroup\t2000\t/tmp/file.txt\n"))
        } else if (cmd.includes("grep")) {
          stream.emit("data", Buffer.from("file.txt\x001:match\n"))
        } else if (cmd.includes("-maxdepth 1 -mindepth 1")) {
          if (cmd.includes("! -name")) {
            stream.emit("data", Buffer.from("file.txt\tf\t1024\t644\t2000\t/tmp/file.txt\nsubdir\td\t4096\t755\t2001\t/tmp/subdir\n"))
          } else {
            stream.emit("data", Buffer.from("file.txt\tf\t1024\t644\t2000\t/tmp/file.txt\n.hidden\tf\t100\t644\t2000\t/tmp/.hidden\nsubdir\td\t4096\t755\t2001\t/tmp/subdir\n"))
          }
        } else if (cmd.includes("find")) {
          stream.emit("data", Buffer.from("/tmp/file.txt\tf\t1024\t2000\n/tmp/dir\td\t4096\t2001\n"))
        } else {
          stream.emit("data", Buffer.from("cmd output"))
        }
        stream.emit("close", 0)
      })
    })

  return client
}

describe("RemoteTools", () => {
  describe("createRemoteTools", () => {
    it("should create all tools", async () => {
      const client = createMockClient()
      const tools = await createRemoteTools({
        sessionId: "test",
        client,
        cwd: "/home/testuser",
      })

      assert.ok(tools.readFile)
      assert.ok(tools.writeFile)
      assert.ok(tools.exec)
      assert.ok(tools.listDir)
      assert.ok(tools.exists)
      assert.ok(tools.stat)
      assert.ok(tools.grep)
      assert.ok(tools.find)
      assert.ok(tools.cd)
      assert.ok(tools.dispose)

      tools.dispose()
    })

    it("should have correct tool names", async () => {
      const client = createMockClient()
      const tools = await createRemoteTools({
        sessionId: "test",
        client,
        cwd: "/home/testuser",
      })

      assert.equal(tools.readFile.name, "remote_read_file")
      assert.equal(tools.writeFile.name, "remote_write_file")
      assert.equal(tools.exec.name, "remote_exec")
      assert.equal(tools.listDir.name, "remote_list_dir")
      assert.equal(tools.exists.name, "remote_exists")
      assert.equal(tools.stat.name, "remote_stat")
      assert.equal(tools.grep.name, "remote_grep")
      assert.equal(tools.find.name, "remote_find")
      assert.equal(tools.cd.name, "remote_cd")

      tools.dispose()
    })

    it("should have JSON schema parameters", async () => {
      const client = createMockClient()
      const tools = await createRemoteTools({
        sessionId: "test",
        client,
        cwd: "/home/testuser",
      })

      assert.equal(tools.readFile.parameters.type, "object")
      assert.ok(tools.readFile.parameters.properties.path)
      assert.deepEqual(tools.readFile.parameters.required, ["path"])

      assert.equal(tools.exec.parameters.type, "object")
      assert.ok(tools.exec.parameters.properties.command)
      assert.deepEqual(tools.exec.parameters.required, ["command"])

      tools.dispose()
    })
  })

  describe("readFile", () => {
    it("should read file with line numbers", async () => {
      const client = createMockClient()
      const tools = await createRemoteTools({
        sessionId: "test",
        client,
        cwd: "/home/testuser",
      })

      const result = await tools.readFile.execute({ path: "/tmp/file.txt" }) as any
      assert.equal(result.content, "1\thello world\n2\tline 2\n3\tline 3")
      assert.equal(result.binaryDetected, false)
      assert.equal(result.truncated, false)

      tools.dispose()
    })

    it("should support offset and limit", async () => {
      const client = createMockClient()
      const tools = await createRemoteTools({
        sessionId: "test",
        client,
        cwd: "/home/testuser",
      })

      const result = await tools.readFile.execute({ path: "/tmp/file.txt", offset: 1, limit: 1 }) as any
      assert.ok(result.content.includes("2\thello world"))
      assert.equal(result.offset, 1)
      assert.equal(result.limit, 1)

      tools.dispose()
    })

    it("should not read the whole file through SFTP and should report binary files", async () => {
      const sftp = createMockSftp()
      let readStreamCalls = 0
      sftp.createReadStream = mock.fn((_path: string) => {
        readStreamCalls++
        const stream = new EventEmitter()
        process.nextTick(() => {
          stream.emit("data", Buffer.alloc(MAX_READ_FILE_BYTES + 100))
          stream.emit("end")
        })
        return stream
      })
      const execHandler = mock.fn((cmd: string, cb: Function) => {
        const stream = new EventEmitter() as any
        stream.stderr = new EventEmitter()
        cb(null, stream)
        process.nextTick(() => {
          if (cmd.includes("size_bytes=")) {
            stream.emit("data", Buffer.from("size_bytes=10485760\ntotal_lines=0\nbinary_detected=true\nencoding=utf-8\n"))
          } else {
            stream.emit("data", Buffer.from("unexpected content"))
          }
          stream.emit("close", 0)
        })
      })

      const client = createMockClient({ sftp, execHandler })
      const tools = await createRemoteTools({
        sessionId: "test",
        client,
        cwd: "/home/testuser",
      })

      const result = await tools.readFile.execute({ path: "/tmp/blob.bin" }) as any
      assert.equal(readStreamCalls, 0)
      assert.equal(result.binaryDetected, true)
      assert.equal(result.content, "")
      assert.ok(result.agentGuidance[0].includes("ssh_download"))

      tools.dispose()
    })
  })

  describe("writeFile", () => {
    it("should write file and return confirmation", async () => {
      const client = createMockClient()
      const tools = await createRemoteTools({
        sessionId: "test",
        client,
        cwd: "/home/testuser",
      })

      const result = await tools.writeFile.execute({ path: "/tmp/out.txt", content: "data" })
      assert.ok(result.includes("Written"))
      assert.ok(result.includes("4 bytes"))
      assert.ok(result.includes("/tmp/out.txt"))

      tools.dispose()
    })
  })

  describe("exec", () => {
    it("should execute command and return result", async () => {
      const client = createMockClient()
      const tools = await createRemoteTools({
        sessionId: "test",
        client,
        cwd: "/home/testuser",
      })

      const result = await tools.exec.execute({ command: "whoami" })
      assert.equal(result.code, 0)
      assert.ok(result.stdout.includes("cmd output"))

      tools.dispose()
    })

    it("should use cwd from context when not specified", async () => {
      let receivedCmd = ""
      const execHandler = mock.fn((cmd: string, cb: Function) => {
        receivedCmd = cmd
        const stream = new EventEmitter() as any
        stream.stderr = new EventEmitter()
        cb(null, stream)
        process.nextTick(() => stream.emit("close", 0))
      })

      const client = createMockClient({ execHandler })
      const tools = await createRemoteTools({
        sessionId: "test",
        client,
        cwd: "/home/testuser",
      })

      await tools.exec.execute({ command: "pwd" })
      assert.ok(receivedCmd.includes("cd "))
      assert.ok(receivedCmd.includes("/home/testuser"))

      tools.dispose()
    })
  })

  describe("listDir", () => {
    it("should list files without hidden by default", async () => {
      const client = createMockClient()
      const tools = await createRemoteTools({
        sessionId: "test",
        client,
        cwd: "/home/testuser",
      })

      const result = await tools.listDir.execute({ path: "/tmp" })
      assert.deepEqual(result.entries.map((e: any) => e.name), ["file.txt", "subdir"])
      assert.equal(result.entries[0].type, "file")
      assert.equal(result.entries[1].type, "directory")

      tools.dispose()
    })

    it("should show hidden files when requested", async () => {
      const client = createMockClient()
      const tools = await createRemoteTools({
        sessionId: "test",
        client,
        cwd: "/home/testuser",
      })

      const result = await tools.listDir.execute({ path: "/tmp", showHidden: true })
      assert.ok(result.entries.some((entry: any) => entry.name === ".hidden"))

      tools.dispose()
    })

    it("should show file types and sizes", async () => {
      const client = createMockClient()
      const tools = await createRemoteTools({
        sessionId: "test",
        client,
        cwd: "/home/testuser",
      })

      const result = await tools.listDir.execute({ path: "/tmp" })
      assert.equal(result.entries[0].sizeBytes, 1024)
      assert.equal(result.entries[0].mode, "644")

      tools.dispose()
    })
  })

  describe("exists", () => {
    it("should return true for existing path", async () => {
      const client = createMockClient()
      const tools = await createRemoteTools({
        sessionId: "test",
        client,
        cwd: "/home/testuser",
      })

      const result = await tools.exists.execute({ path: "/tmp/file.txt" })
      assert.equal(result, true)

      tools.dispose()
    })

    it("should return false for nonexistent path", async () => {
      const client = createMockClient()
      const tools = await createRemoteTools({
        sessionId: "test",
        client,
        cwd: "/home/testuser",
      })

      const result = await tools.exists.execute({ path: "/tmp/nonexistent" })
      assert.equal(result, false)

      tools.dispose()
    })
  })

  describe("stat", () => {
    it("should return file stats", async () => {
      const client = createMockClient()
      const tools = await createRemoteTools({
        sessionId: "test",
        client,
        cwd: "/home/testuser",
      })

      const result = await tools.stat.execute({ path: "/tmp/file.txt" })
      assert.equal(result.sizeBytes, 1024)
      assert.equal(result.type, "file")
      assert.equal(result.mode, "644")

      tools.dispose()
    })
  })

  describe("grep", () => {
    it("should execute grep command on remote", async () => {
      const client = createMockClient()
      const tools = await createRemoteTools({
        sessionId: "test",
        client,
        cwd: "/home/testuser",
      })

      const result = await tools.grep.execute({ pattern: "match", path: "/tmp" })
      assert.equal(result.count, 1)
      assert.deepEqual(result.matches[0], { file: "file.txt", line: 1, text: "match" })

      tools.dispose()
    })

    it("should support case insensitive flag", async () => {
      let receivedCmd = ""
      const execHandler = mock.fn((cmd: string, cb: Function) => {
        receivedCmd = cmd
        const stream = new EventEmitter() as any
        stream.stderr = new EventEmitter()
        cb(null, stream)
        process.nextTick(() => stream.emit("close", 0))
      })

      const client = createMockClient({ execHandler })
      const tools = await createRemoteTools({
        sessionId: "test",
        client,
        cwd: "/home/testuser",
      })

      await tools.grep.execute({ pattern: "test", path: "/tmp", caseInsensitive: true })
      assert.ok(receivedCmd.includes("grep -RInIZi"))

      tools.dispose()
    })

    it("should support glob filter", async () => {
      let receivedCmd = ""
      const execHandler = mock.fn((cmd: string, cb: Function) => {
        receivedCmd = cmd
        const stream = new EventEmitter() as any
        stream.stderr = new EventEmitter()
        cb(null, stream)
        process.nextTick(() => stream.emit("close", 0))
      })

      const client = createMockClient({ execHandler })
      const tools = await createRemoteTools({
        sessionId: "test",
        client,
        cwd: "/home/testuser",
      })

      await tools.grep.execute({ pattern: "test", path: "/tmp", glob: "*.ts" })
      assert.ok(receivedCmd.includes("--include="))
      assert.ok(receivedCmd.includes("*.ts"))

      tools.dispose()
    })
  })

  describe("find", () => {
    it("should execute find command on remote", async () => {
      const client = createMockClient()
      const tools = await createRemoteTools({
        sessionId: "test",
        client,
        cwd: "/home/testuser",
      })

      const result = await tools.find.execute({ path: "/tmp" })
      assert.equal(result.count, 2)
      assert.equal(result.results[0].path, "/tmp/file.txt")
      assert.deepEqual(result.results.map((item: any) => item.type), ["file", "directory"])

      tools.dispose()
    })

    it("should support name filter", async () => {
      let receivedCmd = ""
      const execHandler = mock.fn((cmd: string, cb: Function) => {
        receivedCmd = cmd
        const stream = new EventEmitter() as any
        stream.stderr = new EventEmitter()
        cb(null, stream)
        process.nextTick(() => stream.emit("close", 0))
      })

      const client = createMockClient({ execHandler })
      const tools = await createRemoteTools({
        sessionId: "test",
        client,
        cwd: "/home/testuser",
      })

      await tools.find.execute({ path: "/tmp", name: "*.ts" })
      assert.ok(receivedCmd.includes("-name"))
      assert.ok(receivedCmd.includes("*.ts"))

      tools.dispose()
    })

    it("should support type filter", async () => {
      let receivedCmd = ""
      const execHandler = mock.fn((cmd: string, cb: Function) => {
        receivedCmd = cmd
        const stream = new EventEmitter() as any
        stream.stderr = new EventEmitter()
        cb(null, stream)
        process.nextTick(() => stream.emit("close", 0))
      })

      const client = createMockClient({ execHandler })
      const tools = await createRemoteTools({
        sessionId: "test",
        client,
        cwd: "/home/testuser",
      })

      await tools.find.execute({ path: "/tmp", type: "f" })
      assert.ok(receivedCmd.includes("-type f"))

      tools.dispose()
    })

    it("should support maxDepth", async () => {
      let receivedCmd = ""
      const execHandler = mock.fn((cmd: string, cb: Function) => {
        receivedCmd = cmd
        const stream = new EventEmitter() as any
        stream.stderr = new EventEmitter()
        cb(null, stream)
        process.nextTick(() => stream.emit("close", 0))
      })

      const client = createMockClient({ execHandler })
      const tools = await createRemoteTools({
        sessionId: "test",
        client,
        cwd: "/home/testuser",
      })

      await tools.find.execute({ path: "/tmp", maxDepth: 2 })
      assert.ok(receivedCmd.includes("-maxdepth 2"))

      tools.dispose()
    })
  })

  describe("cd", () => {
    it("should change working directory", async () => {
      const client = createMockClient()
      const tools = await createRemoteTools({
        sessionId: "test",
        client,
        cwd: "/home/testuser",
      })

      const result = await tools.cd.execute({ path: "/tmp/dir" })
      assert.ok(result.includes("Changed directory to"))

      tools.dispose()
    })

    it("should reject non-directory path", async () => {
      const sftp = createMockSftp()
      // stat returns file (not directory) for this path
      sftp.stat = mock.fn((_path: string, cb: Function) => {
        cb(null, {
          size: 100,
          uid: 1000,
          gid: 1000,
          mode: 0o100644, // regular file
          atime: 1000,
          mtime: 2000,
        })
      })
      const client = createMockClient({ sftp })
      const tools = await createRemoteTools({
        sessionId: "test",
        client,
        cwd: "/home/testuser",
      })

      await assert.rejects(
        () => tools.cd.execute({ path: "/tmp/file.txt" }),
        { message: /is not a directory/ },
      )

      tools.dispose()
    })

    it("should affect subsequent exec commands", async () => {
      let receivedCmd = ""
      const execHandler = mock.fn((cmd: string, cb: Function) => {
        receivedCmd = cmd
        const stream = new EventEmitter() as any
        stream.stderr = new EventEmitter()
        cb(null, stream)
        process.nextTick(() => stream.emit("close", 0))
      })

      const sftp = createMockSftp()
      // Make stat recognize /var/log as a directory
      sftp.stat = mock.fn((_path: string, cb: Function) => {
        cb(null, {
          size: 4096,
          uid: 1000,
          gid: 1000,
          mode: 0o040755, // directory
          atime: 1000,
          mtime: 2000,
        })
      })
      const client = createMockClient({ sftp, execHandler })
      const tools = await createRemoteTools({
        sessionId: "test",
        client,
        cwd: "/home/testuser",
      })

      await tools.cd.execute({ path: "/var/log" })
      await tools.exec.execute({ command: "ls" })

      // After cd, the exec should use the new cwd
      assert.ok(receivedCmd.includes("cd "))
      assert.ok(receivedCmd.includes("/var/log"))

      tools.dispose()
    })
  })

  describe("dispose", () => {
    it("should close SFTP connection", async () => {
      const sftp = createMockSftp()
      const client = createMockClient({ sftp })
      const tools = await createRemoteTools({
        sessionId: "test",
        client,
        cwd: "/home/testuser",
      })

      tools.dispose()
      assert.equal(sftp.end.mock.callCount(), 1)
    })
  })
})
