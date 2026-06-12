/**
 * Background Exec - wrapper around ExecTaskManager for background-specific operations
 *
 * This module provides backward compatibility and convenience methods
 * for background execution tasks. The actual task management is handled
 * by the unified ExecTaskManager.
 */

import type { Client } from "ssh2"
import { EventEmitter } from "events"
import { getGlobalTaskManager, type ExecTask, type TaskType } from "./exec-task-manager.js"
import { log } from "./logger.js"

export interface BackgroundTask extends ExecTask {
  // Background-specific fields
}

export interface BackgroundTaskOptions {
  cwd?: string
  env?: Record<string, string>
  persistent?: boolean
  detached?: boolean
  lineEnding?: "auto" | "lf" | "crlf" | "binary"
  encoding?: "auto" | "utf8" | "gbk" | "latin1"
  cancelSignal?: "TERM" | "HUP"
}

/**
 * Singleton EventEmitter that ExecTaskManager integrates with: when a task's
 * status transitions to a terminal state (completed/failed/cancelled/timeout),
 * BackgroundExecManager emits on this emitter so that `wait()` can resolve
 * immediately instead of polling. Each emit carries the final task snapshot.
 *
 * Falls back to polling when no emitter is wired (e.g. legacy callers that
 * don't register a listener), preserving the old behavior.
 */
const taskEvents = new EventEmitter()
taskEvents.setMaxListeners(0) // bounded by the number of unique waiters

export function emitBackgroundTaskEvent(task: ExecTask): void {
  taskEvents.emit("done", task.id, task)
}

// Register a global hook so exec-task-manager.ts can notify us without
// creating a circular module dependency. The function is called from
// finishTask() with a shallow snapshot of the task at terminal status.
;(globalThis as { __bgExecEmit?: (t: ExecTask) => void }).__bgExecEmit = (task) => {
  emitBackgroundTaskEvent(task)
}

export class BackgroundExecManager {
  private hostnameOverride: string | null = null

  constructor(hostnameOverride?: string) {
    if (hostnameOverride) {
      this.hostnameOverride = hostnameOverride
    }
  }

  async start(client: Client, command: string, options?: BackgroundTaskOptions): Promise<BackgroundTask> {
    const taskManager = getGlobalTaskManager()
    // Pass the explicit hostname into start() when available so we never
    // have to reach into ssh2's private fields. The override comes from
    // the BackgroundExecManager constructor; the reflection fallback is
    // now only used by unmigrated callers.
    const host = this.hostnameOverride || this.getHostIdentifier(client)

    const { id, promise } = taskManager.start(client, command, {
      type: "background",
      cwd: options?.cwd,
      env: options?.env,
      detached: options?.detached ?? true,
      host,
    })

    const task = taskManager.getStatus(id)
    if (!task) {
      throw new Error("Failed to create background task")
    }

    log("bg-exec", `[${id}] Started background task: ${command.slice(0, 100)}`)
    return task as BackgroundTask
  }

  getStatus(taskId: string): BackgroundTask | null {
    const taskManager = getGlobalTaskManager()
    return taskManager.getStatus(taskId) as BackgroundTask | null
  }

  list(hostname?: string): BackgroundTask[] {
    const taskManager = getGlobalTaskManager()
    const allTasks = taskManager.list(hostname)
    return allTasks.filter(t => t.type === "background") as BackgroundTask[]
  }

  getOutput(taskId: string): { stdout: string; stderr: string } | null {
    const taskManager = getGlobalTaskManager()
    return taskManager.getOutput(taskId)
  }

  getOutputSince(taskId: string, stdoutOffset: number, stderrOffset: number): { stdout: string; stderr: string } | null {
    const output = this.getOutput(taskId)
    if (!output) return null
    return {
      stdout: output.stdout.slice(stdoutOffset),
      stderr: output.stderr.slice(stderrOffset),
    }
  }

  cancel(taskId: string, options?: { signal?: "TERM" | "HUP"; client?: Client }): boolean {
    const taskManager = getGlobalTaskManager()
    const client = options?.client
    const signal = options?.signal ?? "TERM"
    if (!client) {
      log("bg-exec", `Cannot cancel task ${taskId}: no client provided`)
      return false
    }
    return taskManager.cancel(taskId, client, signal)
  }

  async wait(taskId: string, timeoutMs?: number): Promise<BackgroundTask> {
    const taskManager = getGlobalTaskManager()
    const checkTask = () => taskManager.getStatus(taskId)
    const initial = checkTask()
    if (!initial) throw new Error(`Task ${taskId} not found`)
    if (initial.status !== "running") return initial as BackgroundTask

    // Event-driven path: subscribe for the terminal transition and resolve as
    // soon as the emitter fires. A single setTimeout handles the timeout case
    // (no setInterval, so no steady-state CPU burn).
    return new Promise((resolve, reject) => {
      let settled = false
      let pollTimer: ReturnType<typeof setInterval> | null = null
      let timer: ReturnType<typeof setTimeout> | null = null

      const cleanup = () => {
        taskEvents.off("done", onDone)
        if (timer) { clearTimeout(timer); timer = null }
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
      }
      const finish = (task: ExecTask | null | undefined) => {
        if (settled) return
        settled = true
        cleanup()
        if (task) resolve(task as BackgroundTask)
        else resolve(checkTask() as BackgroundTask)
      }
      const onDone = (id: string, task: ExecTask) => {
        if (id === taskId) finish(task)
      }
      taskEvents.on("done", onDone)

      // Defensive polling fallback: if the emitter is never wired (legacy
      // mode), the wait would hang. A 1s poll covers that edge case.
      pollTimer = setInterval(() => {
        const e = checkTask()
        if (e && e.status !== "running") finish(e)
      }, 1000)

      if (timeoutMs) {
        timer = setTimeout(() => {
          if (settled) return
          settled = true
          cleanup()
          reject(new Error(`Wait timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      }
    })
  }

  remove(taskId: string): boolean {
    const taskManager = getGlobalTaskManager()
    return taskManager.remove(taskId)
  }

  private getHostIdentifier(client: Client): string {
    const sock: any = client
    if (sock._client && sock._client._config && sock._client._config.host) {
      return sock._client._config.host
    }
    return "unknown"
  }
}

export { getGlobalTaskManager }
export type { ExecTask, TaskType, TaskStatus, ExecResult } from "./exec-task-manager.js"
