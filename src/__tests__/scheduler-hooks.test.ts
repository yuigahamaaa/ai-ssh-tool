/**
 * P1-3 Stage 2 / Task 2.5: scheduler lifecycle hooks.
 *
 * Hooks (onTaskCreated / onTaskStarted / onTaskFinished) are the
 * integration surface for the legacy ExecTaskManager facade and any
 * other cross-system bridge. Throwing hooks must not break the
 * scheduler.
 */

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { SchedulerService } from "../scheduler/scheduler-service.js"
import { BatchedPersistenceStore, PersistenceStore } from "../scheduler/persistence-store.js"
import { OutputStore } from "../scheduler/output-store.js"
import { EventLog } from "../scheduler/event-log.js"
import type { ScheduleRequest, ScheduledTask, TaskRunner } from "../scheduler/types.js"

function instantRunner(): TaskRunner {
  return {
    start: async (task, onOutput) => {
      onOutput?.("hello", "")
      return { code: 0, stdout: "hello", stderr: "" }
    },
    startBackground: () => {},
  }
}

function makeReq(overrides?: Partial<ScheduleRequest> & { sessionId?: string }): ScheduleRequest {
  return {
    agent: { id: "agent1", name: "agent1", clientType: "mcp" },
    host: { id: "h1", profileKey: "default", targetHost: "h1", targetUser: "u", displayName: "h1" },
    sessionId: "test-session",
    command: "echo hi",
    scheduler: "bypass",
    ...overrides,
  } as ScheduleRequest
}

describe("SchedulerService hooks", () => {
  let tmpDir: string

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "scheduler-hooks-"))
  })

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("invokes onTaskCreated synchronously during schedule()", () => {
    const calls: string[] = []
    const svc = new SchedulerService({
      persistence: new PersistenceStore(tmpDir),
      runner: instantRunner(),
      outputStore: new OutputStore(join(tmpDir, "outputs")),
      eventLog: new EventLog(join(tmpDir, "events")),
      hooks: {
        onTaskCreated: (task) => calls.push(`created:${task.id}`),
        onTaskStarted: (task) => calls.push(`started:${task.id}`),
        onTaskFinished: (task) => calls.push(`finished:${task.id}:${task.status}`),
      },
    })
    try {
      const decision = svc.schedule(makeReq())
      assert.equal(decision.action, "run_now")
      assert.deepEqual(calls.slice(0, 1), [`created:${decision.taskId}`])
      // start/finish are async via the runner, so we need to wait
      return new Promise<void>((resolve) => {
        setImmediate(() => {
          assert.ok(calls.some((c) => c.startsWith("started:")), "onTaskStarted fired")
          assert.ok(calls.some((c) => c.startsWith("finished:")), "onTaskFinished fired")
          resolve()
        })
      })
    } finally {
      svc.dispose()
    }
  })

  it("swallows a throwing hook without breaking the scheduler", () => {
    const svc = new SchedulerService({
      persistence: new PersistenceStore(tmpDir),
      runner: instantRunner(),
      outputStore: new OutputStore(join(tmpDir, "outputs")),
      eventLog: new EventLog(join(tmpDir, "events")),
      hooks: {
        onTaskCreated: () => {
          throw new Error("hook boom")
        },
        onTaskStarted: () => {
          throw new Error("hook boom")
        },
        onTaskFinished: () => {
          throw new Error("hook boom")
        },
      },
    })
    try {
      const decision = svc.schedule(makeReq())
      assert.equal(decision.action, "run_now")
      // Task should still complete normally
      return new Promise<void>((resolve, reject) => {
        setImmediate(() => {
          const task = svc.getTask(decision.taskId!)
          try {
            assert.ok(task, "task exists despite throwing hooks")
            assert.equal(task!.status, "completed", "task completed despite throwing hooks")
            resolve()
          } catch (e) {
            reject(e)
          }
        })
      })
    } finally {
      svc.dispose()
    }
  })

  it("supports only a subset of hooks (others are no-ops)", () => {
    const createdCalls: ScheduledTask[] = []
    const svc = new SchedulerService({
      persistence: new PersistenceStore(tmpDir),
      runner: instantRunner(),
      outputStore: new OutputStore(join(tmpDir, "outputs")),
      eventLog: new EventLog(join(tmpDir, "events")),
      hooks: {
        onTaskCreated: (task) => createdCalls.push(task),
        // onTaskStarted and onTaskFinished intentionally omitted
      },
    })
    try {
      svc.schedule(makeReq())
      assert.equal(createdCalls.length, 1)
    } finally {
      svc.dispose()
    }
  })
})
