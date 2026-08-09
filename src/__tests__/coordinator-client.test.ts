import { describe, it } from "node:test"
import assert from "node:assert/strict"
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
})
