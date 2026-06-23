import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { PersistenceStore, BatchedPersistenceStore } from "../scheduler/persistence-store.js"
import type { ScheduledTask } from "../scheduler/types.js"
import { mkdtempSync, rmSync, readdirSync, existsSync, readFileSync } from "fs"
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
  // We keep a reference to the underlying `inner` purely for API compatibility
  // (the constructor still takes one to learn the base directory). The actual
  // disk writes now go through `super.saveTask` on the *batched* instance
  // itself, so the test reads from `batch` — not from a separate `inner`.
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
    batch.saveTask(makeTask("a"))
    batch.saveTask(makeTask("b"))
    batch.saveTask(makeTask("c"))
    assert.equal(batch.pendingCount, 3)
    // No files yet — only after the timer fires.
    assert.equal(readdirSync(join(tmpDir, "tasks")).length, 0)
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(batch.pendingCount, 0)
    const files = readdirSync(join(tmpDir, "tasks"))
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
    const files = readdirSync(join(tmpDir, "tasks"))
    assert.equal(files.length, 1)
    const loaded = batch.loadTask("a")
    assert.equal(loaded?.status, "completed")
  })

  it("flushSync drains the queue immediately", () => {
    batch.saveTask(makeTask("a"))
    batch.saveTask(makeTask("b"))
    assert.equal(batch.pendingCount, 2)
    batch.flushSync()
    assert.equal(batch.pendingCount, 0)
    assert.equal(readdirSync(join(tmpDir, "tasks")).length, 2)
  })

  it("flushSync is safe to call when nothing is pending", () => {
    batch.flushSync()
    batch.flushSync()
    assert.equal(batch.pendingCount, 0)
  })

  it("survives an inner saveTask error and re-queues the task", () => {
    // Simulate a disk failure by overriding the inherited saveTask. The
    // batched wrapper should re-queue the failed task and keep going.
    const original = Object.getPrototypeOf(Object.getPrototypeOf(batch)).saveTask
    let threw = false
    Object.getPrototypeOf(Object.getPrototypeOf(batch)).saveTask = function (task: ScheduledTask) {
      if (task.id === "bad") {
        threw = true
        throw new Error("disk full")
      }
      return original.call(this, task)
    }
    try {
      batch.saveTask(makeTask("ok"))
      batch.saveTask(makeTask("bad"))
      batch.flushSync()
      // "ok" went through, "bad" was re-queued for the next flush.
      assert.equal(batch.pendingCount, 1)
      assert.ok(threw, "super.saveTask should have been called for the failing task")
      assert.ok(existsSync(join(tmpDir, "tasks", "ok.json")))
    } finally {
      Object.getPrototypeOf(Object.getPrototypeOf(batch)).saveTask = original
    }
  })

  it("inherits read-side methods from PersistenceStore", () => {
    // loadAllTasks, restore, saveVirtualCwdMap, loadVirtualCwdMap must all
    // work directly on the batched instance.
    batch.saveTask(makeTask("queued-1", "queued"))
    batch.saveTask(makeTask("running-1", "running"))
    batch.flushSync()

    // restore() should pick up the running task as stale and the queued
    // task as queued. The batched instance is itself a PersistenceStore,
    // so the call is straightforward.
    const restored = batch.restore()
    const ids = new Set(restored.queued.map((t) => t.id))
    assert.ok(ids.has("queued-1"))
    const staleIds = new Set(restored.stale.map((t) => t.id))
    assert.ok(staleIds.has("running-1"))
  })

  it("shares on-disk layout with the inner store (no path duplication)", () => {
    // The wrapper must not create a second scheduler directory
    // on top of the inner one. Verifying with a shared baseDir: a file
    // written via the inner is visible to batch.loadTask, and vice versa.
    batch.saveTask(makeTask("shared"))
    batch.flushSync()
    // Inner was constructed with the same tmpDir, so the same path layout.
    const innerLoaded = inner.loadTask("shared")
    assert.ok(innerLoaded, "inner should see what batch wrote")
  })
})

describe("PersistenceStore: machine-read JSON", () => {
  let tmpDir: string
  let store: PersistenceStore

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "persist-format-"))
    store = new PersistenceStore(tmpDir)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("writes task files without indentation (single line)", () => {
    store.saveTask(makeTask("compact-1"))
    const content = readFileSync(join(tmpDir, "tasks", "compact-1.json"), "utf8")
    // Pretty-print would put a newline right after the opening `{`. The
    // compact form should be on a single line.
    assert.ok(!content.includes("\n"), `expected single-line JSON, got:\n${content}`)
    // Sanity: it is still valid JSON and round-trips.
    const parsed = JSON.parse(content)
    assert.equal(parsed.id, "compact-1")
  })

  it("writes virtual-cwd map without indentation", () => {
    store.saveVirtualCwdMap({
      entry1: { key: "entry1", agentId: "a1", hostId: "h1", cwd: "/tmp", updatedAt: 1 },
    })
    const content = readFileSync(join(tmpDir, "state", "virtual-cwd.json"), "utf8")
    assert.ok(!content.includes("\n"))
  })
})
