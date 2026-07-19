/**
 * EventLog Tests
 */

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert"
import { EventLog } from "../scheduler/event-log.js"
import { rmSync, mkdirSync, writeFileSync, existsSync, readdirSync, utimesSync } from "fs"
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

  it("rotates to numbered suffix when current file exceeds MAX_EVENTS_PER_FILE", () => {
    // Pre-fill the base file with 1000 events so the next EventLog
    // construction detects it as full and advances to .1 suffix.
    const dateStr = new Date().toISOString().slice(0, 10)
    const basePath = join(testDir, `events-${dateStr}.jsonl`)
    const lines: string[] = []
    for (let i = 0; i < 1000; i++) {
      lines.push(JSON.stringify({ id: `evt_${i}`, type: "task_created", timestamp: Date.now() }) + "\n")
    }
    writeFileSync(basePath, lines.join(""), { mode: 0o600 })

    const log = new EventLog(testDir)
    log.log("task_created", { taskId: "task-new", hostId: "host-1" })
    log.flushSync()

    // The new event should be in events-YYYY-MM-DD.1.jsonl, not the base file
    const rotatedPath = join(testDir, `events-${dateStr}.1.jsonl`)
    assert.equal(existsSync(rotatedPath), true, "rotated file should exist")
    assert.equal(existsSync(basePath), true, "base file should still exist")

    const events = log.getRecent(1)
    assert.equal(events.length, 1)
    assert.equal(events[0].taskId, "task-new")
  })

  it("continues appending to existing non-full file on startup", () => {
    const dateStr = new Date().toISOString().slice(0, 10)
    const basePath = join(testDir, `events-${dateStr}.jsonl`)
    writeFileSync(basePath, JSON.stringify({ id: "evt_0", type: "task_created", timestamp: Date.now() }) + "\n", { mode: 0o600 })

    const log = new EventLog(testDir)
    log.log("task_started", { taskId: "task-1", hostId: "host-1" })
    log.flushSync()

    // Both the pre-existing event and the new one should be in the same base file
    const events = log.getRecent(10)
    assert.equal(events.length, 2)
  })

  it("cleanupOldFiles deletes event files older than retention period", () => {
    const oldFile = join(testDir, `events-2020-01-01.jsonl`)
    writeFileSync(oldFile, JSON.stringify({ id: "evt_old", type: "task_created", timestamp: 0 }) + "\n", { mode: 0o600 })

    // Set mtime to 60 days ago
    const oldTime = Date.now() / 1000 - 60 * 24 * 60 * 60
    utimesSync(oldFile, oldTime, oldTime)

    // EventLog constructor calls cleanupOldFiles() which should delete the old file
    const log = new EventLog(testDir)

    assert.equal(existsSync(oldFile), false, "old event file should be deleted by constructor cleanup")
  })

  it("cleanupOldFiles can be called manually with custom retention", () => {
    // Create the EventLog first (it creates today's file)
    const log = new EventLog(testDir)

    // Now create an old file AFTER construction
    const oldFile = join(testDir, `events-2020-01-01.jsonl`)
    writeFileSync(oldFile, JSON.stringify({ id: "evt_old", type: "task_created", timestamp: 0 }) + "\n", { mode: 0o600 })
    const oldTime = Date.now() / 1000 - 60 * 24 * 60 * 60
    utimesSync(oldFile, oldTime, oldTime)

    const deleted = log.cleanupOldFiles(30)

    assert.equal(deleted, 1)
    assert.equal(existsSync(oldFile), false, "old event file should be deleted")
  })
})
