/**
 * LockManager Tests
 */

import { describe, it } from "node:test"
import assert from "node:assert"
import { LockManager } from "../scheduler/lock-manager.js"

describe("LockManager", () => {
  it("acquires lock when no conflict", () => {
    const lm = new LockManager()
    // acquire(scope, key, hostId, agentId, taskId?, reason?)
    const lock = lm.acquire("host", "host-1", "host-1", "agent-1", "task-1")
    assert.ok(lock)
    assert.equal(lock?.scope, "host")
    assert.equal(lock?.ownerAgentId, "agent-1")
  })

  it("rejects lock when host already locked by another agent", () => {
    const lm = new LockManager()
    lm.acquire("host", "host-1", "host-1", "agent-1", "task-1")
    const lock2 = lm.acquire("host", "host-1", "host-1", "agent-2", "task-2")
    assert.equal(lock2, null)
  })

  it("allows same agent to renew lock", () => {
    const lm = new LockManager()
    const lock1 = lm.acquire("host", "host-1", "host-1", "agent-1", "task-1")
    const lock2 = lm.acquire("host", "host-1", "host-1", "agent-1", "task-1")
    assert.ok(lock2)
    assert.equal(lock1?.id, lock2?.id)
  })

  it("releases lock by id", () => {
    const lm = new LockManager()
    const lock = lm.acquire("host", "host-1", "host-1", "agent-1", "task-1")
    const released = lm.release(lock!.id)
    assert.ok(released)
    const lock2 = lm.acquire("host", "host-1", "host-1", "agent-2", "task-2")
    assert.ok(lock2)
  })

  it("releases locks for task", () => {
    const lm = new LockManager()
    lm.acquire("host", "host-1", "agent-1", "task-1")
    lm.acquire("workdir", "/repo", "host-1", "agent-1", "task-1")
    lm.releaseForTask("task-1")
    const locks = lm.getLocksForHost("host-1")
    assert.equal(locks.length, 0)
  })

  it("workdir lock prevents concurrent mutations", () => {
    const lm = new LockManager()
    lm.acquire("workdir", "/repo", "host-1", "agent-1", "task-1")
    const lock2 = lm.acquire("workdir", "/repo", "host-1", "agent-2", "task-2")
    assert.equal(lock2, null)
  })

  it("different workdirs allow concurrent locks", () => {
    const lm = new LockManager()
    lm.acquire("workdir", "/repo-a", "host-1", "agent-1", "task-1")
    const lock2 = lm.acquire("workdir", "/repo-b", "host-1", "agent-2", "task-2")
    assert.ok(lock2)
  })

  it("returns conflicting locks", () => {
    const lm = new LockManager()
    lm.acquire("workdir", "/repo", "host-1", "agent-1", "task-1")
    const conflicts = lm.getConflictingLocks("workdir", "/repo", "host-1")
    assert.equal(conflicts.length, 1)
  })
})
