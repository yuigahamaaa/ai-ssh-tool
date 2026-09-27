import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { RemoteCoordinatorClient, type CoordinatorTransport } from "../coordinator/client.js"
import { CoordinatorTaskScope } from "../coordinator/task-scope.js"

function makeTransport(): { transport: CoordinatorTransport; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    transport: {
      async request(request) {
        calls.push(request.action)
        if (request.action === "beginTask") return { ok: true, data: { taskId: "00000000-0000-4000-8000-000000000001", leaseToken: "secret", conflicts: [] } }
        return { ok: true, data: {} }
      },
    },
  }
}

describe("coordinator task integration", () => {
  it("begins, heartbeats and finishes exactly once", async () => {
    const { transport, calls } = makeTransport()
    const scope = new CoordinatorTaskScope(new RemoteCoordinatorClient(transport), { clientId: "00000000-0000-4000-8000-000000000002", workspace: "/srv/app", kind: "build", summary: "build", ttlMs: 60_000 })
    const metadata = await scope.begin()
    assert.equal(metadata.available, true)
    await scope.heartbeat()
    await scope.finish("success")
    await scope.finish("failed")
    assert.deepEqual(calls, ["beginTask", "heartbeat", "finishTask"])
  })

  it("degrades when coordinator is unavailable", async () => {
    const client = new RemoteCoordinatorClient({ async request() { throw new Error("offline") } })
    const scope = new CoordinatorTaskScope(client, { clientId: "00000000-0000-4000-8000-000000000002", workspace: "/srv/app", kind: "write", summary: "edit", ttlMs: 60_000 })
    const metadata = await scope.begin()
    assert.equal(metadata.available, false)
    assert.equal(metadata.coordinationUnavailable, true)
    await scope.finish("failed")
  })

  it("releases a lease that arrives after the task has already finished", async () => {
    const calls: string[] = []
    let releaseBegin!: (value: any) => void
    const client = new RemoteCoordinatorClient({
      async request(request) {
        calls.push(request.action)
        if (request.action === "beginTask") return await new Promise(resolve => { releaseBegin = resolve })
        return { ok: true, data: {} }
      },
    })
    const scope = new CoordinatorTaskScope(client, { clientId: "00000000-0000-4000-8000-000000000002", workspace: "/srv/app", kind: "write", summary: "edit", ttlMs: 60_000 })
    const begin = scope.begin()
    await scope.finish("success")
    releaseBegin({ ok: true, data: { taskId: "00000000-0000-4000-8000-000000000003", leaseToken: "late-token" } })
    await begin
    assert.deepEqual(calls, ["beginTask", "finishTask"])
  })
})
