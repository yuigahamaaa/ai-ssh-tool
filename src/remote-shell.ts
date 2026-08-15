/**
 * Remote Shell - execute commands on remote SSH sessions
 * Uses the unified ExecTaskManager to track all running tasks
 */

import type { Client } from "ssh2"
import { getGlobalTaskManager, type ExecResult } from "./exec-task-manager.js"
import { log } from "./logger.js"
import { getDialect } from "./remote-dialect/index.js"
import { psQuote } from "./remote-dialect/powershell.js"
import { shellQuote, splitTopLevelSemicolonCommands } from "./shell-quote.js"

/**
 * Execute a command on a remote host via an existing SSH client.
 * Returns when the command finishes (non-interactive).
 * All commands are tracked in the global task manager for visibility.
 */
function remoteExecSingle(
  client: Client,
  command: string,
  options?: { timeout?: number; cwd?: string; env?: Record<string, string>; host?: string; sessionKey?: string; force?: boolean },
): Promise<ExecResult> {
  const taskManager = getGlobalTaskManager()
  const { id, promise } = taskManager.start(client, command, {
    type: "exec",
    cwd: options?.cwd,
    env: options?.env,
    timeout: options?.timeout,
    host: options?.host,
    sessionKey: options?.sessionKey,
    force: options?.force,
  })

  log("exec", `[${id}] Starting: ${command.slice(0, 100)}${command.length > 100 ? "..." : ""}`)
  if (options?.timeout) {
    log("exec", `[${id}] Timeout: ${options.timeout}ms`)
  }

  return promise
}

export async function remoteExec(
  client: Client,
  command: string,
  options?: { timeout?: number; cwd?: string; env?: Record<string, string>; host?: string; splitSemicolons?: boolean; sessionKey?: string; force?: boolean },
): Promise<ExecResult> {
  const dialect = getDialect(options?.sessionKey)
  const split = options?.splitSemicolons !== false && dialect.supportsSemicolonSplit()
  const commands = split ? splitTopLevelSemicolonCommands(command) : [command]
  if (commands.length <= 1) return remoteExecSingle(client, command, options)

  let stdout = ""
  let stderr = ""
  let code = 0
  let signal: string | undefined
  for (const currentCommand of commands) {
    const result = await remoteExecSingle(client, currentCommand, options)
    stdout += result.stdout
    stderr += result.stderr
    code = result.code
    signal = result.signal
  }

  return { code, stdout, stderr, ...(signal ? { signal } : {}) }
}

/**
 * Execute a command on the last hop of a connection chain.
 * The chain must already be connected.
 */
export function execOnChain(
  clients: { client: Client }[],
  command: string,
  options?: { timeout?: number; cwd?: string; env?: Record<string, string>; host?: string; sessionKey?: string },
): Promise<ExecResult> {
  if (clients.length === 0) {
    throw new Error("No SSH clients in chain")
  }
  const finalClient = clients[clients.length - 1].client
  return remoteExec(finalClient, command, options)
}

export async function resolveRemoteCwd(
  client: Client,
  path: string,
  baseCwd?: string,
  sessionKey?: string,
): Promise<string> {
  const dialect = getDialect(sessionKey)
  let command: string
  if (dialect.kind === "posix") {
    command = `${baseCwd ? `cd ${shellQuote(baseCwd)} && ` : ""}cd ${shellQuote(path)} && pwd -P`
  } else if (dialect.kind === "powershell") {
    command = `${baseCwd ? `Set-Location -LiteralPath ${psQuote(baseCwd)}; ` : ""}Set-Location -LiteralPath ${psQuote(path)}; (Get-Location).Path`
  } else {
    command = `${baseCwd ? `cd /d "${baseCwd}" && ` : ""}cd /d "${path}" && cd`
  }
  const result = await execRemote(client, command, { timeout: 30000, sessionKey })
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `Unable to change directory to ${path}`)
  }
  const cwd = result.stdout.replace(/\r?\n$/, "")
  if (!cwd || !dialect.isValidAbsPath(cwd)) {
    throw new Error(`Remote directory resolution returned an invalid path for ${path}`)
  }
  return cwd
}

/**
 * Execute a command without registering it in the global task manager or the
 * scheduler. Used for internal bookkeeping probes (e.g. resolving the remote
 * cwd for ssh_cd) that should not appear as noise tasks in queue status.
 *
 * The timeout covers the ENTIRE exec lifecycle, starting before client.exec
 * is even called: on a dead client the exec callback may never fire, and
 * without an outer timer the promise would hang forever.
 */
/** Best-effort remote process termination. Never waits, never throws, and
 *  must not override the main exec's settled result. */
function killRemoteProcess(client: Client, pid: number, sessionKey?: string): void {
  const killCmd = getDialect(sessionKey).buildKill(pid)
  client.exec(killCmd, () => {})
}

export function execRemote(
  client: Client,
  command: string,
  options?: { timeout?: number; maxBufferBytes?: number; sessionKey?: string },
): Promise<{ code: number; stdout: string; stderr: string; signal?: string; stdoutTruncated?: boolean; stderrTruncated?: boolean; remoteProcessMayContinue?: boolean }> {
  const timeoutMs = options?.timeout
  const maxBufferBytes = options?.maxBufferBytes ?? 10 * 1024 * 1024
  const sessionKey = options?.sessionKey
  return new Promise((resolve, reject) => {
    const stdout: string[] = []
    const stderr: string[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let stdoutTruncated = false
    let stderrTruncated = false
    let pid: number | null = null
    let pidCaptured = false
    let streamRef: import("ssh2").ClientChannel | null = null
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      if (timer) { clearTimeout(timer); timer = null }
      fn()
    }

    if (timeoutMs) {
      timer = setTimeout(() => {
        settle(() => {
          if (pid) killRemoteProcess(client, pid, sessionKey)
          // Best-effort: close the channel so the remote command doesn't run
          // forever after the caller has already moved on.
          if (streamRef) {
            try { streamRef.close() } catch { /* best-effort */ }
          }
          resolve({
            code: 124,
            stdout: stdout.join(""),
            stderr: stderr.join(""),
            signal: "TERM",
            ...(!pid ? { remoteProcessMayContinue: true } : {}),
            ...(stdoutTruncated ? { stdoutTruncated: true } : {}),
            ...(stderrTruncated ? { stderrTruncated: true } : {}),
          })
        })
      }, timeoutMs)
    }

    const wrappedCommand = getDialect(sessionKey).buildExec(command)
    client.exec(wrappedCommand, (err: Error | undefined, stream: import("ssh2").ClientChannel) => {
      if (err) {
        settle(() => reject(new Error(`Failed to exec: ${err.message}`)))
        return
      }
      streamRef = stream
      stream.on("data", (data: Buffer) => {
        if (stdoutTruncated) return
        stdoutBytes += data.length
        if (stdoutBytes > maxBufferBytes) {
          stdoutTruncated = true
          settle(() => resolve({
            code: 124,
            stdout: stdout.join(""),
            stderr: stderr.join(""),
            signal: "TERM",
            ...(stdoutTruncated ? { stdoutTruncated: true } : {}),
            ...(stderrTruncated ? { stderrTruncated: true } : {}),
          }))
          if (pid) killRemoteProcess(client, pid, sessionKey)
          try { stream.close() } catch { /* best-effort */ }
          return
        }
        stdout.push(data.toString())
      })
      stream.stderr.on("data", (data: Buffer) => {
        if (stderrTruncated) return
        const text = data.toString()
        if (!pidCaptured) {
          const pidMatch = text.match(getDialect(sessionKey).pidMarkerPattern())
          if (pidMatch) {
            pid = parseInt(pidMatch[1], 10)
            pidCaptured = true
            const remaining = text.replace(/SSH_TOOL_PID:\d+\n?/, "")
            if (!remaining) return
            stderrBytes += Buffer.byteLength(remaining)
            if (stderrBytes > maxBufferBytes) {
              stderrTruncated = true
              settle(() => resolve({
                code: 124,
                stdout: stdout.join(""),
                stderr: stderr.join(""),
                signal: "TERM",
                ...(stderrTruncated ? { stderrTruncated: true } : {}),
              }))
              killRemoteProcess(client, pid)
              try { stream.close() } catch { /* best-effort */ }
              return
            }
            stderr.push(remaining)
            return
          }
        }
        stderrBytes += data.length
        if (stderrBytes > maxBufferBytes) {
          stderrTruncated = true
          settle(() => resolve({
            code: 124,
            stdout: stdout.join(""),
            stderr: stderr.join(""),
            signal: "TERM",
            ...(stdoutTruncated ? { stdoutTruncated: true } : {}),
            ...(stderrTruncated ? { stderrTruncated: true } : {}),
          }))
          if (pid) killRemoteProcess(client, pid, sessionKey)
          try { stream.close() } catch { /* best-effort */ }
          return
        }
        stderr.push(text)
      })
      stream.on("close", (code?: number, signal?: string) => {
        // ssh2 emits close without an exit code when the channel is dropped
        // abnormally (e.g. connection reset). Treat that as a failure instead
        // of silently reporting success.
        if (code === undefined) {
          settle(() => reject(new Error("Stream closed without an exit code (connection may have dropped)")))
          return
        }
        settle(() => resolve({
          code,
          stdout: stdout.join(""),
          stderr: stderr.join(""),
          signal,
          ...(stdoutTruncated ? { stdoutTruncated: true } : {}),
          ...(stderrTruncated ? { stderrTruncated: true } : {}),
        }))
      })
      stream.on("error", (streamErr: Error) => {
        settle(() => reject(new Error(`Stream error: ${streamErr.message}`)))
      })
    })
  })
}

export type { ExecResult } from "./exec-task-manager.js"
