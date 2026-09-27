import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { RemoteCoordinatorClient, type CoordinatorTransport } from "../coordinator/client.js"
import { createClientIdentity } from "../coordinator/protocol.js"

describe("coordinator client", () => {
  it("forwards typed requests and degrades transport failures", async () => {
    const requests: unknown[] = []
    const transport: CoordinatorTransport = { async request(request) { requests.push(request); return { ok: true, data: { conflicts: [] } } } }
    const client = new RemoteCoordinatorClient(transport)
    const identity = createClientIdentity("alice", "root", "2.0.0")
    const response = await client.registerClient(identity)
    assert.equal(response.ok, true)
    assert.equal((requests[0] as any).action, "registerClient")

    const unavailable = new RemoteCoordinatorClient({ async request() { throw new Error("offline") } })
    const failed = await unavailable.health()
    assert.equal(failed.ok, false)
    assert.equal(failed.errorCode, "COORDINATION_UNAVAILABLE")
  })

  it("writes a real newline, closes helper stdin, and honors the request timeout", async () => {
    class FakeStream extends EventEmitter {
      stderr = new EventEmitter()
      payload = ""
      ended = false
      write(value: string) { this.payload += value }
      end() { this.ended = true; this.emit("data", JSON.stringify({ ok: true, data: { version: "test" } })); this.emit("close", 0) }
      close() { this.emit("close") }
    }
    const stream = new FakeStream()
    const client = { exec(_command: string, callback: Function) { callback(undefined, stream) } }
    const transport = new (await import("../coordinator/client.js")).SshExecCoordinatorTransport(client as any, "helper", 100)
    const response = await transport.request({ action: "health", protocolVersion: 1 })
    assert.equal(response.ok, true)
    assert.equal(stream.payload.endsWith("\n"), true)
    assert.equal(stream.payload.endsWith("\\n"), false)
    assert.equal(stream.ended, true)
  })

  it("fails a helper that never opens a response within the deadline", async () => {
    const client = { exec() {} }
    const transport = new (await import("../coordinator/client.js")).SshExecCoordinatorTransport(client as any, "helper", 10)
    await assert.rejects(
      () => transport.request({ action: "health", protocolVersion: 1 }),
      /timed out/,
    )
  })
})
