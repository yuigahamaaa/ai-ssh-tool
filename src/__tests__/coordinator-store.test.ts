import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { CoordinatorStore } from "../coordinator/store.js"
import { createClientIdentity } from "../coordinator/protocol.js"

const identity = { peerUid: 1000, peerUsername: "alice", identityTrust: "peer-uid" as const }

describe("coordinator store", () => {
  it("registers clients and returns overlapping leases", () => {
    const store = new CoordinatorStore()
    const client = createClientIdentity("alice", "alice", "2.0.0")
    store.registerClient(client)
    const first = store.beginTask({ clientId: client.clientId, workspace: "/srv/app", kind: "build", summary: "build", ttlMs: 60_000 }, identity)
    const second = store.beginTask({ clientId: client.clientId, workspace: "/srv/app/api", kind: "write", summary: "edit api", ttlMs: 60_000 }, identity)
    assert.equal(second.conflicts.length, 1)
    assert.equal(second.conflicts[0].taskId, first.taskId)
    store.close()
  })

  it("requires the original lease token", () => {
    const store = new CoordinatorStore()
    const client = createClientIdentity("alice", "alice", "2.0.0")
    const task = store.beginTask({ clientId: client.clientId, workspace: "/srv/app", kind: "write", summary: "edit", ttlMs: 60_000 }, identity)
    assert.throws(() => store.heartbeat(task.taskId, "wrong"), /LEASE_TOKEN_MISMATCH/)
    store.heartbeat(task.taskId, task.leaseToken)
    store.finishTask(task.taskId, task.leaseToken, "success")
    assert.equal(store.listActive().length, 0)
    store.close()
  })

  it("expires leases and keeps observer records separate", () => {
    const store = new CoordinatorStore()
    const client = createClientIdentity("alice", "alice", "2.0.0")
    const task = store.beginTask({ clientId: client.clientId, workspace: "/srv/app", kind: "write", summary: "edit", ttlMs: 30_000 }, identity, 1000)
    store.cleanupExpired(31_000)
    assert.equal(store.listActive(undefined, 31_000).length, 0)
    store.submitObservations([], [{ observationId: "p1", pid: 10, parentPid: 1, uid: 1000, username: "alice", cwd: "/srv/app", command: "npm run build", commandTruncated: false, riskKind: "build", firstSeenAt: 1000, lastSeenAt: 1000, source: "process-observer", confidence: "low" }], 1000)
    assert.equal(store.listObserved("/srv/app", 1000).length, 1)
    assert.equal(store.listActive(undefined, 1000).some((entry) => entry.taskId === task.taskId), false)
    store.close()
  })
})
