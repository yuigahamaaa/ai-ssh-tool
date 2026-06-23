/**
 * P1-3 Stage 2 / Task 2.3: ExecTaskManager read paths consult the
 * scheduler. After the dual-track merge, the scheduler is the source of
 * truth for tasks. The legacy ExecTaskManager facade exposes a
 * backwards-compatible read API by delegating to the scheduler first
 * and falling back to its own in-memory state and the legacy on-disk
 * format for tasks that pre-date the migration.
 */

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { SchedulerService } from "../scheduler/scheduler-service.js"
import { PersistenceStore } from "../scheduler/persistence-store.js"
import { OutputStore } from "../scheduler/output-store.js"
import { EventLog } from "../scheduler/event-log.js"
import type { ScheduleRequest, TaskRunner } from "../scheduler/types.js"

// Override SSH_TOOL_DATA_DIR before importing exec-task-manager so its module-level
// getTaskStorageDir() picks up a temp dir. Otherwise it would scan the
// developer's real data dir and accumulate unrelated tasks.
const testDataDir = mkdtempSync(join(tmpdir(), "etm-read-home-"))
const origDataDir = process.env.SSH_TOOL_DATA_DIR
process.env.SSH_TOOL_DATA_DIR = testDataDir

function instantRunner(): TaskRunner {
  return {
    start: async (_task, onOutput) => {
      onOutput?.("sched-out", "")
      return { code: 0, stdout: "sched-out", stderr: "" }
    },
    startBackground: () => {},
  }
}

function makeReq(): ScheduleRequest {
  return {
    agent: { id: "a1", name: "a1", clientType: "mcp" },
    host: { id: "h1", profileKey: "default", targetHost: "h1", targetUser: "u", displayName: "h1" },
    sessionId: "test-session",
    command: "echo sched",
    scheduler: "bypass",
  } as ScheduleRequest
}

describe("ExecTaskManager read paths consult scheduler", () => {
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
    tmpDir = mkdtempSync(join(tmpdir(), "etm-read-"))
    mkdirSync(join(tmpDir, "outputs"), { recursive: true })
    const mod = await import(`../exec-task-manager.js?t=${Date.now()}`)
    ExecTaskManager = mod.ExecTaskManager
  })

  afterEach(() => {
    for (const s of schedulers.splice(0)) s.dispose()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("getStatus returns a task that was created via the scheduler", () => {
    const scheduler = makeTrackedScheduler()
    const mgr = new ExecTaskManager({ scheduler })
    try {
      const decision = scheduler.schedule(makeReq())
      assert.equal(decision.action, "run_now")
      const taskId = decision.taskId!
      const status = mgr.getStatus(taskId)
      assert.ok(status, "status found via scheduler delegation")
      assert.equal(status!.id, taskId)
      assert.equal(status!.hostname, "h1")
    } finally {
      scheduler.dispose()
    }
  })

  it("getOutput returns scheduler output for scheduler-created tasks", () => {
    const scheduler = makeTrackedScheduler()
    const mgr = new ExecTaskManager({ scheduler })
    try {
      const decision = scheduler.schedule(makeReq())
      const taskId = decision.taskId!
      return new Promise<void>((resolve) => {
        setImmediate(() => {
          const out = mgr.getOutput(taskId)
          assert.ok(out, "output found via scheduler delegation")
          assert.ok(out!.stdout.includes("sched-out"), "stdout reflects runner output")
          resolve()
        })
      })
    } finally {
      scheduler.dispose()
    }
  })

  it("list() returns scheduler tasks (no local tasks yet)", () => {
    const scheduler = makeTrackedScheduler()
    const mgr = new ExecTaskManager({ scheduler })
    try {
      scheduler.schedule(makeReq())
      scheduler.schedule({ ...makeReq(), command: "echo second" })
      return new Promise<void>((resolve) => {
        setImmediate(() => {
          const all = mgr.list()
          assert.equal(all.length, 2, "both scheduler tasks are listed")
          resolve()
        })
      })
    } finally {
      scheduler.dispose()
    }
  })

  it("list(hostname) filters scheduler tasks by hostname", () => {
    const scheduler = makeTrackedScheduler()
    const mgr = new ExecTaskManager({ scheduler })
    try {
      scheduler.schedule(makeReq())
      scheduler.schedule({
        ...makeReq(),
        host: { id: "h2", profileKey: "default", targetHost: "h2", targetUser: "u", displayName: "h2" },
      })
      return new Promise<void>((resolve) => {
        setImmediate(() => {
          const h1 = mgr.list("h1")
          const h2 = mgr.list("h2")
          assert.equal(h1.length, 1, "h1 has one task")
          assert.equal(h2.length, 1, "h2 has one task")
          assert.equal(h1[0].hostname, "h1")
          assert.equal(h2[0].hostname, "h2")
          resolve()
        })
      })
    } finally {
      scheduler.dispose()
    }
  })

  it("returns null for unknown task ids", () => {
    const scheduler = makeTrackedScheduler()
    const mgr = new ExecTaskManager({ scheduler })
    try {
      assert.equal(mgr.getStatus("never-created"), null)
      assert.equal(mgr.getOutput("never-created"), null)
    } finally {
      scheduler.dispose()
    }
  })

  it("dispose() cleans up the default scheduler without throwing", () => {
    const mgr = new ExecTaskManager()
    mgr.dispose() // must not throw
  })
})
