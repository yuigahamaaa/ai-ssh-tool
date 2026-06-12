import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, renameSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import type { ScheduledTask, ScheduledTaskStatus, VirtualCwdState } from "./types.js"

/**
 * Get user data directory with cross-platform support.
 * Windows: uses USERPROFILE or HOMEPATH, falls back to homedir()
 * Unix/macOS: uses homedir()
 */
function getUserDataDir(): string {
  // Windows support: try USERPROFILE first, then HOMEPATH
  if (process.platform === "win32") {
    const userProfile = process.env.USERPROFILE || process.env.HOMEPATH
    if (userProfile) return userProfile
  }
  return homedir()
}

function getBaseDir(): string {
  return join(getUserDataDir(), ".ssh-tool", "scheduler")
}

function getTasksDir(): string {
  const dir = join(getBaseDir(), "tasks")
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

function getStateDir(): string {
  const dir = join(getBaseDir(), "state")
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
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
  private tasksDir: string
  private stateDir: string

  constructor(baseDir?: string) {
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

  saveTask(task: ScheduledTask): void {
    const taskPath = join(this.tasksDir, `${task.id}.json`)
    atomicWrite(taskPath, JSON.stringify(task, null, 2))
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
    atomicWrite(filePath, JSON.stringify(data, null, 2))
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
 */
export class BatchedPersistenceStore {
  private inner: PersistenceStore
  private pending = new Map<string, ScheduledTask>()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private flushIntervalMs: number

  constructor(inner: PersistenceStore, flushIntervalMs = 100) {
    this.inner = inner
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
        this.inner.saveTask(task)
      } catch (err) {
        // Re-queue on failure so the next flush retries. Don't block the rest
        // of the batch.
        this.pending.set(task.id, task)
      }
    }
  }
}
