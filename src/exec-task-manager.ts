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
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync, statSync, renameSync } from "fs"
import { tmpdir } from "os"
import { log } from "./logger.js"

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
}

export interface RunningTaskEntry {
  stream: ClientChannel
  task: ExecTask
  client: Client
  persistImmediate: boolean // true for background tasks, false for regular exec
}

function getTaskStorageDir(): string {
  const userDir = process.env.HOME || tmpdir()
  const storageDir = join(userDir, ".ssh-tool", "exec-tasks")
  if (!existsSync(storageDir)) {
    mkdirSync(storageDir, { recursive: true, mode: 0o700 })
  }
  return storageDir
}

function getTaskFilePath(taskId: string): string {
  return join(getTaskStorageDir(), `${taskId}.json`)
}

function getHostIdentifier(client: Client): string {
  const sock: any = client
  if (sock._client && sock._client._config && sock._client._config.host) {
    return sock._client._config.host
  }
  return "unknown"
}

export class ExecTaskManager {
  private tasks = new Map<string, RunningTaskEntry>()
  private maxOutputBuffer = 10 * 1024 * 1024
  private lastPersistAt: number = 0
  private lastCleanupAt: number = 0
  private PERSIST_INTERVAL = 1000
  private CLEANUP_INTERVAL = 5 * 60 * 1000
  private CLEANUP_THRESHOLD = 20
  private TASK_RETENTION_MS = 30 * 60 * 1000

  constructor() {
    this.loadTasksFromDisk()
    this.cleanupOldTasks()
  }

  private maybeCleanup(): void {
    const now = Date.now()
    const taskCount = this.tasks.size + this.countDiskTasks()
    if (now - this.lastCleanupAt > this.CLEANUP_INTERVAL || taskCount > this.CLEANUP_THRESHOLD) {
      this.cleanupOldTasks()
      this.lastCleanupAt = now
    }
  }

  private countDiskTasks(): number {
    try {
      const storageDir = getTaskStorageDir()
      if (!existsSync(storageDir)) return 0
      return readdirSync(storageDir).filter(f => f.endsWith(".json")).length
    } catch {
      return 0
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
        const stat = statSync(taskPath)
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
      if (now - this.lastPersistAt < this.PERSIST_INTERVAL) {
        return
      }
    }

    const taskPath = getTaskFilePath(entry.task.id)
    const tempPath = `${taskPath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    try {
      writeFileSync(tempPath, JSON.stringify(entry.task, null, 2), { mode: 0o600 })
      renameSync(tempPath, taskPath)
      this.lastPersistAt = Date.now()
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

  private trimBuffer(task: ExecTask, field: "stdout" | "stderr"): void {
    if (task[field].length > this.maxOutputBuffer) {
      task[field] = task[field].slice(-this.maxOutputBuffer)
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
    }
  ): { id: string; promise: Promise<ExecResult> } {
    const id = randomUUID().slice(0, 12)
    const taskType = options?.type ?? "exec"
    const isBackground = taskType === "background" || options?.timeout === undefined
    const persistImmediate = taskType === "background"

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

    const hostname = getHostIdentifier(client)
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
    }

    const entry: RunningTaskEntry = {
      stream: null as any,
      task,
      client,
      persistImmediate,
    }

    this.tasks.set(id, entry)
    if (persistImmediate) {
      this.saveTask(entry, true)
    }

    const promise = new Promise<ExecResult>((resolve, reject) => {
      const wrappedCommand = `echo "SSH_TOOL_PID:$$" >&2; exec ${fullCommand}`

      client.exec(wrappedCommand, (err, stream) => {
        if (err) {
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
            firstLine += text
            if (firstLine.includes("\n")) {
              const pidStr = firstLine.split("\n")[0].trim()
              const pid = parseInt(pidStr)
              if (!isNaN(pid)) {
                task.pid = pid
                pidCaptured = true
                task.updatedAt = Date.now()
                if (persistImmediate) this.saveTask(entry, true)
                const remaining = firstLine.slice(firstLine.indexOf("\n") + 1) + text.slice(firstLine.length)
                if (remaining) {
                  task.stdout += remaining
                  this.trimBuffer(task, "stdout")
                }
              } else {
                pidCaptured = true
                task.stdout += firstLine
                this.trimBuffer(task, "stdout")
              }
              firstLine = ""
            }
          } else {
            task.stdout += text
            this.trimBuffer(task, "stdout")
          }
          task.updatedAt = Date.now()
          this.saveTask(entry, false)
        })

        stream.stderr.on("data", (data: Buffer) => {
          const text = data.toString()
          if (!pidCaptured) {
            const pidMatch = text.match(/SSH_TOOL_PID:(\d+)/)
            if (pidMatch) {
              task.pid = parseInt(pidMatch[1])
              pidCaptured = true
              const remaining = text.replace(/SSH_TOOL_PID:\d+\n?/, "")
              if (remaining) {
                task.stderr += remaining
                this.trimBuffer(task, "stderr")
              }
              task.updatedAt = Date.now()
              if (persistImmediate) this.saveTask(entry, true)
              return
            }
          }
          task.stderr += text
          this.trimBuffer(task, "stderr")
          task.updatedAt = Date.now()
          this.saveTask(entry, false)
        })

        stream.on("close", (code?: number, signal?: string) => {
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
          this.finishTask(id, "failed", 1, undefined, streamErr.message)
          reject(new Error(`Stream error: ${streamErr.message}`))
        })

        if (options?.timeout && options.timeout > 0) {
          setTimeout(() => {
            const currentTask = this.tasks.get(id)
            if (currentTask && currentTask.task.status === "running") {
              this.cancel(id, client, "TERM")
              this.finishTask(id, "timeout", 124, undefined)
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

    if (entry.persistImmediate) {
      this.saveTask(entry, true)
    }

    log("exec-task", `Task ${id} finished: ${status}, code=${exitCode}, signal=${signal}`)

    setTimeout(() => {
      this.tasks.delete(id)
      this.deleteTaskFile(id)
    }, this.TASK_RETENTION_MS)
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

    if (entry.stream) {
      try {
        entry.stream.close()
      } catch {}
    }

    this.finishTask(id, "cancelled", 130, signal)
    return true
  }

  getStatus(id: string): ExecTask | null {
    const entry = this.tasks.get(id)
    if (entry) {
      return { ...entry.task }
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

    const tasks: ExecTask[] = []
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
            tasks.push(task)
          }
        } catch {}
      }
    }

    for (const [id, entry] of this.tasks) {
      const idx = tasks.findIndex(t => t.id === id)
      if (idx >= 0) {
        tasks[idx] = { ...entry.task }
      } else if (!hostname || entry.task.hostname === hostname) {
        tasks.push({ ...entry.task })
      }
    }

    tasks.sort((a, b) => b.startedAt - a.startedAt)
    return tasks
  }

  getOutput(id: string): { stdout: string; stderr: string } | null {
    const entry = this.tasks.get(id)
    if (entry) {
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
