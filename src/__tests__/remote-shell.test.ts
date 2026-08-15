/**
 * RemoteShell Tests
 * Tests remoteExec with mocked ssh2 Client.
 *
 * SSH_TOOL_DATA_DIR redirect: remoteExec() lazily constructs a global
 * ExecTaskManager, which builds a SchedulerService that writes under the
 * platform data dir. In sandboxed CI environments writes to the real
 * data dir may fail with EPERM, so we redirect SSH_TOOL_DATA_DIR at a
 * tmpdir before the module is first evaluated and use a dynamic `import()`
 * to bind the functions under that env.
 */

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "events"
import { rmSync, mkdirSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { clearDialectCache, putCachedDialect } from "../remote-dialect/cache.js"

const testDataDir = join(tmpdir(), `remote-shell-${Date.now()}-${process.pid}`)
const origDataDir = process.env.SSH_TOOL_DATA_DIR
let remoteExec: typeof import("../remote-shell.js").remoteExec
let execOnChain: typeof import("../remote-shell.js").execOnChain
let resolveRemoteCwd: typeof import("../remote-shell.js").resolveRemoteCwd
let execRemote: typeof import("../remote-shell.js").execRemote

before(async () => {
  mkdirSync(testDataDir, { recursive: true })
  process.env.SSH_TOOL_DATA_DIR = testDataDir
  const mod = await import(`../remote-shell.js?t=${Date.now()}`)
  remoteExec = mod.remoteExec
  execOnChain = mod.execOnChain
  resolveRemoteCwd = mod.resolveRemoteCwd
  execRemote = mod.execRemote
})

after(() => {
  if (origDataDir === undefined) delete process.env.SSH_TOOL_DATA_DIR
  else process.env.SSH_TOOL_DATA_DIR = origDataDir
  try { rmSync(testDataDir, { recursive: true, force: true }) } catch {}
})

// Mock ssh2 stream
function createMockStream() {
  const ee = new EventEmitter() as any
  let closeCalls = 0
  ee.stderr = new EventEmitter()
  ee.write = () => {}
  ee.close = () => {
    closeCalls++
    ee.emit("close", 0)
  }
  // Object.assign would snapshot the getter value (0), so define it
  // explicitly to keep closeCalls live for assertions.
  Object.defineProperty(ee, "closeCalls", {
    get: () => closeCalls,
    enumerable: true,
  })
  return ee
}

// Mock ssh2 Client
function createMockClient(execHandler?: (cmd: string, cb: Function) => void) {
  const client = new EventEmitter() as any
  client.exec = execHandler ?? ((_cmd: string, cb: Function) => {
    const stream = createMockStream()
    cb(null, stream)
    // Simulate command output
    stream.emit("data", Buffer.from("hello"))
    stream.stderr.emit("data", Buffer.from("err"))
    stream.emit("close", 0)
  })
  return client
}

describe("remoteExec", () => {
  it("should capture stdout, stderr, and exit code", async () => {
    const client = createMockClient((_cmd, cb) => {
      const stream = createMockStream()
      cb(null, stream)
      process.nextTick(() => {
        stream.emit("data", Buffer.from("output line 1\n"))
        stream.emit("data", Buffer.from("output line 2\n"))
        stream.stderr.emit("data", Buffer.from("error msg\n"))
        stream.emit("close", 0)
      })
    })

    const result = await remoteExec(client, "ls")
    assert.equal(result.stdout, "output line 1\noutput line 2\n")
    assert.equal(result.stderr, "error msg\n")
    assert.equal(result.code, 0)
  })

  it("should handle non-zero exit code", async () => {
    const client = createMockClient((_cmd, cb) => {
      const stream = createMockStream()
      cb(null, stream)
      process.nextTick(() => {
        stream.stderr.emit("data", Buffer.from("not found\n"))
        stream.emit("close", 127)
      })
    })

    const result = await remoteExec(client, "badcommand")
    assert.equal(result.code, 127)
    assert.equal(result.stderr, "not found\n")
  })

  it("should handle exec error", async () => {
    const client = createMockClient((_cmd, cb) => {
      cb(new Error("exec failed"))
    })

    await assert.rejects(
      () => remoteExec(client, "cmd"),
      // ExecTaskManager wraps ssh2 client.exec() errors with "Failed to exec:"
      // (see src/exec-task-manager.ts). The previous "Failed to exec command:"
      // wording predated the unified task manager and was never updated.
      { message: "Failed to exec: exec failed" },
    )
  })

  it("should handle stream error", async () => {
    const client = createMockClient((_cmd, cb) => {
      const stream = createMockStream()
      cb(null, stream)
      process.nextTick(() => {
        stream.emit("error", new Error("stream broke"))
      })
    })

    await assert.rejects(
      () => remoteExec(client, "cmd"),
      { message: "Stream error: stream broke" },
    )
  })

  it("wraps cwd commands with an external sh so shell builtins are valid", async () => {
    let receivedCmd = ""
    const client = createMockClient((cmd, cb) => {
      receivedCmd = cmd
      const stream = createMockStream()
      cb(null, stream)
      process.nextTick(() => stream.emit("close", 0))
    })

    await remoteExec(client, "ls", { cwd: "/tmp" })
    assert.match(receivedCmd, /exec sh -c/)
    assert.match(receivedCmd, /cd .*\/tmp.*&& ls/)
  })

  it("should prepend env vars to command", async () => {
    let receivedCmd = ""
    const client = createMockClient((cmd, cb) => {
      receivedCmd = cmd
      const stream = createMockStream()
      cb(null, stream)
      process.nextTick(() => stream.emit("close", 0))
    })

    await remoteExec(client, "ls", { env: { FOO: "bar" } })
    assert.match(receivedCmd, /exec sh -c/)
    assert.ok(receivedCmd.includes("export FOO"))
    assert.ok(receivedCmd.includes("bar"))
    assert.ok(receivedCmd.includes("ls"))
  })

  it("executes top-level semicolon commands sequentially", async () => {
    const commands: string[] = []
    const client = createMockClient((cmd, cb) => {
      commands.push(cmd)
      const stream = createMockStream()
      cb(null, stream)
      process.nextTick(() => {
        stream.emit("data", Buffer.from(`${commands.length}\n`))
        stream.emit("close", 0)
      })
    })

    const result = await remoteExec(client, "echo one; echo two")

    assert.equal(commands.length, 2)
    assert.match(commands[0], /echo one/)
    assert.match(commands[1], /echo two/)
    assert.equal(result.stdout, "1\n2\n")
    assert.equal(result.code, 0)
  })

  it("continues semicolon command execution after a non-zero exit", async () => {
    const commands: string[] = []
    const client = createMockClient((cmd, cb) => {
      commands.push(cmd)
      const stream = createMockStream()
      cb(null, stream)
      process.nextTick(() => stream.emit("close", commands.length === 1 ? 7 : 0))
    })

    const result = await remoteExec(client, "false; echo should-run")

    assert.equal(commands.length, 2)
    assert.match(commands[1], /echo should-run/)
    assert.equal(result.code, 0)
  })

  it("should handle empty output", async () => {
    const client = createMockClient((_cmd, cb) => {
      const stream = createMockStream()
      cb(null, stream)
      process.nextTick(() => stream.emit("close", 0))
    })

    const result = await remoteExec(client, "true")
    assert.equal(result.stdout, "")
    assert.equal(result.stderr, "")
    assert.equal(result.code, 0)
  })

  it("should handle signal in close event", async () => {
    const client = createMockClient((_cmd, cb) => {
      const stream = createMockStream()
      cb(null, stream)
      process.nextTick(() => stream.emit("close", null, "SIGTERM"))
    })

    const result = await remoteExec(client, "sleep 999")
    assert.equal(result.signal, "SIGTERM")
  })

  it("uses the dialect cached for the session key (powershell wrapper)", async () => {
    putCachedDialect("u@h:22", { kind: "powershell", sub: "powershell", detectedAt: Date.now() })
    try {
      let received = ""
      const client = createMockClient((cmd, cb) => {
        received = cmd
        const stream = createMockStream()
        cb(null, stream)
        stream.emit("close", 0)
      })
      await remoteExec(client, "echo hi", { sessionKey: "u@h:22" })
      assert.match(received, /^powershell -NoLogo -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand /)
    } finally {
      clearDialectCache()
    }
  })

  it("does not split semicolons when the dialect does not support it", async () => {
    putCachedDialect("c@h:22", { kind: "cmd", sub: "cmd", detectedAt: Date.now() })
    try {
      let execCount = 0
      const client = createMockClient((_cmd, cb) => {
        execCount++
        const stream = createMockStream()
        cb(null, stream)
        stream.emit("close", 0)
      })
      await remoteExec(client, "echo a; echo b", { sessionKey: "c@h:22" })
      assert.equal(execCount, 1)
    } finally {
      clearDialectCache()
    }
  })
})

describe("resolveRemoteCwd", () => {
  it("returns the normalized remote directory and uses the previous cwd for relative paths", async () => {
    let receivedCmd = ""
    const client = createMockClient((cmd, cb) => {
      receivedCmd = cmd
      const stream = createMockStream()
      cb(null, stream)
      process.nextTick(() => {
        stream.emit("data", Buffer.from("/workspace/project\n"))
        stream.emit("close", 0)
      })
    })

    const cwd = await resolveRemoteCwd(client, "child dir", "/workspace")

    assert.equal(cwd, "/workspace/project")
    // The command is wrapped (and shell-quoted) by execRemote, so assert the
    // wrapper prefix plus the resolved cwd components rather than exact quotes.
    assert.match(receivedCmd, /^echo "SSH_TOOL_PID:\$\$" >&2; exec sh -c /)
    assert.ok(receivedCmd.includes("/workspace"))
    assert.ok(receivedCmd.includes("child dir"))
    assert.ok(receivedCmd.includes("pwd -P"))
  })

  it("rejects when the remote directory cannot be entered", async () => {
    const client = createMockClient((_cmd, cb) => {
      const stream = createMockStream()
      cb(null, stream)
      process.nextTick(() => {
        stream.stderr.emit("data", Buffer.from("No such file or directory\n"))
        stream.emit("close", 1)
      })
    })

    await assert.rejects(
      () => resolveRemoteCwd(client, "/missing"),
      { message: "No such file or directory" },
    )
  })

  it("preserves trailing whitespace in the resolved directory name", async () => {
    const client = createMockClient((_cmd, cb) => {
      const stream = createMockStream()
      cb(null, stream)
      process.nextTick(() => {
        stream.emit("data", Buffer.from("/workspace/trailing \n"))
        stream.emit("close", 0)
      })
    })

    const cwd = await resolveRemoteCwd(client, "/workspace/trailing ")
    assert.equal(cwd, "/workspace/trailing ")
  })
})

describe("execRemote", () => {
  it("captures stdout, stderr, and exit code without tracking a scheduler task", async () => {
    let receivedCmd = ""
    const client = createMockClient((cmd, cb) => {
      receivedCmd = cmd
      const stream = createMockStream()
      cb(null, stream)
      process.nextTick(() => {
        stream.emit("data", Buffer.from("out\n"))
        stream.stderr.emit("data", Buffer.from("err\n"))
        stream.emit("close", 0)
      })
    })

    const result = await execRemote(client, "pwd -P")

    assert.match(receivedCmd, /^echo "SSH_TOOL_PID:\$\$" >&2; exec sh -c /)
    assert.equal(result.code, 0)
    assert.equal(result.stdout, "out\n")
    assert.equal(result.stderr, "err\n")
  })

  it("wraps the command with a PID marker without exposing the marker in stderr", async () => {
    let receivedCmd = ""
    const client = createMockClient((cmd, cb) => {
      receivedCmd = cmd
      const stream = createMockStream()
      cb(null, stream)
      process.nextTick(() => {
        stream.stderr.emit("data", Buffer.from("SSH_TOOL_PID:12345\nreal stderr\n"))
        stream.emit("close", 0)
      })
    })

    const result = await execRemote(client, "echo hello")

    assert.match(receivedCmd, /^echo "SSH_TOOL_PID:\$\$" >&2; exec sh -c /)
    assert.equal(result.stderr, "real stderr\n")
  })

  it("execRemote uses the dialect for the session key", async () => {
    putCachedDialect("u@h:22", { kind: "powershell", sub: "powershell", detectedAt: Date.now() })
    try {
      let receivedCmd = ""
      const client = createMockClient((cmd, cb) => {
        receivedCmd = cmd
        const stream = createMockStream()
        cb(null, stream)
        process.nextTick(() => stream.emit("close", 0))
      })

      const result = await execRemote(client, "echo hi", { sessionKey: "u@h:22" })

      assert.equal(result.code, 0)
      assert.match(receivedCmd, /^powershell -NoLogo -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand /)
    } finally {
      clearDialectCache()
    }
  })

  it("terminates the captured remote process when the command times out", async () => {
    const commands: string[] = []
    let commandStream: ReturnType<typeof createMockStream> | undefined
    const client = createMockClient((cmd, cb) => {
      commands.push(cmd)
      if (commands.length === 1) {
        commandStream = createMockStream()
        cb(null, commandStream)
        process.nextTick(() => commandStream!.stderr.emit("data", Buffer.from("SSH_TOOL_PID:4321\n")))
        return
      }
      cb(null, createMockStream())
    })

    const result = await execRemote(client, "sleep 60", { timeout: 5 })

    assert.equal(result.code, 124)
    assert.equal(result.signal, "TERM")
    assert.ok(commands.some((cmd) => cmd.includes("kill -TERM 4321")))
    assert.ok(commands.some((cmd) => cmd.includes("kill -KILL 4321")))
    assert.ok(commandStream!.closeCalls > 0)
  })

  it("marks a timeout as potentially still running when no PID was captured", async () => {
    const client = createMockClient((_cmd, cb) => {
      cb(null, createMockStream())
    })

    const result = await execRemote(client, "sleep 60", { timeout: 5 })

    assert.equal(result.code, 124)
    assert.equal(result.remoteProcessMayContinue, true)
  })

  it("closes the channel and marks stdout truncated when stdout reaches the cap", async () => {
    let stream: ReturnType<typeof createMockStream> | undefined
    const client = createMockClient((_cmd, cb) => {
      stream = createMockStream()
      cb(null, stream)
      process.nextTick(() => stream!.emit("data", Buffer.from("123456789")))
    })

    const result = await execRemote(client, "yes", { maxBufferBytes: 8 })

    assert.equal(result.stdoutTruncated, true)
    assert.ok(stream!.closeCalls > 0)
  })

  it("closes the channel and marks stderr truncated when stderr reaches the cap", async () => {
    let stream: ReturnType<typeof createMockStream> | undefined
    const client = createMockClient((_cmd, cb) => {
      stream = createMockStream()
      cb(null, stream)
      process.nextTick(() => stream!.stderr.emit("data", Buffer.from("123456789")))
    })

    const result = await execRemote(client, "cmd", { maxBufferBytes: 8 })

    assert.equal(result.stderrTruncated, true)
    assert.ok(stream!.closeCalls > 0)
  })

  it("reports non-zero exit codes", async () => {
    const client = createMockClient((_cmd, cb) => {
      const stream = createMockStream()
      cb(null, stream)
      process.nextTick(() => stream.emit("close", 127))
    })

    const result = await execRemote(client, "missing")
    assert.equal(result.code, 127)
  })

  it("rejects when exec fails to open a stream", async () => {
    const client = createMockClient((_cmd, cb) => {
      cb(new Error("exec failed"))
    })

    await assert.rejects(
      () => execRemote(client, "cmd"),
      { message: "Failed to exec: exec failed" },
    )
  })

  it("resolves with a timeout code when the command exceeds the timeout", async () => {
    const client = createMockClient((_cmd, cb) => {
      const stream = createMockStream()
      cb(null, stream)
      // Never emit close; only the timeout should settle the promise.
    })

    const result = await execRemote(client, "sleep 999", { timeout: 50 })
    assert.equal(result.code, 124)
  })

  it("times out even when the exec callback never fires (dead client)", async () => {
    // A half-open/dead client may never invoke the client.exec callback.
    // The timeout must cover that window too, or the promise hangs forever.
    const client = createMockClient(() => {
      // callback intentionally never called
    })

    const result = await execRemote(client, "cmd", { timeout: 50 })
    assert.equal(result.code, 124)
  })

  it("rejects when the channel closes without an exit code", async () => {
    const client = createMockClient((_cmd, cb) => {
      const stream = createMockStream()
      cb(null, stream)
      process.nextTick(() => stream.emit("close", undefined))
    })

    await assert.rejects(
      () => execRemote(client, "cmd"),
      /closed without an exit code/,
    )
  })

  it("caps buffered output at the maxBufferBytes limit", async () => {
    const client = createMockClient((_cmd, cb) => {
      const stream = createMockStream()
      cb(null, stream)
      process.nextTick(() => {
        stream.emit("data", Buffer.from("AAAAAA"))
        stream.emit("data", Buffer.from("BBBBBB"))
        stream.emit("close", 0)
      })
    })

    const result = await execRemote(client, "cmd", { maxBufferBytes: 8 })
    assert.equal(result.stdout, "AAAAAA", "output beyond the cap should be dropped")
  })
})

describe("execOnChain", () => {
  it("should execute on the last client in chain", async () => {
    let executedOn: string | null = null
    const makeClient = (name: string) => createMockClient((_cmd, cb) => {
      executedOn = name
      const stream = createMockStream()
      cb(null, stream)
      process.nextTick(() => stream.emit("close", 0))
    })

    const chain = [
      { client: makeClient("hop1") },
      { client: makeClient("hop2") },
      { client: makeClient("target") },
    ]

    await execOnChain(chain, "hostname")
    assert.equal(executedOn, "target")
  })

  it("should reject empty chain", () => {
    assert.throws(
      () => execOnChain([], "cmd"),
      { message: "No SSH clients in chain" },
    )
  })
})
