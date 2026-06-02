/**
 * Remote Shell - execute commands on remote SSH sessions
 * Uses the unified ExecTaskManager to track all running tasks
 */

import type { Client } from "ssh2"
import { getGlobalTaskManager, type ExecResult } from "./exec-task-manager.js"
import { log } from "./logger.js"

/**
 * Execute a command on a remote host via an existing SSH client.
 * Returns when the command finishes (non-interactive).
 * All commands are tracked in the global task manager for visibility.
 */
export function remoteExec(
  client: Client,
  command: string,
  options?: { timeout?: number; cwd?: string; env?: Record<string, string> },
): Promise<ExecResult> {
  const taskManager = getGlobalTaskManager()
  const { id, promise } = taskManager.start(client, command, {
    type: "exec",
    cwd: options?.cwd,
    env: options?.env,
    timeout: options?.timeout,
  })

  log("exec", `[${id}] Starting: ${command.slice(0, 100)}${command.length > 100 ? "..." : ""}`)
  if (options?.timeout) {
    log("exec", `[${id}] Timeout: ${options.timeout}ms`)
  }

  return promise
}

/**
 * Execute a command on the last hop of a connection chain.
 * The chain must already be connected.
 */
export function execOnChain(
  clients: { client: Client }[],
  command: string,
  options?: { timeout?: number; cwd?: string; env?: Record<string, string> },
): Promise<ExecResult> {
  if (clients.length === 0) {
    throw new Error("No SSH clients in chain")
  }
  const finalClient = clients[clients.length - 1].client
  return remoteExec(finalClient, command, options)
}

export type { ExecResult } from "./exec-task-manager.js"
