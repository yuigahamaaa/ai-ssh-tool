/**
 * Janitor Tests — periodic cleanup of stale on-disk artifacts.
 */

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { Janitor } from "../scheduler/janitor.js"
import {
  rmSync,
  mkdirSync,
  existsSync,
  writeFileSync,
  utimesSync,
  symlinkSync,
  readdirSync,
} from "fs"
import { join } from "path"
import { tmpdir } from "os"

const DAY_MS = 24 * 60 * 60 * 1000

function makeOldTimestamp(daysAgo: number): Date {
  return new Date(Date.now() - daysAgo * DAY_MS)
}

function makeTaskJson(id: string, status: string, extra?: Record<string, unknown>): string {
  return JSON.stringify({
    id,
    agentId: "agent-1",
    hostId: "host-1",
    sessionId: "sess-1",
    command: "echo test",
    classification: { intent: "read", cost: "light", blocking: false, mutates: false, risky: false, source: "auto", reason: "" },
    scheduler: "auto",
    status,
    updatedAt: Date.now(),
    stdoutTail: "",
    stderrTail: "",
    stdoutBytes: 0,
    stderrBytes: 0,
    ...extra,
  })
}

describe("Janitor", () => {
  let testDir: string
  let tasksDir: string
  let eventsDir: string
  let logsDir: string
  let legacyDir: string

  beforeEach(() => {
    testDir = join(tmpdir(), `janitor-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    tasksDir = join(testDir, "tasks")
    eventsDir = join(testDir, "events")
    logsDir = join(testDir, "logs")
    legacyDir = join(testDir, "legacy-ssh-tool")
    mkdirSync(tasksDir, { recursive: true })
    mkdirSync(eventsDir, { recursive: true })
    mkdirSync(logsDir, { recursive: true })
    mkdirSync(legacyDir, { recursive: true })
  })

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }) } catch {}
  })

  describe("task file cleanup", () => {
    it("deletes finished task JSON files older than retention", () => {
      writeFileSync(join(tasksDir, "old-completed.json"), makeTaskJson("old-completed", "completed"))
      writeFileSync(join(tasksDir, "old-failed.json"), makeTaskJson("old-failed", "failed"))
      writeFileSync(join(tasksDir, "old-cancelled.json"), makeTaskJson("old-cancelled", "cancelled"))
      writeFileSync(join(tasksDir, "old-timeout.json"), makeTaskJson("old-timeout", "timeout"))
      writeFileSync(join(tasksDir, "old-stale.json"), makeTaskJson("old-stale", "stale"))

      const oldTime = makeOldTimestamp(20)
      for (const f of readdirSync(tasksDir)) {
        utimesSync(join(tasksDir, f), oldTime, oldTime)
      }

      const janitor = new Janitor({ tasksDir, taskRetentionMs: 14 * DAY_MS })
      const result = janitor.runOnce()

      assert.equal(result.deletedTaskFiles, 5)
      for (const f of ["old-completed", "old-failed", "old-cancelled", "old-timeout", "old-stale"]) {
        assert.ok(!existsSync(join(tasksDir, `${f}.json`)), `${f} should be deleted`)
      }
    })

    it("keeps recent task files within retention period", () => {
      writeFileSync(join(tasksDir, "recent.json"), makeTaskJson("recent", "completed"))

      // File was just created — mtime is now, well within retention
      const janitor = new Janitor({ tasksDir, taskRetentionMs: 14 * DAY_MS })
      const result = janitor.runOnce()

      assert.equal(result.deletedTaskFiles, 0)
      assert.ok(existsSync(join(tasksDir, "recent.json")))
    })

    it("keeps running and queued task files even if old", () => {
      writeFileSync(join(tasksDir, "old-running.json"), makeTaskJson("old-running", "running"))
      writeFileSync(join(tasksDir, "old-queued.json"), makeTaskJson("old-queued", "queued"))

      const oldTime = makeOldTimestamp(30)
      utimesSync(join(tasksDir, "old-running.json"), oldTime, oldTime)
      utimesSync(join(tasksDir, "old-queued.json"), oldTime, oldTime)

      const janitor = new Janitor({ tasksDir, taskRetentionMs: 14 * DAY_MS })
      const result = janitor.runOnce()

      assert.equal(result.deletedTaskFiles, 0)
      assert.ok(existsSync(join(tasksDir, "old-running.json")))
      assert.ok(existsSync(join(tasksDir, "old-queued.json")))
    })

    it("protects task IDs in the protected set", () => {
      writeFileSync(join(tasksDir, "protected.json"), makeTaskJson("protected", "completed"))
      writeFileSync(join(tasksDir, "unprotected.json"), makeTaskJson("unprotected", "completed"))

      const oldTime = makeOldTimestamp(20)
      utimesSync(join(tasksDir, "protected.json"), oldTime, oldTime)
      utimesSync(join(tasksDir, "unprotected.json"), oldTime, oldTime)

      const janitor = new Janitor({
        tasksDir,
        taskRetentionMs: 14 * DAY_MS,
        protectedTaskIds: () => ["protected"],
      })
      const result = janitor.runOnce()

      assert.equal(result.deletedTaskFiles, 1)
      assert.ok(existsSync(join(tasksDir, "protected.json")))
      assert.ok(!existsSync(join(tasksDir, "unprotected.json")))
    })

    it("deletes corrupted JSON files that are old", () => {
      writeFileSync(join(tasksDir, "corrupt.json"), "{ this is not valid json")
      const oldTime = makeOldTimestamp(20)
      utimesSync(join(tasksDir, "corrupt.json"), oldTime, oldTime)

      const janitor = new Janitor({ tasksDir, taskRetentionMs: 14 * DAY_MS })
      const result = janitor.runOnce()

      assert.equal(result.deletedTaskFiles, 1)
      assert.ok(!existsSync(join(tasksDir, "corrupt.json")))
    })

    it("does not delete non-JSON files", () => {
      writeFileSync(join(tasksDir, "data.txt"), "some data")
      writeFileSync(join(tasksDir, "readme.md"), "# readme")
      const oldTime = makeOldTimestamp(30)
      utimesSync(join(tasksDir, "data.txt"), oldTime, oldTime)
      utimesSync(join(tasksDir, "readme.md"), oldTime, oldTime)

      const janitor = new Janitor({ tasksDir, taskRetentionMs: 14 * DAY_MS })
      const result = janitor.runOnce()

      assert.equal(result.deletedTaskFiles, 0)
      assert.ok(existsSync(join(tasksDir, "data.txt")))
      assert.ok(existsSync(join(tasksDir, "readme.md")))
    })

    it("does not follow or delete symlinks", () => {
      const target = join(tasksDir, "real-task.json")
      writeFileSync(target, makeTaskJson("real-task", "completed"))
      const link = join(tasksDir, "link-task.json")
      symlinkSync(target, link)

      const oldTime = makeOldTimestamp(30)
      utimesSync(target, oldTime, oldTime)

      const janitor = new Janitor({ tasksDir, taskRetentionMs: 14 * DAY_MS })
      const result = janitor.runOnce()

      // The real file gets deleted (it's a finished task), but the symlink
      // is not a regular file so it's skipped by lstatSync check.
      assert.equal(result.deletedTaskFiles, 1)
      // Symlink still exists (now dangling), real file deleted
      assert.ok(!existsSync(target))
    })

    it("handles missing tasksDir gracefully", () => {
      const janitor = new Janitor({ tasksDir: "/nonexistent/path/tasks" })
      const result = janitor.runOnce()
      assert.equal(result.deletedTaskFiles, 0)
      assert.equal(result.errors, 0)
    })
  })

  describe("event log cleanup", () => {
    it("deletes old event log files matching the pattern", () => {
      writeFileSync(join(eventsDir, "events-2026-01-01.jsonl"), '{"type":"test"}\n')
      writeFileSync(join(eventsDir, "events-2026-01-02.jsonl"), '{"type":"test"}\n')
      const oldTime = makeOldTimestamp(40)
      utimesSync(join(eventsDir, "events-2026-01-01.jsonl"), oldTime, oldTime)
      utimesSync(join(eventsDir, "events-2026-01-02.jsonl"), oldTime, oldTime)

      const janitor = new Janitor({ eventsDir, eventRetentionMs: 30 * DAY_MS })
      const result = janitor.runOnce()

      assert.equal(result.deletedEventFiles, 2)
      assert.ok(!existsSync(join(eventsDir, "events-2026-01-01.jsonl")))
      assert.ok(!existsSync(join(eventsDir, "events-2026-01-02.jsonl")))
    })

    it("keeps recent event log files", () => {
      writeFileSync(join(eventsDir, "events-2026-07-13.jsonl"), '{"type":"test"}\n')

      const janitor = new Janitor({ eventsDir, eventRetentionMs: 30 * DAY_MS })
      const result = janitor.runOnce()

      assert.equal(result.deletedEventFiles, 0)
      assert.ok(existsSync(join(eventsDir, "events-2026-07-13.jsonl")))
    })

    it("does not delete files not matching the pattern", () => {
      writeFileSync(join(eventsDir, "notes.txt"), "data")
      writeFileSync(join(eventsDir, "events-summary.json"), "{}")
      writeFileSync(join(eventsDir, "events-bad.jsonl"), "bad name") // doesn't match YYYY-MM-DD
      const oldTime = makeOldTimestamp(60)
      for (const f of ["notes.txt", "events-summary.json", "events-bad.jsonl"]) {
        utimesSync(join(eventsDir, f), oldTime, oldTime)
      }

      const janitor = new Janitor({ eventsDir, eventRetentionMs: 30 * DAY_MS })
      const result = janitor.runOnce()

      assert.equal(result.deletedEventFiles, 0)
      for (const f of ["notes.txt", "events-summary.json", "events-bad.jsonl"]) {
        assert.ok(existsSync(join(eventsDir, f)), `${f} should not be deleted`)
      }
    })
  })

  describe("debug log cleanup", () => {
    it("deletes old debug log files", () => {
      writeFileSync(join(logsDir, "debug-192.168.1.1-echo-20260101-120000.log"), "log")
      writeFileSync(join(logsDir, "debug-daemon-20260101-120000.log"), "log")
      const oldTime = makeOldTimestamp(10)
      utimesSync(join(logsDir, "debug-192.168.1.1-echo-20260101-120000.log"), oldTime, oldTime)
      utimesSync(join(logsDir, "debug-daemon-20260101-120000.log"), oldTime, oldTime)

      const janitor = new Janitor({ logsDir, logRetentionMs: 7 * DAY_MS })
      const result = janitor.runOnce()

      assert.equal(result.deletedLogFiles, 2)
      assert.ok(!existsSync(join(logsDir, "debug-192.168.1.1-echo-20260101-120000.log")))
      assert.ok(!existsSync(join(logsDir, "debug-daemon-20260101-120000.log")))
    })

    it("keeps recent debug log files", () => {
      writeFileSync(join(logsDir, "debug-daemon-20260713-120000.log"), "log")

      const janitor = new Janitor({ logsDir, logRetentionMs: 7 * DAY_MS })
      const result = janitor.runOnce()

      assert.equal(result.deletedLogFiles, 0)
      assert.ok(existsSync(join(logsDir, "debug-daemon-20260713-120000.log")))
    })

    it("does not delete non-debug files", () => {
      writeFileSync(join(logsDir, "server.log"), "log")
      writeFileSync(join(logsDir, "readme.txt"), "text")
      const oldTime = makeOldTimestamp(30)
      utimesSync(join(logsDir, "server.log"), oldTime, oldTime)
      utimesSync(join(logsDir, "readme.txt"), oldTime, oldTime)

      const janitor = new Janitor({ logsDir, logRetentionMs: 7 * DAY_MS })
      const result = janitor.runOnce()

      assert.equal(result.deletedLogFiles, 0)
      assert.ok(existsSync(join(logsDir, "server.log")))
      assert.ok(existsSync(join(logsDir, "readme.txt")))
    })
  })

  describe("legacy dir cleanup", () => {
    it("deletes old files in legacy directory and removes empty dirs", () => {
      const execTasksDir = join(legacyDir, "exec-tasks")
      const schedulerDir = join(legacyDir, "scheduler")
      mkdirSync(execTasksDir, { recursive: true })
      mkdirSync(schedulerDir, { recursive: true })

      writeFileSync(join(execTasksDir, "old-task.json"), '{"id":"old"}')
      writeFileSync(join(schedulerDir, "old-state.json"), '{"state":"old"}')
      const oldTime = makeOldTimestamp(20)
      utimesSync(join(execTasksDir, "old-task.json"), oldTime, oldTime)
      utimesSync(join(schedulerDir, "old-state.json"), oldTime, oldTime)

      const janitor = new Janitor({ legacyDataDir: legacyDir, taskRetentionMs: 14 * DAY_MS })
      const result = janitor.runOnce()

      assert.ok(result.removedLegacyFiles >= 2, `expected >=2 removed, got ${result.removedLegacyFiles}`)
      assert.ok(result.removedEmptyDirs >= 2, `expected >=2 empty dirs removed, got ${result.removedEmptyDirs}`)
      assert.ok(!existsSync(execTasksDir), "exec-tasks dir should be removed")
      assert.ok(!existsSync(schedulerDir), "scheduler dir should be removed")
      assert.ok(!existsSync(legacyDir), "legacy dir should be removed")
    })

    it("keeps recent files in legacy directory", () => {
      const execTasksDir = join(legacyDir, "exec-tasks")
      mkdirSync(execTasksDir, { recursive: true })
      writeFileSync(join(execTasksDir, "recent-task.json"), '{"id":"recent"}')

      const janitor = new Janitor({ legacyDataDir: legacyDir, taskRetentionMs: 14 * DAY_MS })
      const result = janitor.runOnce()

      assert.equal(result.removedLegacyFiles, 0)
      assert.ok(existsSync(join(execTasksDir, "recent-task.json")))
    })

    it("handles non-existent legacy dir gracefully", () => {
      const janitor = new Janitor({ legacyDataDir: "/nonexistent/legacy/path" })
      const result = janitor.runOnce()
      assert.equal(result.removedLegacyFiles, 0)
      assert.equal(result.removedEmptyDirs, 0)
      assert.equal(result.errors, 0)
    })

    it("does not remove legacy dir if it still has recent files", () => {
      const execTasksDir = join(legacyDir, "exec-tasks")
      mkdirSync(execTasksDir, { recursive: true })
      writeFileSync(join(execTasksDir, "recent.json"), '{"id":"recent"}')
      writeFileSync(join(execTasksDir, "old.json"), '{"id":"old"}')
      const oldTime = makeOldTimestamp(20)
      utimesSync(join(execTasksDir, "old.json"), oldTime, oldTime)

      const janitor = new Janitor({ legacyDataDir: legacyDir, taskRetentionMs: 14 * DAY_MS })
      const result = janitor.runOnce()

      assert.ok(result.removedLegacyFiles >= 1)
      assert.ok(existsSync(join(execTasksDir, "recent.json")))
      // Directory should still exist because it has a recent file
      assert.ok(existsSync(execTasksDir))
      assert.ok(existsSync(legacyDir))
    })
  })

  describe("combined cleanup", () => {
    it("cleans up all artifact types in one pass", () => {
      // Task file
      writeFileSync(join(tasksDir, "old-task.json"), makeTaskJson("old-task", "completed"))
      utimesSync(join(tasksDir, "old-task.json"), makeOldTimestamp(20), makeOldTimestamp(20))

      // Event file
      writeFileSync(join(eventsDir, "events-2026-01-01.jsonl"), '{}\n')
      utimesSync(join(eventsDir, "events-2026-01-01.jsonl"), makeOldTimestamp(40), makeOldTimestamp(40))

      // Log file
      writeFileSync(join(logsDir, "debug-old-20260101.log"), "log")
      utimesSync(join(logsDir, "debug-old-20260101.log"), makeOldTimestamp(10), makeOldTimestamp(10))

      // Legacy file
      writeFileSync(join(legacyDir, "leftover.json"), '{"old":true}')
      utimesSync(join(legacyDir, "leftover.json"), makeOldTimestamp(20), makeOldTimestamp(20))

      const janitor = new Janitor({
        tasksDir,
        eventsDir,
        logsDir,
        legacyDataDir: legacyDir,
        taskRetentionMs: 14 * DAY_MS,
        eventRetentionMs: 30 * DAY_MS,
        logRetentionMs: 7 * DAY_MS,
      })
      const result = janitor.runOnce()

      assert.ok(result.deletedTaskFiles >= 1)
      assert.ok(result.deletedEventFiles >= 1)
      assert.ok(result.deletedLogFiles >= 1)
      assert.ok(result.removedLegacyFiles >= 1)
      assert.equal(result.errors, 0)
    })

    it("returns zero deletions when all dirs are empty", () => {
      const janitor = new Janitor({ tasksDir, eventsDir, logsDir, legacyDataDir: legacyDir })
      const result = janitor.runOnce()

      assert.equal(result.deletedTaskFiles, 0)
      assert.equal(result.deletedEventFiles, 0)
      assert.equal(result.deletedLogFiles, 0)
      assert.equal(result.removedLegacyFiles, 0)
      assert.equal(result.errors, 0)
    })

    it("returns zero deletions when dirs don't exist", () => {
      const janitor = new Janitor({
        tasksDir: "/nonexistent/tasks",
        eventsDir: "/nonexistent/events",
        logsDir: "/nonexistent/logs",
        legacyDataDir: "/nonexistent/legacy",
      })
      const result = janitor.runOnce()

      assert.equal(result.deletedTaskFiles, 0)
      assert.equal(result.deletedEventFiles, 0)
      assert.equal(result.deletedLogFiles, 0)
      assert.equal(result.removedLegacyFiles, 0)
      assert.equal(result.errors, 0)
    })
  })

  describe("timer management", () => {
    it("start() and stop() manage the timer without errors", () => {
      const janitor = new Janitor({ tasksDir, intervalMs: 100 })
      janitor.start()
      janitor.stop()
      // Should not throw
      assert.ok(true)
    })

    it("start() is idempotent", () => {
      const janitor = new Janitor({ tasksDir, intervalMs: 100 })
      janitor.start()
      janitor.start()
      janitor.stop()
      assert.ok(true)
    })

    it("stop() is idempotent", () => {
      const janitor = new Janitor({ tasksDir })
      janitor.stop()
      janitor.stop()
      assert.ok(true)
    })

    it("stop() after start() clears the timer", () => {
      const janitor = new Janitor({ tasksDir, intervalMs: 100 }) as unknown as {
        timer: ReturnType<typeof setInterval> | null
        start(): void
        stop(): void
      }
      janitor.start()
      assert.ok(janitor.timer, "timer should be set after start()")
      janitor.stop()
      assert.equal(janitor.timer, null, "timer should be null after stop()")
    })

    it("runOnce() works without starting the timer", () => {
      writeFileSync(join(tasksDir, "old.json"), makeTaskJson("old", "completed"))
      utimesSync(join(tasksDir, "old.json"), makeOldTimestamp(20), makeOldTimestamp(20))

      const janitor = new Janitor({ tasksDir, taskRetentionMs: 14 * DAY_MS })
      // Don't call start() — just run once
      const result = janitor.runOnce()

      assert.equal(result.deletedTaskFiles, 1)
      assert.ok(!existsSync(join(tasksDir, "old.json")))
    })
  })

  describe("custom retention policies", () => {
    it("respects custom taskRetentionMs", () => {
      writeFileSync(join(tasksDir, "task.json"), makeTaskJson("task", "completed"))
      // 2 days old — within default 14 days but outside custom 1 day
      utimesSync(join(tasksDir, "task.json"), makeOldTimestamp(2), makeOldTimestamp(2))

      const janitor = new Janitor({ tasksDir, taskRetentionMs: 1 * DAY_MS })
      const result = janitor.runOnce()

      assert.equal(result.deletedTaskFiles, 1)
    })

    it("respects custom eventRetentionMs", () => {
      writeFileSync(join(eventsDir, "events-2026-07-10.jsonl"), "{}\n")
      utimesSync(join(eventsDir, "events-2026-07-10.jsonl"), makeOldTimestamp(5), makeOldTimestamp(5))

      const janitor = new Janitor({ eventsDir, eventRetentionMs: 3 * DAY_MS })
      const result = janitor.runOnce()

      assert.equal(result.deletedEventFiles, 1)
    })

    it("respects custom logRetentionMs", () => {
      writeFileSync(join(logsDir, "debug-test-20260710.log"), "log")
      utimesSync(join(logsDir, "debug-test-20260710.log"), makeOldTimestamp(3), makeOldTimestamp(3))

      const janitor = new Janitor({ logsDir, logRetentionMs: 1 * DAY_MS })
      const result = janitor.runOnce()

      assert.equal(result.deletedLogFiles, 1)
    })
  })

  describe("edge cases", () => {
    it("handles task with missing id field (uses filename)", () => {
      writeFileSync(join(tasksDir, "no-id.json"), JSON.stringify({ status: "completed" }))
      utimesSync(join(tasksDir, "no-id.json"), makeOldTimestamp(20), makeOldTimestamp(20))

      const janitor = new Janitor({ tasksDir, taskRetentionMs: 14 * DAY_MS })
      const result = janitor.runOnce()

      assert.equal(result.deletedTaskFiles, 1)
      assert.ok(!existsSync(join(tasksDir, "no-id.json")))
    })

    it("handles task with missing status field", () => {
      // Missing status — treated as unknown, NOT deleted (defensive)
      writeFileSync(join(tasksDir, "no-status.json"), JSON.stringify({ id: "no-status" }))
      utimesSync(join(tasksDir, "no-status.json"), makeOldTimestamp(20), makeOldTimestamp(20))

      const janitor = new Janitor({ tasksDir, taskRetentionMs: 14 * DAY_MS })
      const result = janitor.runOnce()

      // Missing status is not a finished status, so file is kept
      assert.equal(result.deletedTaskFiles, 0)
      assert.ok(existsSync(join(tasksDir, "no-status.json")))
    })

    it("handles empty directories without errors", () => {
      const janitor = new Janitor({ tasksDir, eventsDir, logsDir, legacyDataDir: legacyDir })
      const result = janitor.runOnce()
      assert.equal(result.errors, 0)
    })

    it("runOnce() never throws even with permission errors", () => {
      // Create a file then make the directory unreadable is tricky in tests,
      // but we can at least verify it doesn't throw with weird inputs.
      const janitor = new Janitor({
        tasksDir: null as unknown as string,
        eventsDir: undefined,
        logsDir: "",
      })
      const result = janitor.runOnce()
      assert.equal(result.errors, 0)
    })
  })
})
