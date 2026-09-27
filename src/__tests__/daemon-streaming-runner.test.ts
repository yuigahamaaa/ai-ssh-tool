import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "events"
import { execScheduledStream } from "../daemon.js"
import { clearDialectCache, putCachedDialect } from "../remote-dialect/cache.js"

class FakeChannel extends EventEmitter {
  stderr = new EventEmitter()
  closed = false

  close(): void {
    this.closed = true
    this.emit("close", 124, "TERM")
  }
}

class FakeClient {
  streams: FakeChannel[] = []
  executed: string[] = []

  exec(command: string, cb: (err: Error | undefined, stream: FakeChannel) => void): void {
    this.executed.push(command)
    const stream = new FakeChannel()
    this.streams.push(stream)
    cb(undefined, stream)
  }
}

describe("daemon scheduled streaming runner", () => {
  it("executes semicolon commands in one remote shell", async () => {
    const client = new FakeClient()
    const resultPromise = execScheduledStream(client as any, "echo one; echo two", 5000)

    await new Promise(resolve => setImmediate(resolve))
    client.streams[0]!.emit("close", 0, undefined)
    assert.equal(client.executed.length, 1)

    const result = await resultPromise
    assert.equal(result.code, 0)
    assert.match(client.executed[0]!, /echo one; echo two/)
  })

  it("streams stdout/stderr through callback and returns no aggregated output", async () => {
    const client = new FakeClient()
    const chunks: { stdout: string; stderr: string }[] = []
    let capturedPid: number | undefined

    const resultPromise = execScheduledStream(
      client as any,
      "npm test",
      5000,
      (stdout, stderr) => chunks.push({ stdout, stderr }),
      (pid) => { capturedPid = pid },
    )

    await new Promise(resolve => setImmediate(resolve))
    const stream = client.streams[0]!
    stream.stderr.emit("data", Buffer.from("SSH_TOOL_PID:12345\n"))
    stream.emit("data", Buffer.from("stdout-1\n"))
    stream.stderr.emit("data", Buffer.from("stderr-1\n"))
    stream.emit("close", 0, undefined)

    const result = await resultPromise

    assert.equal(capturedPid, 12345)
    assert.equal(result.code, 0)
    assert.equal(result.stdout, "")
    assert.equal(result.stderr, "")
    assert.deepEqual(chunks, [
      { stdout: "stdout-1\n", stderr: "" },
      { stdout: "", stderr: "stderr-1\n" },
    ])
    assert.ok(client.executed[0].includes("exec sh -c"))
  })

  it("uses the dialect for the task hostId (powershell wrapper)", async () => {
    putCachedDialect("u@h:22", { kind: "powershell", sub: "powershell", detectedAt: Date.now() })
    try {
      const client = new FakeClient()
      const resultPromise = execScheduledStream(
        client as any,
        "echo hi",
        5000,
        undefined,
        undefined,
        undefined,
        "u@h:22",
      )
      await new Promise(resolve => setImmediate(resolve))
      client.streams[0]!.emit("close", 0, undefined)
      await resultPromise
      assert.match(client.executed[0]!, /^powershell -NoLogo -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand /)
    } finally {
      clearDialectCache()
    }
  })

  it("times out when ssh2 never opens the exec channel", async () => {
    const client = { exec: () => {} }
    const result = await execScheduledStream(client as any, "echo never-opens", 15)
    assert.equal(result.code, 124)
  })

  it("rejects a channel close that has no exit code", async () => {
    const client = new FakeClient()
    const promise = execScheduledStream(client as any, "echo dropped", 5000)
    await new Promise(resolve => setImmediate(resolve))
    client.streams[0]!.emit("close")
    await assert.rejects(promise, /without an exit code/)
  })
})
