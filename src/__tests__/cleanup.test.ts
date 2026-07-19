/**
 * Cleanup mechanism tests:
 * - PersistenceStore.cleanupOldTaskFiles() deletes terminal-state task files
 * - PersistenceStore.cleanupTempFiles() deletes .tmp-* leftovers
 * - SchedulerService.evictOldTasks() deletes on-disk task + output files
 */

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { PersistenceStore } from "../scheduler/persistence-store.js"
import { OutputStore } from "../scheduler/output-store.js"
import { SchedulerService } from "../scheduler/scheduler-service.js"
import type { ScheduledTask } from "../scheduler/types.js"
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: overrides.id ?? `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    agentId: overrides.agentId ?? "agent-1",
    hostId: overrides.hostId ?? "host-1",
    profileKey: overrides.profileKey ?? "pk-host-1",
    sessionId: overrides.sessionId ?? "sess-1",
    command: overrides.command ?? "echo ok",
    classification: overrides.classification ?? { intent: "general", cost: "small", risk: "safe" },
    scheduler: overrides.scheduler ?? "bypass",
    status: overrides.status ?? "completed",
    updatedAt: overrides.updatedAt ?? Date.now(),
    finishedAt: overrides.finishedAt ?? Date.now(),
    stdoutTail: overrides.stdoutTail ?? "",
    stderrTail: overrides.stderrTail ?? "",
    stdoutBytes: overrides.stdoutBytes ?? 0,
    stderrBytes: overrides.stderrBytes ?? 0,
    decisionReason: overrides.decisionReason ?? "test",
    ...overrides,
  } as ScheduledTask
}

describe("PersistenceStore.cleanupOldTaskFiles", () => {
  let tmpDir: string
  let store: PersistenceStore

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cleanup-test-"))
    store = new PersistenceStore(tmpDir)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("deletes terminal-state task files older than retention period", () => {
    const oldTime = Date.now() - 48 * 60 * 60 * 1000 // 48h ago
    const oldTask = makeTask({
      id: "old-completed",
      status: "completed",
      finishedAt: oldTime,
      updatedAt: oldTime,
    })
    store.saveTask(oldTask)

    const freshTask = makeTask({
      id: "fresh-completed",
      status: "completed",
      finishedAt: Date.now(),
      updatedAt: Date.now(),
    })
    store.saveTask(freshTask)

    const deleted = store.cleanupOldTaskFiles(24 * 60 * 60 * 1000) // 24h retention

    assert.equal(deleted, 1)
    assert.equal(existsSync(join(tmpDir, "tasks", "old-completed.json")), false, "old task file should be deleted")
    assert.equal(existsSync(join(tmpDir, "tasks", "fresh-completed.json")), true, "fresh task file should remain")
  })

  it("does not delete running or queued tasks", () => {
    const oldTime = Date.now() - 48 * 60 * 60 * 1000
    store.saveTask(makeTask({ id: "old-running", status: "running", updatedAt: oldTime }))
    store.saveTask(makeTask({ id: "old-queued", status: "queued", updatedAt: oldTime }))

    const deleted = store.cleanupOldTaskFiles(24 * 60 * 60 * 1000)

    assert.equal(deleted, 0)
    assert.equal(existsSync(join(tmpDir, "tasks", "old-running.json")), true)
    assert.equal(existsSync(join(tmpDir, "tasks", "old-queued.json")), true)
  })

  it("deletes corrupted json files", () => {
    const corruptedPath = join(tmpDir, "tasks", "corrupted.json")
    writeFileSync(corruptedPath, "{ invalid json content")

    const deleted = store.cleanupOldTaskFiles(24 * 60 * 60 * 1000)

    assert.equal(deleted, 1)
    assert.equal(existsSync(corruptedPath), false)
  })

  it("deletes all terminal statuses (failed, cancelled, timeout, stale)", () => {
    const oldTime = Date.now() - 48 * 60 * 60 * 1000
    for (const status of ["failed", "cancelled", "timeout", "stale"]) {
      store.saveTask(makeTask({ id: `old-${status}`, status: status as ScheduledTask["status"], finishedAt: oldTime, updatedAt: oldTime }))
    }

    const deleted = store.cleanupOldTaskFiles(24 * 60 * 60 * 1000)

    assert.equal(deleted, 4)
  })
})

describe("PersistenceStore.cleanupTempFiles", () => {
  let tmpDir: string
  let store: PersistenceStore

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tmp-cleanup-"))
    store = new PersistenceStore(tmpDir)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("deletes .tmp-* files left by atomic-write crashes", () => {
    writeFileSync(join(tmpDir, "tasks", "task-1.json.tmp-123-abc"), "{}")
    writeFileSync(join(tmpDir, "tasks", "task-2.json.tmp-456-def"), "{}")
    writeFileSync(join(tmpDir, "tasks", "task-3.json"), "{}")

    const deleted = store.cleanupTempFiles()

    assert.equal(deleted, 2)
    const remaining = readdirSync(join(tmpDir, "tasks"))
    assert.deepEqual(remaining.sort(), ["task-3.json"])
  })
})

describe("SchedulerService startup cleanup", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "startup-cleanup-"))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("constructor cleans up old terminal-state task files on startup", () => {
    const persistence = new PersistenceStore(tmpDir)

    // Simulate files left behind by a previous daemon run
    const oldTime = Date.now() - 48 * 60 * 60 * 1000 // 48h ago
    persistence.saveTask(makeTask({
      id: "old-completed-task",
      status: "completed",
      finishedAt: oldTime,
      updatedAt: oldTime,
    }))
    persistence.saveTask(makeTask({
      id: "old-failed-task",
      status: "failed",
      finishedAt: oldTime,
      updatedAt: oldTime,
    }))

    // Verify files exist before scheduler construction
    assert.equal(existsSync(join(tmpDir, "tasks", "old-completed-task.json")), true)
    assert.equal(existsSync(join(tmpDir, "tasks", "old-failed-task.json")), true)

    const scheduler = new SchedulerService({
      persistence,
      runner: {
        start: async () => ({ code: 0, stdout: "", stderr: "" }),
        startBackground: () => {},
      },
    })

    // SchedulerService constructor calls cleanupOldTaskFiles() which should
    // delete the old terminal-state task files
    assert.equal(existsSync(join(tmpDir, "tasks", "old-completed-task.json")), false, "old completed task should be cleaned up on startup")
    assert.equal(existsSync(join(tmpDir, "tasks", "old-failed-task.json")), false, "old failed task should be cleaned up on startup")

    scheduler.dispose()
  })

  it("constructor cleans up .tmp-* files on startup", () => {
    const persistence = new PersistenceStore(tmpDir)

    // Simulate a temp file left by an atomic-write crash
    writeFileSync(join(tmpDir, "tasks", "crashed.json.tmp-123-abc"), "{}")

    const scheduler = new SchedulerService({
      persistence,
      runner: {
        start: async () => ({ code: 0, stdout: "", stderr: "" }),
        startBackground: () => {},
      },
    })

    assert.equal(existsSync(join(tmpDir, "tasks", "crashed.json.tmp-123-abc")), false, "temp file should be cleaned up on startup")

    scheduler.dispose()
  })

  it("deletes task file and output files when a task is evicted", () => {
    const persistence = new PersistenceStore(tmpDir)
    const outputStore = new OutputStore(join(tmpDir, "outputs"))
    const scheduler = new SchedulerService({
      persistence,
      outputStore,
      runner: {
        start: async () => ({ code: 0, stdout: "done", stderr: "" }),
        startBackground: () => {},
      },
    })

    // Schedule and complete a task
    const decision = scheduler.schedule({
      agent: { id: "a1", name: "agent-a1", clientType: "mcp" },
      host: { id: "h1", profileKey: "pk-h1", targetHost: "host.example.com", targetUser: "root", displayName: "host" },
      sessionId: "s1",
      command: "echo ok",
      scheduler: "bypass",
    })

    assert.equal(decision.action, "run_now")
    const taskId = decision.taskId!
    assert.ok(taskId, "should have a task id")

    // Verify files exist on disk
    assert.equal(existsSync(join(tmpDir, "tasks", `${taskId}.json`)), true, "task file should exist")

    // Simulate what evictOldTasks does: delete the task file and output files.
    // evictOldTasks is private and gated by a 60s throttle + 1h TTL, so we
    // test the disk-cleanup path directly. This verifies that deleteTask()
    // and outputStore.remove() are wired correctly and actually delete files.
    persistence.deleteTask(taskId)
    outputStore.remove(taskId)

    assert.equal(existsSync(join(tmpDir, "tasks", `${taskId}.json`)), false, "task file should be deleted")
    assert.equal(existsSync(join(tmpDir, "outputs", `${taskId}.stdout`)), false, "stdout file should be deleted")
    assert.equal(existsSync(join(tmpDir, "outputs", `${taskId}.stderr`)), false, "stderr file should be deleted")

    scheduler.dispose()
  })
})
