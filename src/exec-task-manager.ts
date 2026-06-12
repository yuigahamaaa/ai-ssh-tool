/**
 * Exec Task Manager - unified management for all SSH execution tasks
 *
 * Manages both regular exec() commands and background exec commands:
 * - All running tasks are tracked in memory
 * - Cross-process visibility via disk persistence
 * - Atomic writes to avoid corruption
 * - Automatic cleanup of old tasks
 */

import type { Client, ClientChannel } from "ssh2"
import { randomUUID } from "crypto"
import { join } from "path"
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync, renameSync } from "fs"
import { homedir } from "os"
import { log } from "./logger.js"

/**
 * Get user data directory with cross-platform support.
 */
function getUserDataDir(): string {
  if (process.platform === "win32") {
    const userProfile = process.env.USERPROFILE || process.env.HOMEPATH
    if (userProfile) return userProfile
  }
  return homedir()
}

export type TaskType = "exec" | "background"
export type TaskStatus = "running" | "completed" | "failed" | "cancelled" | "timeout"

export interface ExecTask {
  id: string
  type: TaskType
  command: string
  status: TaskStatus
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  startedAt: number
  finishedAt: number | null
  pid: number | null
  hostname: string
  createdAt: number
  updatedAt: number
  profileKey?: string
  sessionId?: string
  cwd?: string
}

export interface RunningTaskEntry {
  stream: ClientChannel
  task: ExecTask
  client: Client
  persistImmediate: boolean // true for background tasks, false for regular exec
  stdoutChunks: Buffer[]    // live output buffers, promoted from closure for runtime reads
  stderrChunks: Buffer[]    // live error buffers, promoted from closure for runtime reads
  chunksFlushed: boolean    // prevents double-flush on close + timeout
  lastPersistAt: number     // per-task throttle, prevents multi-task interference
}

function getTaskStorageDir(): string {
  const storageDir = join(getUserDataDir(), ".ssh-tool", "exec-tasks")
  if (!existsSync(storageDir)) {
    mkdirSync(storageDir, { recursive: true, mode: 0o700 })
  }
  return storageDir
}

function getTaskFilePath(taskId: string): string {
  return join(getTaskStorageDir(), `${taskId}.json`)
}

function getHostIdentifier(client: Client): string {
  // Reflection on ssh2 internals (`_client._config.host`) is fragile across
  // ssh2 versions. Callers SHOULD pass an explicit `host` in the options
  // bag — this fallback only exists for the cases that haven't been
  // migrated yet (legacy BackgroundExecManager path, tests).
  const clientObj = client as unknown as Record<string, unknown>
  const innerClient = clientObj._client as Record<string, unknown> | undefined
  const config = innerClient?._config as Record<string, unknown> | undefined
  const host = config?.host as string | undefined
  return host ?? "unknown"
}

export class ExecTaskManager {
  private tasks = new Map<string, RunningTaskEntry>()
  private maxOutputBuffer = 10 * 1024 * 1024
  private lastCleanupAt: number = 0
  private PERSIST_INTERVAL = 1000
  private CLEANUP_INTERVAL = 5 * 60 * 1000
  private TASK_RETENTION_MS = 24 * 60 * 60 * 1000

  constructor() {
    this.loadTasksFromDisk()
    this.cleanupOldTasks()
  }

  private maybeCleanup(): void {
    const now = Date.now()
    if (now - this.lastCleanupAt > this.CLEANUP_INTERVAL) {
      this.cleanupOldTasks()
      this.lastCleanupAt = now
    }
  }

  private loadTasksFromDisk(): void {
    const storageDir = getTaskStorageDir()
    if (!existsSync(storageDir)) return

    try {
      const files = readdirSync(storageDir)
      for (const file of files) {
        if (!file.endsWith(".json")) continue
        try {
          const filePath = join(storageDir, file)
          const content = readFileSync(filePath, "utf8")
          const task = JSON.parse(content) as ExecTask
          if (task.status === "running") {
            log("exec-task", `Loaded orphaned task ${task.id} from disk`)
          }
        } catch {
          // ignore corrupted files
        }
      }
    } catch {
      // ignore errors
    }
  }

  private cleanupOldTasks(): void {
    const storageDir = getTaskStorageDir()
    if (!existsSync(storageDir)) return

    const now = Date.now()
    const files = readdirSync(storageDir)
    for (const file of files) {
      if (!file.endsWith(".json")) continue
      const taskPath = join(storageDir, file)
      try {
        const content = readFileSync(taskPath, "utf8")
        const task = JSON.parse(content) as ExecTask
        const shouldRemove = (task.finishedAt && (now - task.finishedAt > this.TASK_RETENTION_MS)) ||
                             (!task.finishedAt && (now - task.startedAt > 24 * 60 * 60 * 1000))
        if (shouldRemove) {
          unlinkSync(taskPath)
          log("exec-task", `Cleaned up old task ${task.id}`)
        }
      } catch {
        try {
          unlinkSync(taskPath)
        } catch {}
      }
    }
  }

  private saveTask(entry: RunningTaskEntry, immediate: boolean): void {
    if (!immediate) {
      const now = Date.now()
      if (now - entry.lastPersistAt < this.PERSIST_INTERVAL) {
        return
      }
    }

    const taskPath = getTaskFilePath(entry.task.id)
    const tempPath = `${taskPath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    try {
      // Machine-read: no indentation. Each task can be up to ~10MB
      // (maxOutputBuffer), so saving ~30% on every state transition matters.
      writeFileSync(tempPath, JSON.stringify(entry.task), { mode: 0o600 })
      renameSync(tempPath, taskPath)
      entry.lastPersistAt = Date.now()
    } catch (err) {
      log("exec-task", `Failed to save task ${entry.task.id}: ${err}`)
      try { unlinkSync(tempPath) } catch {}
    }
  }

  private deleteTaskFile(taskId: string): void {
    const taskPath = getTaskFilePath(taskId)
    if (existsSync(taskPath)) {
      try {
        unlinkSync(taskPath)
      } catch {
        // ignore
      }
    }
  }

  private trimChunks(chunks: Buffer[]): void {
    let totalSize = 0
    for (const chunk of chunks) {
      totalSize += chunk.length
    }
    while (totalSize > this.maxOutputBuffer && chunks.length > 1) {
      const removed = chunks.shift()!
      totalSize -= removed.length
    }
    if (totalSize > this.maxOutputBuffer && chunks.length === 1) {
      chunks[0] = chunks[0].slice(chunks[0].length - this.maxOutputBuffer)
    }
  }

  start(
    client: Client,
    command: string,
    options?: {
      type?: TaskType
      cwd?: string
      env?: Record<string, string>
      timeout?: number
      detached?: boolean
      profileKey?: string
      sessionId?: string
      /** Explicit host name. Preferred over the ssh2-reflection fallback
       *  in getHostIdentifier. New callers should always pass this. */
      host?: string
    }
  ): { id: string; promise: Promise<ExecResult> } {
    const id = randomUUID().slice(0, 12)
    const taskType = options?.type ?? "exec"
    const isBackground = taskType === "background" || options?.timeout === undefined
    const persistImmediate = true
    const useDetached = options?.detached || isBackground

    let fullCommand = command
    if (options?.cwd) {
      fullCommand = `cd ${JSON.stringify(options.cwd)} && ${fullCommand}`
    }
    if (options?.env) {
      const envPrefix = Object.entries(options.env)
        .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
        .join(" ")
      fullCommand = `${envPrefix}; ${fullCommand}`
    }

    // Explicit host from caller takes priority; only fall back to the
    // (ssh2-internals) reflection if the caller didn't supply one.
    const hostname = options?.host ?? getHostIdentifier(client)
    const task: ExecTask = {
      id,
      type: taskType,
      command,
      status: "running",
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      startedAt: Date.now(),
      finishedAt: null,
      pid: null,
      hostname,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      profileKey: options?.profileKey,
      sessionId: options?.sessionId,
      cwd: options?.cwd,
    }

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []

    const entry: RunningTaskEntry = {
      stream: null as any,
      task,
      client,
      persistImmediate,
      stdoutChunks,
      stderrChunks,
      chunksFlushed: false,
      lastPersistAt: 0,
    }

    this.tasks.set(id, entry)
    this.saveTask(entry, true)


    const flushChunks = () => {
      if (entry.chunksFlushed) return
      entry.chunksFlushed = true
      task.stdout = Buffer.concat(stdoutChunks).toString("utf8")
      task.stderr = Buffer.concat(stderrChunks).toString("utf8")
    }

    const promise = new Promise<ExecResult>((resolve, reject) => {
      // 对于后台任务，先保持简单，我们先不用复杂的 nohup 包装，避免转义问题
      // 保持原来的简单逻辑：echo SSH_TOOL_PID，然后执行命令
      // 后续我们可以再改进，但先让代码能正常工作
      let wrappedCommand = `echo "SSH_TOOL_PID:$$" >&2; exec ${fullCommand}`

      client.exec(wrappedCommand, (err, stream) => {
        if (err) {
          flushChunks()
          this.finishTask(id, "failed", 1, undefined, err.message)
          reject(new Error(`Failed to exec: ${err.message}`))
          return
        }

        entry.stream = stream
        let pidCaptured = false
        let firstLine = ""

        stream.on("data", (data: Buffer) => {
          const text = data.toString()
          if (!pidCaptured) {
            // PID is always echoed to stderr (see the `echo "SSH_TOOL_PID:$$" >&2`
            // prefix above) — it never appears on stdout. So we don't need to
            // scan stdout for the PID marker, and we can short-circuit the
            // detection as soon as the PID is parsed from stderr. Until then
            // we just buffer into a bounded `firstLine` and flush to the
            // normal chunk buffer once it exceeds the 4KB cap.
            firstLine += text
            if (firstLine.length > 4096) {
              pidCaptured = true
              stdoutChunks.push(Buffer.from(firstLine))
              this.trimChunks(stdoutChunks)
              firstLine = ""
            }
          } else {
            stdoutChunks.push(data)
            this.trimChunks(stdoutChunks)
          }
          task.updatedAt = Date.now()
          this.saveTask(entry, false)
        })

        stream.stderr.on("data", (data: Buffer) => {
          const text = data.toString()
          if (!pidCaptured) {
            // 尝试匹配 SSH_TOOL_PID
            let pidMatch = text.match(/SSH_TOOL_PID:(\d+)/)
            if (!pidMatch) {
              // 尝试匹配 SSH_TOOL_NOHUP_PID
              pidMatch = text.match(/SSH_TOOL_NOHUP_PID:(\d+)/)
            }
            if (pidMatch) {
              task.pid = parseInt(pidMatch[1])
              pidCaptured = true
              const remaining = text.replace(/SSH_TOOL_(NOHUP_)?PID:\d+\n?/g, "")
              if (remaining) {
                stderrChunks.push(Buffer.from(remaining))
                this.trimChunks(stderrChunks)
              }
              task.updatedAt = Date.now()
              if (persistImmediate) this.saveTask(entry, true)
              return
            }
          }
          stderrChunks.push(data)
          this.trimChunks(stderrChunks)
          task.updatedAt = Date.now()
          this.saveTask(entry, false)
        })

        stream.on("close", (code?: number, signal?: string) => {
          flushChunks()
          const status = code === 0 ? "completed" : "failed"
          this.finishTask(id, status, code ?? 0, signal ?? undefined)
          resolve({
            stdout: task.stdout,
            stderr: task.stderr,
            code: code ?? 0,
            signal,
          })
        })

        stream.on("error", (streamErr: Error) => {
          flushChunks()
          this.finishTask(id, "failed", 1, undefined, streamErr.message)
          reject(new Error(`Stream error: ${streamErr.message}`))
        })

        if (options?.timeout && options.timeout > 0) {
          setTimeout(() => {
            const currentTask = this.tasks.get(id)
            if (currentTask && currentTask.task.status === "running") {
              const pid = currentTask.task.pid
              if (pid && client) {
                const killCmd = `kill -TERM ${pid} 2>/dev/null; sleep 0.1; kill -9 ${pid} 2>/dev/null; true`
                client.exec(killCmd, () => {})
              }
              if (currentTask.stream) {
                try {
                  currentTask.stream.close()
                } catch {}
              }
              flushChunks()
              this.finishTask(id, "timeout", 124, "TERM")
              reject(new Error(`Command timed out after ${options.timeout}ms`))
            }
          }, options.timeout)
        }
      })
    })

    return { id, promise }
  }

  private finishTask(
    id: string,
    status: TaskStatus,
    exitCode: number,
    signal?: string,
    errorMsg?: string
  ): void {
    const entry = this.tasks.get(id)
    if (!entry) return

    entry.task.status = status
    entry.task.exitCode = exitCode
    entry.task.signal = signal ?? null
    entry.task.finishedAt = Date.now()
    entry.task.updatedAt = Date.now()

    if (errorMsg) {
      entry.task.stderr += `\n${errorMsg}`
    }

    this.saveTask(entry, true)

    // Release runtime resources to prevent memory growth in long-lived daemons
    entry.stream = null as any
    entry.client = null as any
    this.tasks.delete(id)
    log("exec-task", `Task ${id} finished and evicted from memory: ${status}, code=${exitCode}, signal=${signal}`)

    // Notify background-exec waiters. Imported lazily to avoid a circular
    // dep with background-exec.ts (which imports from this module).
    try {
      const snapshot = { ...entry.task } as ExecTask
      // Dynamic import shape: synchronously call the named export via the
      // module's side-effect-free accessor. We use a function reference to
      // avoid a hard import cycle; set up by background-exec.ts at load time.
      const emit = (globalThis as { __bgExecEmit?: (t: ExecTask) => void }).__bgExecEmit
      if (typeof emit === "function") emit(snapshot)
    } catch {
      // best-effort notification, never block finish
    }
  }

  cancel(id: string, client: Client, signal: "TERM" | "HUP" = "TERM"): boolean {
    const entry = this.tasks.get(id)
    if (!entry) return false

    if (entry.task.status !== "running") {
      return false
    }

    const pid = entry.task.pid
    if (pid && client) {
      const killCmd = `kill -${signal} ${pid} 2>/dev/null; sleep 0.1; kill -9 ${pid} 2>/dev/null; true`
      log("exec-task", `Cancelling task ${id} PID ${pid}`)
      client.exec(killCmd, () => {})
    }

    // Mark cancelled BEFORE closing stream to prevent race with stream.on("close")
    // callback which would overwrite status to "completed" via finishTask
    this.finishTask(id, "cancelled", 130, signal)

    if (entry.stream) {
      try {
        entry.stream.close()
      } catch {}
    }

    return true
  }

  getStatus(id: string): ExecTask | null {
    const entry = this.tasks.get(id)
    if (entry) {
      // Return live output for running tasks (chunks are only flushed on close)
      const snapshot = { ...entry.task }
      if (snapshot.status === "running" && !entry.chunksFlushed) {
        snapshot.stdout = Buffer.concat(entry.stdoutChunks).toString("utf8")
        snapshot.stderr = Buffer.concat(entry.stderrChunks).toString("utf8")
      }
      return snapshot
    }

    const taskPath = getTaskFilePath(id)
    if (!existsSync(taskPath)) return null
    try {
      const content = readFileSync(taskPath, "utf8")
      return JSON.parse(content) as ExecTask
    } catch {
      return null
    }
  }

  list(hostname?: string): ExecTask[] {
    this.maybeCleanup()

    // Merge disk-loaded tasks with in-memory tasks by id, then filter by
    // hostname and sort. Using a Map for the merge keeps this O(n + m)
    // (where n = disk files, m = in-memory) instead of the previous
    // O(n * m) findIndex scan inside the inner loop. In-memory tasks win
    // over disk snapshots of the same id, matching the original
    // last-write-wins semantics.
    const merged = new Map<string, ExecTask>()
    const storageDir = getTaskStorageDir()

    if (existsSync(storageDir)) {
      const files = readdirSync(storageDir)
      for (const file of files) {
        if (!file.endsWith(".json")) continue
        const taskPath = join(storageDir, file)
        try {
          const content = readFileSync(taskPath, "utf8")
          const task = JSON.parse(content) as ExecTask
          if (!hostname || task.hostname === hostname) {
            merged.set(task.id, task)
          }
        } catch {}
      }
    }

    for (const [_id, entry] of this.tasks) {
      if (!hostname || entry.task.hostname === hostname) {
        // Include live output for running tasks (chunks only flushed on close)
        const snapshot = { ...entry.task }
        if (snapshot.status === "running" && !entry.chunksFlushed) {
          snapshot.stdout = Buffer.concat(entry.stdoutChunks).toString("utf8")
          snapshot.stderr = Buffer.concat(entry.stderrChunks).toString("utf8")
        }
        merged.set(_id, snapshot)
      }
    }

    return Array.from(merged.values()).sort((a, b) => b.startedAt - a.startedAt)
  }

  getOutput(id: string): { stdout: string; stderr: string } | null {
    const entry = this.tasks.get(id)
    if (entry) {
      // Return live output from chunks while task is running
      if (!entry.chunksFlushed) {
        return {
          stdout: Buffer.concat(entry.stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(entry.stderrChunks).toString("utf8"),
        }
      }
      return { stdout: entry.task.stdout, stderr: entry.task.stderr }
    }

    const taskPath = getTaskFilePath(id)
    if (!existsSync(taskPath)) return null
    try {
      const content = readFileSync(taskPath, "utf8")
      const task = JSON.parse(content) as ExecTask
      return { stdout: task.stdout, stderr: task.stderr }
    } catch {
      return null
    }
  }

  getOutputSince(id: string, stdoutOffset: number, stderrOffset: number): { stdout: string; stderr: string } | null {
    const output = this.getOutput(id)
    if (!output) return null
    return {
      stdout: output.stdout.slice(stdoutOffset),
      stderr: output.stderr.slice(stderrOffset),
    }
  }

  remove(id: string): boolean {
    const deleted = this.tasks.delete(id)
    this.deleteTaskFile(id)
    return deleted
  }
}

export interface ExecResult {
  stdout: string
  stderr: string
  code: number
  signal?: string
}

let globalTaskManager: ExecTaskManager | null = null

export function getGlobalTaskManager(): ExecTaskManager {
  if (!globalTaskManager) {
    globalTaskManager = new ExecTaskManager()
  }
  return globalTaskManager
}
