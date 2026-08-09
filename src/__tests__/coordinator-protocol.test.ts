import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createClientIdentity, parseCoordinatorRequest } from "../coordinator/protocol.js"

const client = createClientIdentity("alice", "root", "2.0.0")
const task = { clientId: client.clientId, workspace: "/srv/app", kind: "write", summary: "update config", ttlMs: 60_000 }

describe("coordinator protocol", () => {
  it("parses health and task requests", () => {
    assert.deepEqual(parseCoordinatorRequest(JSON.stringify({ action: "health", protocolVersion: 1 })), { action: "health", protocolVersion: 1 })
    const parsed = parseCoordinatorRequest(JSON.stringify({ action: "beginTask", protocolVersion: 1, task }))
    assert.equal(parsed.action, "beginTask")
    assert.equal(parsed.task.workspace, "/srv/app")
  })

  it("rejects malformed and unknown requests", () => {
    assert.throws(() => parseCoordinatorRequest("{"), /INVALID_REQUEST/)
    assert.throws(() => parseCoordinatorRequest(JSON.stringify({ action: "nope", protocolVersion: 1 })), /INVALID_REQUEST/)
    assert.throws(() => parseCoordinatorRequest(JSON.stringify({ action: "health", protocolVersion: 2 })), /PROTOCOL_VERSION_UNSUPPORTED/)
  })

  it("rejects invalid task fields and unsafe lengths", () => {
    assert.throws(() => parseCoordinatorRequest(JSON.stringify({ action: "beginTask", protocolVersion: 1, task: { ...task, kind: "delete" } })), /invalid task kind/)
    assert.throws(() => parseCoordinatorRequest(JSON.stringify({ action: "beginTask", protocolVersion: 1, task: { ...task, ttlMs: 1 } })), /invalid ttlMs/)
    assert.throws(() => parseCoordinatorRequest(JSON.stringify({ action: "beginTask", protocolVersion: 1, task: { ...task, summary: "x".repeat(513) } })), /invalid summary/)
  })

  it("validates lease and announcement requests", () => {
    const taskId = "00000000-0000-4000-8000-000000000001"
    const finish = parseCoordinatorRequest(JSON.stringify({ action: "finishTask", protocolVersion: 1, taskId, leaseToken: "token", outcome: "success" }))
    assert.equal(finish.action, "finishTask")
    const announcement = parseCoordinatorRequest(JSON.stringify({ action: "announceTask", protocolVersion: 1, source: "ci", task }))
    assert.equal(announcement.action, "announceTask")
  })
})
