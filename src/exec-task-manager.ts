/**
 * Exec Task Manager - compatibility facade for SSH execution tasks
 *
 * New tasks are scheduled through SchedulerService and persisted in the
 * scheduler store. The legacy exec-tasks directory remains readable only
 * as a fallback for old snapshots that pre-date the scheduler migration.
 */

import type { Client, ClientChannel } from "ssh2"
import { randomUUID } from "crypto"
import { join } from "path"
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync, renameSync } from "fs"
import { homedir } from "os"
import { log } from "./logger.js"
import { SchedulerService } from "./scheduler/scheduler-service.js"
import type { ScheduleRequest, TaskRunner } from "./scheduler/types.js"

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
  persistImmediate: boolean // legacy disk fallback path only
  stdoutChunks: Buffer[]    // legacy runtime fallback path only
  stderrChunks: Buffer[]    // legacy runtime fallback path only
  chunksFlushed: boolean    // legacy runtime fallback path only
  finished: boolean         // legacy runtime fallback path only
  lastPersistAt: number     // legacy disk fallback path only
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
  /**
   * Scheduler-owned source of truth for new tasks. ExecTaskManager keeps
   * the old public API, but start()/cancel()/read paths delegate lifecycle,
   * output persistence, listing, and cancellation to SchedulerService.
   * The local `tasks` map and `~/.ssh-tool/exec-tasks` readers remain only
   * as fallback compatibility for old runtime/disk snapshots.
   */
  private scheduler: SchedulerService

  constructor(opts?: { scheduler?: SchedulerService }) {
    this.scheduler =
      opts?.scheduler ??
      new SchedulerService({
        runner: {
          start: async () => ({ code: 0, stdout: "", stderr: "" }),
          startBackground: () => {},
        } satisfies TaskRunner,
      })
    this.loadTasksFromDisk()
    this.cleanupOldTasks()
  }

  dispose(): void {
    this.scheduler.dispose()
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
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let stream: ClientChannel | null = null
    let pid: number | null = null
    let settled = false
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null
    const stopCurrent = (): void => {
      if (pid) {
        const killCmd = `kill -TERM ${pid} 2>/dev/null; sleep 0.1; kill -9 ${pid} 2>/dev/null; true`
        client.exec(killCmd, () => {})
      }
      if (stream) {
        try { stream.close() } catch {}
      }
    }
    // Keep compatibility with the legacy promise result. Scheduler/OutputStore
    // remain the authoritative task/output stores; these closure-local chunks
    // are released when the task settles.
    const resultPromise = new Promise<ExecResult>((resolve, reject) => {
      const finish = (code: number, signal?: string): void => {
        if (settled) return
        settled = true
        if (timeoutTimer) clearTimeout(timeoutTimer)
        const result = {
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          code,
          ...(signal ? { signal } : {}),
        }
        resolve(result)
      }

      const fail = (err: Error): void => {
        if (settled) return
        settled = true
        if (timeoutTimer) clearTimeout(timeoutTimer)
        reject(err)
      }

      const openSshTask = (
        onOutput: ((stdout: string, stderr: string) => void) | undefined,
        onClose: (code: number, signal?: string) => void,
        onError: (err: Error) => void,
      ): void => {
        const wrappedCommand = `echo "SSH_TOOL_PID:$$" >&2; exec ${fullCommand}`
        try {
          client.exec(wrappedCommand, (err, openedStream) => {
            if (err) {
              onError(new Error(`Failed to exec: ${err.message}`))
              return
            }

            stream = openedStream
            let pidCaptured = false

            openedStream.on("data", (data: Buffer) => {
              stdoutChunks.push(data)
              this.trimChunks(stdoutChunks)
              onOutput?.(data.toString("utf8"), "")
            })

            openedStream.stderr.on("data", (data: Buffer) => {
              const text = data.toString()
              if (!pidCaptured) {
                let pidMatch = text.match(/SSH_TOOL_PID:(\d+)/)
                if (!pidMatch) pidMatch = text.match(/SSH_TOOL_NOHUP_PID:(\d+)/)
                if (pidMatch) {
                  pid = parseInt(pidMatch[1])
                  pidCaptured = true
                  const remaining = text.replace(/SSH_TOOL_(NOHUP_)?PID:\d+\n?/g, "")
                  if (remaining) {
                    const remainingBuffer = Buffer.from(remaining)
                    stderrChunks.push(remainingBuffer)
                    this.trimChunks(stderrChunks)
                    onOutput?.("", remaining)
                  }
                  return
                }
              }
              stderrChunks.push(data)
              this.trimChunks(stderrChunks)
              onOutput?.("", data.toString("utf8"))
            })

            openedStream.on("close", (code?: number, signal?: string) => {
              onClose(code ?? 0, signal ?? undefined)
            })

            openedStream.on("error", (streamErr: Error) => {
              onError(new Error(`Stream error: ${streamErr.message}`))
            })

            if (options?.timeout && options.timeout > 0) {
              timeoutTimer = setTimeout(() => {
                stopCurrent()
                onError(new Error(`Command timed out after ${options.timeout}ms`))
              }, options.timeout)
            }
          })
        } catch (err) {
          onError(err instanceof Error ? err : new Error(String(err)))
        }
      }

      const runner: TaskRunner = {
        start: (_task, onOutput) => {
          const promise = new Promise<ExecResult>((runResolve, runReject) => {
            openSshTask(
              onOutput,
              (code, signal) => {
                finish(code, signal)
                runResolve({
                  stdout: Buffer.concat(stdoutChunks).toString("utf8"),
                  stderr: Buffer.concat(stderrChunks).toString("utf8"),
                  code,
                  ...(signal ? { signal } : {}),
                })
              },
              (err) => {
                fail(err)
                runReject(err)
              },
            )
          })

          return {
            promise,
            stop: stopCurrent,
          }
        },
        cancel: () => {
          stopCurrent()
          return true
        },
        startBackground: (_task, onOutput, onClose) => {
          openSshTask(
            onOutput,
            (code, signal) => {
              finish(code, signal)
              onClose(code, signal)
            },
            (err) => {
              fail(err)
              onClose(1)
            },
          )
          return { stop: stopCurrent }
        },
      }

      const decision = this.scheduler.runWithRunner({
        id,
        agent: { id: "exec-task-manager", name: "exec-task-manager", clientType: "internal" },
        host: { id: hostname, profileKey: options?.profileKey ?? "", targetHost: hostname, targetUser: "", displayName: hostname },
        sessionId: options?.sessionId ?? id,
        command,
        ...(options?.cwd ? { cwd: options.cwd } : {}),
        scheduler: "bypass",
        reason: "exec-task-manager facade",
        background: taskType === "background",
      }, runner)

      if (decision.action !== "run_now" && decision.action !== "queued") {
        reject(new Error(decision.reason))
      }
    })

    return { id, promise: resultPromise }
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

  }

  cancel(id: string, client: Client, signal: "TERM" | "HUP" = "TERM"): boolean {
    const schedulerCancelled = this.scheduler.cancelTask(id)
    if (schedulerCancelled) return true

    const entry = this.tasks.get(id)
    if (!entry) return false

    if (entry.task.status !== "running") {
      return false
    }

    if (entry.finished) return false
    entry.finished = true

    const pid = entry.task.pid
    if (pid && client) {
      const killCmd = `kill -${signal} ${pid} 2>/dev/null; sleep 0.1; kill -9 ${pid} 2>/dev/null; true`
      log("exec-task", `Cancelling task ${id} PID ${pid}`)
      client.exec(killCmd, () => {})
    }

    if (!entry.chunksFlushed) {
      entry.chunksFlushed = true
      entry.task.stdout = Buffer.concat(entry.stdoutChunks).toString("utf8")
      entry.task.stderr = Buffer.concat(entry.stderrChunks).toString("utf8")
    }

    if (entry.stream) {
      try {
        entry.stream.close()
      } catch {}
    }

    this.finishTask(id, "cancelled", 130, signal)
    try {
      this.scheduler.finishExternalTask(id, {
        code: 130,
        stdout: "",
        stderr: "",
        signal,
        status: "cancelled",
      })
    } catch (err) {
      log("exec-task", `scheduler.finishExternalTask failed for ${id}: ${(err as Error).message}`)
    }

    return true
  }

  getStatus(id: string): ExecTask | null {
    // Scheduler delegation: scheduler is the source of truth for tasks
    // created via the modern path. Stage 2 / Task 2.3.
    if (this.scheduler) {
      const st = this.scheduler.getTask(id)
      if (st) {
        return this.schedulerTaskToExecTask(st)
      }
    }

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

    // Scheduler delegation: include scheduler-owned tasks first so they
    // take priority over legacy disk snapshots of the same id (a migrated
    // task that was re-run via the scheduler). Stage 2 / Task 2.3.
    if (this.scheduler) {
      for (const st of this.scheduler.listTasks(hostname)) {
        merged.set(st.id, this.schedulerTaskToExecTask(st))
      }
    }

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
    // Scheduler delegation first.
    if (this.scheduler) {
      const st = this.scheduler.getTask(id)
      if (st) {
        const out = this.scheduler.getTaskOutput(id, "full")
        return { stdout: out.stdout, stderr: out.stderr }
      }
    }

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

  /**
   * Convert a scheduler-owned ScheduledTask into the legacy ExecTask shape
   * so existing consumers (CLI status, MCP list, etc.) keep working.
   * Stage 2 / Task 2.3.
   */
  private schedulerTaskToExecTask(st: import("./scheduler/types.js").ScheduledTask): ExecTask {
    return {
      id: st.id,
      type: st.background ? "background" : "exec",
      command: st.command,
      status: st.status === "running"
        ? "running"
        : st.status === "completed"
          ? "completed"
          : st.status === "queued"
            ? "running" // legacy "queued" maps to "running" so the CLI can show progress
            : st.status === "failed"
              ? "failed"
              : st.status === "cancelled"
                ? "cancelled"
                : st.status === "timeout"
                  ? "timeout"
                  : "failed",
      exitCode: st.exitCode ?? null,
      signal: st.signal ?? null,
      stdout: "", // legacy callers use getOutput(id) for output
      stderr: "",
      startedAt: st.startedAt ?? st.updatedAt,
      finishedAt: st.finishedAt ?? null,
      pid: st.pid ?? null,
      hostname: st.hostId,
      createdAt: st.updatedAt,
      updatedAt: st.updatedAt,
      profileKey: undefined,
      sessionId: st.sessionId,
      cwd: st.effectiveCwd ?? undefined,
    }
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
