/**
 * RemoteShell Tests
 * Tests remoteExec with mocked ssh2 Client
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "events"
import { remoteExec, execOnChain } from "../remote-shell.js"

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
      { message: "Failed to exec command: exec failed" },
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
    assert.ok(receivedCmd.startsWith('cd "/tmp" &&'))
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
    assert.ok(receivedCmd.includes("export FOO="))
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
