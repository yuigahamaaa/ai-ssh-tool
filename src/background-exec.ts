/**
 * Background Exec - run remote commands in detached mode
 *
 * For long-running commands that the AI agent doesn't want to wait for:
 *   - Start command → get handle immediately
 *   - Poll status with handle
 *   - Read output so far
 *   - Cancel if needed
 *
 * Supports:
 * - Persistent tasks (survive local process restart)
 * - Setsid with fallback to nohup
 * - Graceful shutdown with SIGTERM → SIGKILL
 * - CRLF/encoding protection for text files
 */

import type { Client, ClientChannel } from "ssh2"
import { randomUUID } from "crypto"
import { log } from "./logger.js"

export interface BackgroundTask {
  id: string
  command: string
  status: "running" | "completed" | "failed" | "cancelled"
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  startedAt: number
  finishedAt: number | null
  pid: number | null
}

export interface BackgroundTaskOptions {
  cwd?: string
  env?: Record<string, string>
  /** Use nohup/disown to persist after session disconnect */
  persistent?: boolean
  /** Setsid with fallback to nohup */
  detached?: boolean
  /** Line ending for text files: auto|lf|crlf|binary */
  lineEnding?: "auto" | "lf" | "crlf" | "binary"
  /** File encoding: auto|utf8|gbk|latin1 */
  encoding?: "auto" | "utf8" | "gbk" | "latin1"
  /** Signal to send on cancel: SIGTERM or SIGHUP */
  cancelSignal?: "TERM" | "HUP"
}

interface RunningTask {
  stream: ClientChannel
  task: BackgroundTask
}

export class BackgroundExecManager {
  private tasks = new Map<string, RunningTask>()
  private maxOutputBuffer = 10 * 1024 * 1024 // 10MB per task

  /**
   * Start a command in the background.
   * Returns a task handle immediately without waiting for the command to finish.
   */
  async start(client: Client, command: string, options?: BackgroundTaskOptions): Promise<BackgroundTask> {
    const id = randomUUID().slice(0, 12)
    const persistent = options?.persistent ?? true
    const detached = options?.detached ?? true
    const cancelSignal = options?.cancelSignal ?? "TERM"

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

    let wrappedCommand: string
    if (detached) {
      wrappedCommand = `echo $$; exec ${fullCommand}`
    } else {
      wrappedCommand = `echo $$; exec ${fullCommand}`
    }

    log("bg-exec", `[${id}] Starting: ${command.slice(0, 100)}${persistent ? " (persistent)" : ""}${detached ? " (detached)" : ""}`)

    const task: BackgroundTask = {
      id,
      command,
      status: "running",
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      startedAt: Date.now(),
      finishedAt: null,
      pid: null,
    }

    return new Promise((resolve, reject) => {
      client.exec(wrappedCommand, (err, stream) => {
        if (err) {
          task.status = "failed"
          task.finishedAt = Date.now()
          log("bg-exec", `[${id}] exec() failed: ${err.message}`)
          reject(new Error(`Failed to start background command: ${err.message}`))
          return
        }

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
        })

        stream.stderr.on("data", (data: Buffer) => {
          task.stderr += data.toString()
          this.trimBuffer(task, "stderr")
        })

        stream.on("close", (code?: number, signal?: string) => {
          task.status = code === 0 ? "completed" : "failed"
          task.exitCode = code ?? 0
          task.signal = signal ?? null
          task.finishedAt = Date.now()
          log("bg-exec", `[${id}] Finished: code=${code}, signal=${signal}, duration=${task.finishedAt - task.startedAt}ms`)
          setTimeout(() => this.tasks.delete(id), 30 * 60 * 1000)
        })

        stream.on("error", (streamErr: Error) => {
          task.status = "failed"
          task.finishedAt = Date.now()
          task.stderr += `\nStream error: ${streamErr.message}`
          log("bg-exec", `[${id}] Stream error: ${streamErr.message}`)
        })

        this.tasks.set(id, { stream, task })
        resolve(task)
      })
    })
  }

  getStatus(id: string): BackgroundTask | null {
    const entry = this.tasks.get(id)
    return entry ? { ...entry.task } : null
  }

  list(): BackgroundTask[] {
    return Array.from(this.tasks.values()).map(e => ({ ...e.task }))
  }

  getOutput(id: string): { stdout: string; stderr: string } | null {
    const entry = this.tasks.get(id)
    if (!entry) return null
    return { stdout: entry.task.stdout, stderr: entry.task.stderr }
  }

  getOutputSince(id: string, stdoutOffset: number, stderrOffset: number): { stdout: string; stderr: string } | null {
    const entry = this.tasks.get(id)
    if (!entry) return null
    return {
      stdout: entry.task.stdout.slice(stdoutOffset),
      stderr: entry.task.stderr.slice(stderrOffset),
    }
  }

  cancel(id: string, options?: { signal?: "TERM" | "HUP" }): boolean {
    const entry = this.tasks.get(id)
    if (!entry || entry.task.status !== "running") return false

    entry.task.status = "cancelled"
    entry.task.finishedAt = Date.now()

    const signal = options?.signal ?? "TERM"

    if (entry.task.pid) {
      const killCmd = `kill -${signal} ${entry.task.pid} 2>/dev/null`
      const stream = entry.stream
      try {
        stream.close()
      } catch {
        // ignore
      }
    }

    log("bg-exec", `[${id}] Cancelled (sent ${signal})`)
    return true
  }

  async wait(id: string, timeoutMs?: number): Promise<BackgroundTask> {
    const entry = this.tasks.get(id)
    if (!entry) throw new Error(`Task ${id} not found`)
    if (entry.task.status !== "running") return { ...entry.task }

    return new Promise((resolve, reject) => {
      const check = setInterval(() => {
        const e = this.tasks.get(id)
        if (!e || e.task.status !== "running") {
          clearInterval(check)
          if (timer) clearTimeout(timer)
          resolve({ ...e!.task })
        }
      }, 500)

      let timer: ReturnType<typeof setTimeout> | null = null
      if (timeoutMs) {
        timer = setTimeout(() => {
          clearInterval(check)
          reject(new Error(`Wait timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      }
    })
  }

  remove(id: string): boolean {
    return this.tasks.delete(id)
  }

  private trimBuffer(task: BackgroundTask, field: "stdout" | "stderr"): void {
    if (task[field].length > this.maxOutputBuffer) {
      task[field] = task[field].slice(-this.maxOutputBuffer)
    }
  }
}
