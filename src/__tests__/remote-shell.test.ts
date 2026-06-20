/**
 * RemoteShell Tests
 * Tests remoteExec with mocked ssh2 Client.
 *
 * HOME redirect: remoteExec() lazily constructs a global ExecTaskManager,
 * which builds a SchedulerService that writes under `~/.ssh-tool/...`. In
 * sandboxed CI environments writes to the real $HOME may fail with EPERM,
 * so we point HOME at a tmpdir before the module is first evaluated and
 * use a dynamic `import()` to bind the functions under that env.
 */

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "events"
import { rmSync, mkdirSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

const testHome = join(tmpdir(), `remote-shell-${Date.now()}-${process.pid}`)
const origHome = process.env.HOME
let remoteExec: typeof import("../remote-shell.js").remoteExec
let execOnChain: typeof import("../remote-shell.js").execOnChain

before(async () => {
  mkdirSync(testHome, { recursive: true })
  process.env.HOME = testHome
  const mod = await import(`../remote-shell.js?t=${Date.now()}`)
  remoteExec = mod.remoteExec
  execOnChain = mod.execOnChain
})

after(() => {
  process.env.HOME = origHome
  try { rmSync(testHome, { recursive: true, force: true }) } catch {}
})

// Mock ssh2 stream
function createMockStream() {
  const ee = new EventEmitter()
  return Object.assign(ee, {
    stderr: new EventEmitter(),
    write: () => {},
    close: () => ee.emit("close", 0),
  })
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

  it("should prepend cd to command when cwd is set", async () => {
    let receivedCmd = ""
    const client = createMockClient((cmd, cb) => {
      receivedCmd = cmd
      const stream = createMockStream()
      cb(null, stream)
      process.nextTick(() => stream.emit("close", 0))
    })

    await remoteExec(client, "ls", { cwd: "/tmp" })
    // The full wrapped command is `echo "SSH_TOOL_PID:$$" >&2; exec cd '<cwd>' && <cmd>`,
    // so we assert the cwd prefix appears somewhere inside the payload rather
    // than at offset 0 (the PID marker wrapper always precedes it).
    assert.ok(
      receivedCmd.includes("cd '/tmp' &&"),
      `expected cwd prefix in wrapped command, got: ${receivedCmd}`,
    )
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
    assert.ok(receivedCmd.includes("export FOO='bar'"))
    assert.ok(receivedCmd.includes("ls"))
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
