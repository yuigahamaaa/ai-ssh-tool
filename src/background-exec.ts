/**
 * Background Exec - wrapper around ExecTaskManager for background-specific operations
 *
 * This module provides backward compatibility and convenience methods
 * for background execution tasks. The actual task management is handled
 * by the unified ExecTaskManager.
 */

import type { Client } from "ssh2"
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

export class BackgroundExecManager {
  private hostnameOverride: string | null = null

  constructor(hostnameOverride?: string) {
    if (hostnameOverride) {
      this.hostnameOverride = hostnameOverride
    }
  }

  async start(client: Client, command: string, options?: BackgroundTaskOptions): Promise<BackgroundTask> {
    const taskManager = getGlobalTaskManager()
    const hostname = this.hostnameOverride || this.getHostIdentifier(client)

    const { id, promise } = taskManager.start(client, command, {
      type: "background",
      cwd: options?.cwd,
      env: options?.env,
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
    let entry = checkTask()
    if (!entry) throw new Error(`Task ${taskId} not found`)
    if (entry.status !== "running") return entry as BackgroundTask

    return new Promise((resolve, reject) => {
      const check = setInterval(() => {
        const e = checkTask()
        if (!e || e.status !== "running") {
          clearInterval(check)
          if (timer) clearTimeout(timer)
          resolve(e as BackgroundTask)
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
