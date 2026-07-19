import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, renameSync } from "fs"
import { join } from "path"
import type { ScheduledTask, ScheduledTaskStatus, VirtualCwdState } from "./types.js"
import { getSchedulerDir, getSchedulerTasksDir, getSchedulerStateDir, ensureDir } from "../paths.js"

function getBaseDir(): string {
  return getSchedulerDir()
}

function getTasksDir(): string {
  const dir = getSchedulerTasksDir()
  ensureDir(dir)
  return dir
}

function getStateDir(): string {
  const dir = getSchedulerStateDir()
  ensureDir(dir)
  return dir
}

function atomicWrite(filePath: string, data: string): void {
  const tempPath = `${filePath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  try {
    writeFileSync(tempPath, data, { mode: 0o600 })
    renameSync(tempPath, filePath)
  } catch (err) {
    try { unlinkSync(tempPath) } catch {}
    throw err
  }
}

export class PersistenceStore {
  /**
   * The configured on-disk base directory. Public so that subclasses
   * (notably `BatchedPersistenceStore`) can forward the same layout to
   * their `super()` call without duplicating the directory-resolution
   * logic. Marked readonly to make sure nobody reassigns it after
   * construction.
   */
  public readonly baseDir: string | undefined
  private tasksDir: string
  private stateDir: string

  constructor(baseDir?: string) {
    this.baseDir = baseDir
    if (baseDir) {
      this.tasksDir = join(baseDir, "tasks")
      this.stateDir = join(baseDir, "state")
      if (!existsSync(this.tasksDir)) mkdirSync(this.tasksDir, { recursive: true, mode: 0o700 })
      if (!existsSync(this.stateDir)) mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
    } else {
      this.tasksDir = getTasksDir()
      this.stateDir = getStateDir()
    }
  }

  /**
   * Drain any pending writes. The base `PersistenceStore` writes
   * synchronously on every `saveTask`, so this is a no-op; the
   * `BatchedPersistenceStore` subclass overrides it to flush its
   * in-memory queue. Exposed publicly so callers (notably
   * `SchedulerService.dispose()`) can call it without a cast.
   */
  flushSync(): void {
    // no-op in the base class
  }

  saveTask(task: ScheduledTask): void {
    const taskPath = join(this.tasksDir, `${task.id}.json`)
    // Machine-read format: no indentation. Drops write size ~30-40% and
    // reduces JSON.stringify CPU. CLI/MCP responses keep pretty-print for
    // human readability; on-disk task files are never inspected by hand.
    atomicWrite(taskPath, JSON.stringify(task))
  }
  loadTask(taskId: string): ScheduledTask | null {
    const taskPath = join(this.tasksDir, `${taskId}.json`)
    if (!existsSync(taskPath)) return null
    try {
      return JSON.parse(readFileSync(taskPath, "utf8")) as ScheduledTask
    } catch {
      return null
    }
  }

  loadAllTasks(): ScheduledTask[] {
    if (!existsSync(this.tasksDir)) return []
    const tasks: ScheduledTask[] = []
    try {
      const files = readdirSync(this.tasksDir)
      for (const file of files) {
        if (!file.endsWith(".json")) continue
        try {
          const content = readFileSync(join(this.tasksDir, file), "utf8")
          tasks.push(JSON.parse(content) as ScheduledTask)
        } catch {
          // corrupted file, skip
        }
      }
    } catch {}
    return tasks
  }

  deleteTask(taskId: string): void {
    const taskPath = join(this.tasksDir, `${taskId}.json`)
    if (existsSync(taskPath)) {
      try { unlinkSync(taskPath) } catch {}
    }
  }

  /**
   * Scan the tasks directory and delete .json files for tasks that have
   * been in a terminal state (completed/failed/cancelled/timeout/stale)
   * for longer than `retentionMs`. Called at startup to prevent files
   * from accumulating across daemon restarts — evictOldTasks only runs
   * every 5 minutes while the daemon is alive, so files from crashed
   * sessions would otherwise persist forever.
   *
   * Corrupted (unparseable) .json files are also deleted.
   *
   * Returns the number of deleted files.
   */
  cleanupOldTaskFiles(retentionMs: number = 24 * 60 * 60 * 1000): number {
    if (!existsSync(this.tasksDir)) return 0
    const now = Date.now()
    const terminalStatuses: ScheduledTaskStatus[] = ["completed", "failed", "cancelled", "timeout", "stale"]
    let deleted = 0
    try {
      const files = readdirSync(this.tasksDir)
      for (const file of files) {
        if (!file.endsWith(".json")) continue
        // Skip temp files from atomic-write crashes; those are cleaned
        // separately by cleanupTempFiles().
        if (file.includes(".tmp-")) continue
        const filePath = join(this.tasksDir, file)
        try {
          const content = readFileSync(filePath, "utf8")
          const task = JSON.parse(content) as ScheduledTask
          if (!terminalStatuses.includes(task.status)) continue
          const ts = task.finishedAt ?? task.updatedAt ?? 0
          if (ts > 0 && now - ts > retentionMs) {
            try { unlinkSync(filePath); deleted++ } catch {}
          }
        } catch {
          // Corrupted file: delete to prevent accumulation
          try { unlinkSync(filePath); deleted++ } catch {}
        }
      }
    } catch {}
    return deleted
  }

  /**
   * Remove leftover .tmp-* files from atomic-write crashes. Called at
   * startup to keep the tasks directory clean.
   */
  cleanupTempFiles(): number {
    if (!existsSync(this.tasksDir)) return 0
    let deleted = 0
    try {
      const files = readdirSync(this.tasksDir)
      for (const file of files) {
        if (!file.includes(".tmp-")) continue
        try { unlinkSync(join(this.tasksDir, file)); deleted++ } catch {}
      }
    } catch {}
    return deleted
  }

  restore(): { queued: ScheduledTask[]; stale: ScheduledTask[] } {
    const all = this.loadAllTasks()
    const queued: ScheduledTask[] = []
    const stale: ScheduledTask[] = []

    for (const task of all) {
      if (task.status === "running") {
        task.status = "stale" as ScheduledTaskStatus
        task.decisionReason = "Marked stale after daemon restart; task cannot be reclaimed."
        task.updatedAt = Date.now()
        this.saveTask(task)
        stale.push(task)
      } else if (task.status === "queued") {
        queued.push(task)
      }
    }

    return { queued, stale }
  }

  saveVirtualCwdMap(data: Record<string, VirtualCwdState>): void {
    const filePath = join(this.stateDir, "virtual-cwd.json")
    // Machine-read: no indentation (see saveTask for rationale).
    atomicWrite(filePath, JSON.stringify(data))
  }

  loadVirtualCwdMap(): Record<string, VirtualCwdState> {
    const filePath = join(this.stateDir, "virtual-cwd.json")
    if (!existsSync(filePath)) return {}
    try {
      return JSON.parse(readFileSync(filePath, "utf8"))
    } catch {
      return {}
    }
  }
}

/**
 * Coalesces multiple `saveTask` calls in a short window into a single batched
 * flush. Each `saveTask` overwrites the latest in-memory snapshot keyed by
 * `task.id`; the flush timer fires after `flushIntervalMs` of quiet (default
 * 100ms) and writes all pending tasks in one synchronous sweep — but each
 * write is still atomic via `PersistenceStore.saveTask`, so individual files
 * are never observed in a partial state.
 *
 * `flushSync()` (callable from `dispose()`) drains the queue immediately so
 * no data is lost when the scheduler shuts down.
 *
 * Inherits all read-side methods (`loadTask` / `loadAllTasks` / `deleteTask`
 * / `restore` / `loadVirtualCwdMap` / `saveVirtualCwdMap`) from the inner
 * `PersistenceStore` — they do not need batching, since reads are not on
 * the hot path and writes to non-task state (virtual cwd) are already
 * debounced at the `VirtualCwdStore` layer.
 */
export class BatchedPersistenceStore extends PersistenceStore {
  private pending = new Map<string, ScheduledTask>()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private flushIntervalMs: number

  constructor(inner: PersistenceStore, flushIntervalMs = 100) {
    // Forward the inner store's base directory so we share the same on-disk
    // layout. Rebuilding the dir layout is cheap and keeps the two stores in
    // sync regardless of how `inner` was constructed (default HOME path or
    // explicit `baseDir`).
    super(inner.baseDir)
    this.flushIntervalMs = flushIntervalMs
  }

  /** Queue a task for the next batched flush. Idempotent for the same id. */
  saveTask(task: ScheduledTask): void {
    this.pending.set(task.id, task)
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flush()
    }, this.flushIntervalMs)
  }

  /** Force an immediate flush of all pending tasks. */
  flushSync(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.flush()
  }

  /** Pending task count, useful for tests and metrics. */
  get pendingCount(): number {
    return this.pending.size
  }

  private flush(): void {
    if (this.pending.size === 0) return
    // Snapshot then clear so a re-entrant saveTask during flush is re-queued.
    const batch = Array.from(this.pending.values())
    this.pending.clear()
    for (const task of batch) {
      try {
        // Use super.saveTask to bypass the batched override and write
        // directly through PersistenceStore's atomic-write path.
        super.saveTask(task)
      } catch (err) {
        // Re-queue on failure so the next flush retries. Don't block the rest
        // of the batch.
        this.pending.set(task.id, task)
      }
    }
  }
}
