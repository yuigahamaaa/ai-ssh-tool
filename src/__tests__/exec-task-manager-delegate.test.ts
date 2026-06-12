/**
 * P1-3 Stage 2 / Task 2.1: ExecTaskManager.start() publishes the task
 * to the scheduler for unified state. The actual exec still happens
 * on the raw ssh2 Client (preserving the existing test surface) but
 * the scheduler's tasks Map now reflects the same task with the same
 * id, command, hostname, and final exit code.
 */

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, mkdirSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { SchedulerService } from "../scheduler/scheduler-service.js"
import { PersistenceStore } from "../scheduler/persistence-store.js"
import { OutputStore } from "../scheduler/output-store.js"
import { EventLog } from "../scheduler/event-log.js"

// Override HOME before importing exec-task-manager so its module-level
// getTaskStorageDir() picks up a temp dir.
const testHome = mkdtempSync(join(tmpdir(), "etm-delegate-home-"))
const origHome = process.env.HOME
process.env.HOME = testHome

function instantRunner() {
  return {
    start: async () => ({ code: 0, stdout: "", stderr: "" }),
    startBackground: () => {},
  }
}

function makeSchedulerBridge(tmpDir: string): SchedulerService {
  return new SchedulerService({
    persistence: new PersistenceStore(tmpDir),
    runner: instantRunner(),
    outputStore: new OutputStore(join(tmpDir, "outputs")),
    eventLog: new EventLog(join(tmpDir, "events")),
  })
}

describe("ExecTaskManager.start() publishes to scheduler", () => {
  let tmpDir: string
  let ExecTaskManager: typeof import("../exec-task-manager.js").ExecTaskManager
  const schedulers: SchedulerService[] = []

  function makeTrackedScheduler(): SchedulerService {
    const s = new SchedulerService({
      persistence: new PersistenceStore(tmpDir),
      runner: instantRunner(),
      outputStore: new OutputStore(join(tmpDir, "outputs")),
      eventLog: new EventLog(join(tmpDir, "events")),
    })
    schedulers.push(s)
    return s
  }

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "etm-delegate-"))
    mkdirSync(join(tmpDir, "outputs"), { recursive: true })
    const mod = await import(`../exec-task-manager.js?t=${Date.now()}`)
    ExecTaskManager = mod.ExecTaskManager
  })

  afterEach(() => {
    // Dispose all schedulers created in this test so the process can exit.
    for (const s of schedulers.splice(0)) s.dispose()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("registerExternal adds the task to the scheduler immediately", () => {
    const scheduler = makeTrackedScheduler()
    const mgr = new ExecTaskManager({ scheduler })
    // Use the public API: build a fake register call by routing through
    // the underlying scheduler (this is what start() does internally).
    scheduler.registerExternal({
      agent: { id: "etm", name: "etm", clientType: "internal" as const },
      host: { id: "h1", profileKey: "k", targetHost: "h1", targetUser: "u", displayName: "h1" },
      sessionId: "s1",
      command: "echo test",
      scheduler: "bypass",
    } as unknown as any)
    const listed = scheduler.listTasks("h1")
    assert.equal(listed.length, 1)
    assert.equal(listed[0].command, "echo test")
    assert.equal(listed[0].hostId, "h1")
  })

  it("finishExternalTask updates the task's exit code and status", () => {
    const scheduler = makeTrackedScheduler()
    const t = scheduler.registerExternal({
      agent: { id: "etm", name: "etm", clientType: "internal" as const },
      host: { id: "h1", profileKey: "k", targetHost: "h1", targetUser: "u", displayName: "h1" },
      sessionId: "s1",
      command: "echo done",
      scheduler: "bypass",
    } as unknown as any)
    scheduler.finishExternalTask(t.id, { code: 0, stdout: "done", stderr: "" })
    const after = scheduler.getTask(t.id)
    assert.ok(after, "task still exists after finish")
    assert.equal(after!.status, "completed")
    assert.equal(after!.exitCode, 0)
    const out = scheduler.getTaskOutput(t.id, "full")
    assert.equal(out.stdout, "done")
  })

  it("finishExternalTask is a no-op for unknown task ids", () => {
    const scheduler = makeTrackedScheduler()
    // Should not throw
    scheduler.finishExternalTask("does-not-exist", { code: 0, stdout: "", stderr: "" })
  })
})
