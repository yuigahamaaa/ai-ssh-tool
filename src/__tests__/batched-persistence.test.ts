import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { PersistenceStore, BatchedPersistenceStore } from "../scheduler/persistence-store.js"
import type { ScheduledTask } from "../scheduler/types.js"
import { mkdtempSync, rmSync, readdirSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

function makeTask(id: string, status: ScheduledTask["status"] = "completed"): ScheduledTask {
  return {
    id,
    agentId: "agent-a",
    hostId: "host-1",
    profileKey: "pk-1",
    sessionId: "sess-1",
    command: "echo ok",
    classification: { intent: "inspect", cost: "tiny", blocking: false, mutates: false, risky: false, source: "auto", reason: "test" },
    scheduler: "auto",
    status,
    updatedAt: Date.now(),
  } as ScheduledTask
}

describe("BatchedPersistenceStore", () => {
  let tmpDir: string
  let inner: PersistenceStore
  let batch: BatchedPersistenceStore

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "batched-persist-"))
    inner = new PersistenceStore(tmpDir)
    batch = new BatchedPersistenceStore(inner, 50)
  })

  afterEach(() => {
    batch.flushSync()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("coalesces multiple saveTask calls within the flush window", async () => {
    // All three writes happen synchronously; the flush timer fires once.
    batch.saveTask(makeTask("a"))
    batch.saveTask(makeTask("b"))
    batch.saveTask(makeTask("c"))
    assert.equal(batch.pendingCount, 3)
    // No files yet — only after the timer fires.
    assert.equal(readdirSync(tmpDir + "/tasks").length, 0)
    // Wait past the flush interval.
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(batch.pendingCount, 0)
    const files = readdirSync(tmpDir + "/tasks")
    assert.equal(files.length, 3)
    assert.ok(files.includes("a.json"))
    assert.ok(files.includes("b.json"))
    assert.ok(files.includes("c.json"))
  })

  it("overwrites previous snapshot for the same task id in a window", async () => {
    const t1 = makeTask("a", "running")
    const t2 = makeTask("a", "completed")
    batch.saveTask(t1)
    batch.saveTask(t2)
    await new Promise((r) => setTimeout(r, 100))
    // Only one file should exist, with the latest status.
    const files = readdirSync(tmpDir + "/tasks")
    assert.equal(files.length, 1)
    const loaded = inner.loadTask("a")
    assert.equal(loaded?.status, "completed")
  })

  it("flushSync drains the queue immediately", () => {
    batch.saveTask(makeTask("a"))
    batch.saveTask(makeTask("b"))
    assert.equal(batch.pendingCount, 2)
    batch.flushSync()
    assert.equal(batch.pendingCount, 0)
    assert.equal(readdirSync(tmpDir + "/tasks").length, 2)
  })

  it("flushSync is safe to call when nothing is pending", () => {
    batch.flushSync()
    batch.flushSync()
    assert.equal(batch.pendingCount, 0)
  })

  it("survives an inner saveTask error and re-queues the task", () => {
    // Break the inner store by closing the directory's permissions? We
    // simulate a failure by making inner.saveTask throw on a specific id,
    // then verifying the task is re-queued.
    const original = inner.saveTask.bind(inner)
    let threw = false
    inner.saveTask = (task) => {
      if (task.id === "bad") {
        threw = true
        throw new Error("disk full")
      }
      original(task)
    }
    batch.saveTask(makeTask("ok"))
    batch.saveTask(makeTask("bad"))
    batch.flushSync()
    // "ok" went through, "bad" was re-queued for the next flush.
    assert.equal(batch.pendingCount, 1)
    assert.ok(threw, "inner saveTask should have been called for the failing task")
    assert.ok(existsSync(join(tmpDir, "tasks", "ok.json")))
  })
})
