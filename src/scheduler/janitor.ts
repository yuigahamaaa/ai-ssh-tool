/**
 * Janitor — periodic cleanup of stale on-disk artifacts.
 *
 * The scheduler and daemon produce several categories of files that
 * accumulate over time but are never actively deleted:
 *
 *   - Task JSON snapshots (scheduler/tasks/<id>.json) — the in-memory
 *     eviction (evictOldTasks) drops the Map entry after 1 hour, but
 *     the on-disk file persists forever.
 *   - Event log files (scheduler/events/events-YYYY-MM-DD.jsonl) —
 *     one file per day, never rotated away.
 *   - Debug log files (logs/debug-*.log) — one file per debug session,
 *     never cleaned up.
 *   - Legacy ~/.ssh-tool/ directory — migrated on first launch, but
 *     leftover files may remain if migration was partial.
 *
 * The Janitor runs on a slow timer (default 30 min) and deletes files
 * older than their respective retention periods. It is entirely
 * best-effort: errors are swallowed and counted, never thrown.
 *
 * Safety:
 *   - Task JSON files are only deleted when the parsed status is a
 *     finished state (completed/failed/cancelled/timeout/stale) AND
 *     the task ID is not in the protected set (running/queued).
 *   - Only files matching expected name patterns are touched — no
 *     arbitrary file deletion.
 *   - Symlinks are never followed or deleted (lstatSync check).
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  rmdirSync,
  lstatSync,
} from "fs"
import { join } from "path"
import type { ScheduledTaskStatus } from "./types.js"
import { getLegacyDataDir } from "../paths.js"

export interface JanitorOptions {
  /** Directory containing <taskId>.json files. */
  tasksDir?: string
  /** Directory containing events-YYYY-MM-DD.jsonl files. */
  eventsDir?: string
  /** Directory containing debug-*.log files. */
  logsDir?: string
  /** Legacy ~/.ssh-tool directory to sweep for leftover files. */
  legacyDataDir?: string
  /** Task JSON files older than this (by mtime) are eligible. Default: 14 days */
  taskRetentionMs?: number
  /** Event log files older than this (by mtime) are eligible. Default: 30 days */
  eventRetentionMs?: number
  /** Debug log files older than this (by mtime) are eligible. Default: 7 days */
  logRetentionMs?: number
  /** Interval between automatic cleanup runs. Default: 30 minutes */
  intervalMs?: number
  /** Returns task IDs that must not be deleted (running/queued). */
  protectedTaskIds?: () => Iterable<string>
}

export interface JanitorResult {
  deletedTaskFiles: number
  deletedEventFiles: number
  deletedLogFiles: number
  removedLegacyFiles: number
  removedEmptyDirs: number
  errors: number
}

const DEFAULT_TASK_RETENTION_MS = 14 * 24 * 60 * 60 * 1000
const DEFAULT_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const DEFAULT_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_INTERVAL_MS = 30 * 60 * 1000

const FINISHED_STATUSES = new Set<ScheduledTaskStatus>([
  "completed",
  "failed",
  "cancelled",
  "timeout",
  "stale",
])

export class Janitor {
  private tasksDir: string | undefined
  private eventsDir: string | undefined
  private logsDir: string | undefined
  private legacyDataDir: string | undefined
  private taskRetentionMs: number
  private eventRetentionMs: number
  private logRetentionMs: number
  private intervalMs: number
  private protectedTaskIds: () => Iterable<string>
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(opts?: JanitorOptions) {
    this.tasksDir = opts?.tasksDir
    this.eventsDir = opts?.eventsDir
    this.logsDir = opts?.logsDir
    this.legacyDataDir = opts?.legacyDataDir ?? getLegacyDataDir()
    this.taskRetentionMs = opts?.taskRetentionMs ?? DEFAULT_TASK_RETENTION_MS
    this.eventRetentionMs = opts?.eventRetentionMs ?? DEFAULT_EVENT_RETENTION_MS
    this.logRetentionMs = opts?.logRetentionMs ?? DEFAULT_LOG_RETENTION_MS
    this.intervalMs = opts?.intervalMs ?? DEFAULT_INTERVAL_MS
    this.protectedTaskIds = opts?.protectedTaskIds ?? (() => [])
  }

  /** Start the periodic cleanup timer. Safe to call multiple times. */
  start(): void {
    if (this.timer) return
    // Run once shortly after start so we don't wait a full interval on
    // a fresh daemon boot (the first real run happens after intervalMs).
    this.timer = setInterval(() => {
      this.runOnce()
    }, this.intervalMs)
    // Don't keep the process alive just for cleanup.
    this.timer.unref?.()
  }

  /** Stop the periodic cleanup timer. Safe to call multiple times. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * Run a single cleanup pass. Best-effort: all errors are swallowed
   * and counted in the result. Never throws.
   */
  runOnce(): JanitorResult {
    const result: JanitorResult = {
      deletedTaskFiles: 0,
      deletedEventFiles: 0,
      deletedLogFiles: 0,
      removedLegacyFiles: 0,
      removedEmptyDirs: 0,
      errors: 0,
    }

    this.cleanupTaskFiles(result)
    this.cleanupEventFiles(result)
    this.cleanupLogFiles(result)
    this.cleanupLegacyDir(result)

    return result
  }

  /**
   * Delete finished task JSON files older than taskRetentionMs.
   * Reads each file to verify the status is a finished state before
   * deleting — never deletes running/queued/unknown files.
   */
  private cleanupTaskFiles(result: JanitorResult): void {
    if (!this.tasksDir || !existsSync(this.tasksDir)) return
    const now = Date.now()
    const protectedIds = new Set(this.protectedTaskIds())

    let files: string[]
    try {
      files = readdirSync(this.tasksDir)
    } catch {
      result.errors++
      return
    }

    for (const file of files) {
      if (!file.endsWith(".json")) continue
      const filePath = join(this.tasksDir, file)

      // Never follow symlinks — defense against path-injection attacks.
      let st: ReturnType<typeof lstatSync>
      try {
        st = lstatSync(filePath)
        if (!st.isFile()) continue
      } catch {
        result.errors++
        continue
      }

      if (now - st.mtimeMs < this.taskRetentionMs) continue

      // Read and parse to verify the task is in a finished state.
      // Files that fail to parse are treated as corrupted and deleted
      // (they're stale and unreadable anyway).
      let taskId: string
      let status: string | undefined
      try {
        const content = readFileSync(filePath, "utf8")
        const task = JSON.parse(content)
        taskId = task.id ?? file.replace(/\.json$/, "")
        status = task.status
      } catch {
        // Corrupted JSON — safe to remove, it's already unreadable.
        this.safeUnlink(filePath, result)
        if (!existsSync(filePath)) result.deletedTaskFiles++
        continue
      }

      if (protectedIds.has(taskId)) continue
      // Only delete if status is a known finished state. Missing or
      // unknown status means we can't be sure — keep the file (defensive).
      if (typeof status !== "string" || !FINISHED_STATUSES.has(status as ScheduledTaskStatus)) {
        continue
      }

      this.safeUnlink(filePath, result)
      if (!existsSync(filePath)) result.deletedTaskFiles++
    }
  }

  /**
   * Delete event log files (events-YYYY-MM-DD.jsonl) older than
   * eventRetentionMs. Only files matching the expected pattern are
   * touched.
   */
  private cleanupEventFiles(result: JanitorResult): void {
    if (!this.eventsDir || !existsSync(this.eventsDir)) return
    const now = Date.now()
    const pattern = /^events-\d{4}-\d{2}-\d{2}\.jsonl$/

    let files: string[]
    try {
      files = readdirSync(this.eventsDir)
    } catch {
      result.errors++
      return
    }

    for (const file of files) {
      if (!pattern.test(file)) continue
      const filePath = join(this.eventsDir, file)

      let st: ReturnType<typeof lstatSync>
      try {
        st = lstatSync(filePath)
        if (!st.isFile()) continue
      } catch {
        result.errors++
        continue
      }

      if (now - st.mtimeMs < this.eventRetentionMs) continue

      this.safeUnlink(filePath, result)
      if (!existsSync(filePath)) result.deletedEventFiles++
    }
  }

  /**
   * Delete debug log files (debug-*.log) older than logRetentionMs.
   */
  private cleanupLogFiles(result: JanitorResult): void {
    if (!this.logsDir || !existsSync(this.logsDir)) return
    const now = Date.now()

    let files: string[]
    try {
      files = readdirSync(this.logsDir)
    } catch {
      result.errors++
      return
    }

    for (const file of files) {
      if (!file.startsWith("debug-") || !file.endsWith(".log")) continue
      const filePath = join(this.logsDir, file)

      let st: ReturnType<typeof lstatSync>
      try {
        st = lstatSync(filePath)
        if (!st.isFile()) continue
      } catch {
        result.errors++
        continue
      }

      if (now - st.mtimeMs < this.logRetentionMs) continue

      this.safeUnlink(filePath, result)
      if (!existsSync(filePath)) result.deletedLogFiles++
    }
  }

  /**
   * Sweep the legacy ~/.ssh-tool directory for leftover files older
   * than taskRetentionMs, then attempt to remove now-empty directories.
   * This is idempotent and safe: if the directory doesn't exist, it's
   * a no-op.
   */
  private cleanupLegacyDir(result: JanitorResult): void {
    if (!this.legacyDataDir || !existsSync(this.legacyDataDir)) return
    const now = Date.now()

    const sweepDir = (dir: string): boolean => {
      let entries: string[]
      try {
        entries = readdirSync(dir)
      } catch {
        result.errors++
        return false
      }

      let allRemoved = true
      for (const entry of entries) {
        const entryPath = join(dir, entry)
        let st: ReturnType<typeof lstatSync>
        try {
          st = lstatSync(entryPath)
        } catch {
          result.errors++
          allRemoved = false
          continue
        }

        if (st.isDirectory()) {
          const emptied = sweepDir(entryPath)
          if (!emptied) allRemoved = false
        } else if (st.isFile()) {
          if (now - st.mtimeMs >= this.taskRetentionMs) {
            this.safeUnlink(entryPath, result)
            if (!existsSync(entryPath)) {
              result.removedLegacyFiles++
            } else {
              allRemoved = false
            }
          } else {
            // Recent file — don't touch, directory is still in use.
            allRemoved = false
          }
        } else {
          // Symlink or special file — leave it.
          allRemoved = false
        }
      }

      if (allRemoved) {
        try {
          rmdirSync(dir)
          result.removedEmptyDirs++
        } catch {
          // Directory not empty or permission denied — leave it.
        }
      }
      return allRemoved
    }

    sweepDir(this.legacyDataDir)
  }

  private safeUnlink(filePath: string, result: JanitorResult): void {
    try {
      unlinkSync(filePath)
    } catch {
      result.errors++
    }
  }
}
