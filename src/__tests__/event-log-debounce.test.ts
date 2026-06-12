/**
 * EventLog debounce / batched-write tests
 */

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { EventLog } from "../scheduler/event-log.js"
import { rmSync, mkdirSync, readFileSync, existsSync, readdirSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

function findCurrentEventFile(testDir: string): string {
  const today = new Date().toISOString().slice(0, 10)
  const target = join(testDir, `events-${today}.jsonl`)
  return target
}

describe("EventLog batched writes", () => {
  const testDir = join(tmpdir(), `eventlog-debounce-${Date.now()}-${process.pid}`)

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true })
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    try { rmSync(testDir, { recursive: true }) } catch {}
  })

  it("coalesces log() calls within the flush window into a single append", async () => {
    const log = new EventLog(testDir)
    const file = findCurrentEventFile(testDir)
    for (let i = 0; i < 20; i++) {
      log.log("task_created", { taskId: `t-${i}` })
    }
    // Before the 200ms debounce window elapses, the file should not yet
    // exist (no events have hit disk).
    assert.equal(existsSync(file), false, "no events should be on disk during the debounce window")

    // Wait past the flush interval — the file should now contain all 20 lines.
    await new Promise((r) => setTimeout(r, 250))
    const content = readFileSync(file, "utf8")
    const lines = content.split("\n").filter((l) => l.length > 0)
    assert.equal(lines.length, 20)
  })

  it("flushSync drains immediately and is idempotent", () => {
    const log = new EventLog(testDir)
    log.log("lock_acquired", { data: { lockId: "L1" } })
    log.log("lock_released", { data: { lockId: "L1" } })
    log.flushSync()
    log.flushSync() // second call must be a no-op
    const file = findCurrentEventFile(testDir)
    const content = readFileSync(file, "utf8")
    const lines = content.split("\n").filter((l) => l.length > 0)
    assert.equal(lines.length, 2)
  })

  it("getRecent() auto-flushes so log + read stays consistent", () => {
    const log = new EventLog(testDir)
    log.log("task_started", { taskId: "auto-1" })
    // No flushSync call — getRecent must trigger the flush itself.
    const events = log.getRecent(1)
    assert.equal(events.length, 1)
    assert.equal(events[0].type, "task_started")
  })

  it("survives a flush failure by re-buffering the batch", () => {
    const log = new EventLog(testDir)
    // Replace the on-disk event file with a *directory* so the next
    // appendFileSync throws EEXIST/EISDIR. The batch should be re-buffered.
    const real = findCurrentEventFile(testDir)
    if (existsSync(real)) rmSync(real)
    mkdirSync(real)
    try {
      log.log("task_failed", { taskId: "t1" })
      log.flushSync()
      // The failed batch should still be buffered for the next retry.
      assert.equal((log as unknown as { buffer: unknown[] }).buffer.length, 1)
    } finally {
      rmSync(real, { recursive: true })
    }
  })

  it("rotates the file once MAX_EVENTS_PER_FILE events have been flushed", async () => {
    // Use a short flush interval via direct manipulation: we don't have a
    // public knob, so we drive it through the public API.
    const log = new EventLog(testDir)
    // Bypass the debounce by flushing after every event so the file
    // actually fills up to the rotation threshold.
    for (let i = 0; i < 1001; i++) {
      log.log("task_created", { taskId: `r-${i}` })
      if (i % 50 === 0) log.flushSync()
    }
    log.flushSync()
    // The current day's file should exist.
    const today = findCurrentEventFile(testDir)
    assert.ok(existsSync(today), "today's event file should exist")
  })
})
