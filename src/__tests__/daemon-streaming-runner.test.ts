import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "events"
import { execScheduledStream } from "../daemon.js"

class FakeChannel extends EventEmitter {
  stderr = new EventEmitter()
  closed = false

  close(): void {
    this.closed = true
    this.emit("close", 124, "TERM")
  }
}

class FakeClient {
  stream = new FakeChannel()
  executed: string[] = []

  exec(command: string, cb: (err: Error | undefined, stream: FakeChannel) => void): void {
    this.executed.push(command)
    setImmediate(() => cb(undefined, this.stream))
  }
}

describe("daemon scheduled streaming runner", () => {
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
    client.stream.stderr.emit("data", Buffer.from("SSH_TOOL_PID:12345\n"))
    client.stream.emit("data", Buffer.from("stdout-1\n"))
    client.stream.stderr.emit("data", Buffer.from("stderr-1\n"))
    client.stream.emit("close", 0, undefined)

    const result = await resultPromise

    assert.equal(capturedPid, 12345)
    assert.equal(result.code, 0)
    assert.equal(result.stdout, "")
    assert.equal(result.stderr, "")
    assert.deepEqual(chunks, [
      { stdout: "stdout-1\n", stderr: "" },
      { stdout: "", stderr: "stderr-1\n" },
    ])
    assert.ok(client.executed[0].includes("exec npm test"))
  })
})
