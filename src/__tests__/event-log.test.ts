/**
 * EventLog Tests
 */

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert"
import { EventLog } from "../event-log.js"
import { rmSync, mkdirSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

describe("EventLog", () => {
  const testDir = join(tmpdir(), `eventlog-test-${Date.now()}`)

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    try { rmSync(testDir, { recursive: true }) } catch {}
  })

  it("logs event and returns recent events", () => {
    const log = new EventLog(testDir)
    log.log("task_created", { taskId: "task-1", hostId: "host-1" })
    log.log("task_started", { taskId: "task-1", hostId: "host-1" })
    
    const events = log.getRecent(10)
    assert.equal(events.length, 2)
    assert.equal(events[0].type, "task_started")
    assert.equal(events[1].type, "task_created")
  })

  it("filters events by hostId", () => {
    const log = new EventLog(testDir)
    log.log("task_created", { taskId: "task-1", hostId: "host-1" })
    log.log("task_created", { taskId: "task-2", hostId: "host-2" })
    
    const events = log.getRecent(10, "host-1")
    assert.equal(events.length, 1)
    assert.equal(events[0].taskId, "task-1")
  })

  it("limits recent events", () => {
    const log = new EventLog(testDir)
    for (let i = 0; i < 10; i++) {
      log.log("task_created", { taskId: `task-${i}` })
    }
    
    const events = log.getRecent(3)
    assert.equal(events.length, 3)
  })

  it("includes event metadata", () => {
    const log = new EventLog(testDir)
    log.log("lock_acquired", { 
      taskId: "task-1", 
      hostId: "host-1", 
      agentId: "agent-1",
      data: { lockId: "lock-1" }
    })
    
    const events = log.getRecent(1)
    assert.ok(events[0].id.startsWith("evt_"))
    assert.ok(events[0].timestamp > 0)
    assert.equal(events[0].data?.lockId, "lock-1")
  })
})
