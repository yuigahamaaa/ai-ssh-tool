#!/usr/bin/env node

/**
 * SSH Daemon - persistent background process that keeps SSH connections alive
 *
 * Usage:
 *   node daemon.js                    # start with defaults
 *   node daemon.js --idle-timeout 600 # 10 min idle timeout
 *   node daemon.js --help
 *
 * Listens on IPC (named pipe / Unix socket) for commands from CLI.
 */

import { createServer, type Server, type Socket } from "net"
import type { Client, ClientChannel } from "ssh2"
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "fs"
import { createHash } from "crypto"
import { spawn } from "child_process"
import { pathToFileURL } from "url"
import { SSHGateway } from "./gateway.js"
import { remoteExec } from "./remote-shell.js"
import { upload, download } from "./file-transfer.js"
import { PortForwardManager } from "./port-forwarding.js"
import { enableDebug, log, logError } from "./logger.js"
import {
  getPipePath,
  getPidPath,
  encodeMessage,
  IPCMessageParser,
  type IPCRequest,
  type IPCResponse,
  normalizeConfig,
} from "./ipc-protocol.js"
import { SchedulerService } from "./scheduler/scheduler-service.js"
import { BatchedPersistenceStore, PersistenceStore } from "./scheduler/persistence-store.js"
import { migrateExecTasks } from "./scheduler/migrator.js"
import type { AgentIdentity, HostIdentity, ScheduleRequest } from "./scheduler/types.js"

interface DaemonSession {
  sessionId: string
  configHash: string
}

interface CachedConfig {
  hash: string
  mtime: number
  content: string           // raw JSON string, avoids re-read on cache hit
  parsed?: Record<string, unknown>  // pre-parsed config object, avoids double JSON.parse
}

const BACKGROUND_HANDLE_TIMEOUT_MS = 5 * 60 * 1000

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function execScheduledStream(
  client: Client,
  command: string,
  timeoutMs: number,
  onOutput?: (stdout: string, stderr: string) => void,
  onPid?: (pid: number) => void,
): Promise<{ code: number; stdout: string; stderr: string; signal?: string }> {
  return new Promise((resolve, reject) => {
    const wrappedCommand = `echo "SSH_TOOL_PID:$$" >&2; exec ${command}`
    let pid: number | null = null
    let pidCaptured = false
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      fn()
    }

    client.exec(wrappedCommand, (err: Error | undefined, stream: ClientChannel) => {
      if (err) {
        settle(() => reject(new Error(`Failed to exec: ${err.message}`)))
        return
      }

      timer = setTimeout(() => {
        if (settled) return
        if (pid) {
          const killCmd = `kill -TERM ${pid} 2>/dev/null; sleep 0.1; kill -9 ${pid} 2>/dev/null; true`
          client.exec(killCmd, () => {})
        }
        try { stream.close() } catch {}
        settle(() => resolve({ code: 124, stdout: "", stderr: "", signal: "TERM" }))
      }, timeoutMs)

      stream.on("data", (data: Buffer) => {
        onOutput?.(data.toString(), "")
      })

      stream.stderr.on("data", (data: Buffer) => {
        const text = data.toString()
        if (!pidCaptured) {
          const pidMatch = text.match(/SSH_TOOL_PID:(\d+)/)
          if (pidMatch) {
            pid = parseInt(pidMatch[1], 10)
            onPid?.(pid)
            pidCaptured = true
            const remaining = text.replace(/SSH_TOOL_PID:\d+\n?/, "")
            if (remaining) onOutput?.("", remaining)
            return
          }
        }
        onOutput?.("", text)
      })

      stream.on("close", (code?: number, signal?: string) => {
        settle(() => resolve({ code: code ?? 0, stdout: "", stderr: "", signal }))
      })

      stream.on("error", (streamErr: Error) => {
        settle(() => reject(new Error(`Stream error: ${streamErr.message}`)))
      })
    })
  })
}

export class SSHDaemon {
  private gateway: SSHGateway
  private server: Server | null = null
  private pipePath: string
  private idleTimeoutMs: number
  private idleSweeper: ReturnType<typeof setInterval> | null = null
  private sockets = new Set<Socket>()
  private sessionMap = new Map<string, DaemonSession>() // configHash -> session
  private configCache = new Map<string, CachedConfig>() // path -> cached hash
  private startedAt = Date.now()
  private forwardManagers = new Map<string, PortForwardManager>()
  private scheduler: SchedulerService
  private stopping = false
  private readonly signalShutdownHandler = () => { this.shutdown().catch(() => {}) }

  constructor(opts?: { pipePath?: string; idleTimeoutMs?: number; scheduler?: SchedulerService }) {
    this.pipePath = opts?.pipePath ?? getPipePath()
    this.idleTimeoutMs = opts?.idleTimeoutMs ?? 10 * 60 * 1000 // 10 min default
    this.gateway = new SSHGateway({
      connectionTimeout: 15000,
      maxSessions: 50,
    })
    this.scheduler = opts?.scheduler ?? new SchedulerService({
      // Use batched persistence so a task's many state-transition writes
      // (create → queue → start → finish) coalesce into ~1 disk write per
      // 100ms quiet window instead of 6-8 synchronous writeFileSync calls
      // hitting the event loop on every transition.
      persistence: new BatchedPersistenceStore(new PersistenceStore()),
      runner: {
        start: async (task, onOutput) => {
          const conn = this.gateway.sessions.getConnection(task.sessionId)
          if (!conn) throw new Error(`Session ${task.sessionId} not found for scheduled task`)
          const client = conn.getFinalClient()
          const cmd = task.effectiveCwd
            ? `cd ${shellQuote(task.effectiveCwd)} && ${task.command}`
            : task.command
          return execScheduledStream(client, cmd, task.timeoutMs ?? 120_000, onOutput, (pid) => {
            task.pid = pid
          })
        },
        cancel: (task) => {
          // Backstop cancel: if the scheduler's own background-task
          // controller couldn't stop the stream (shouldn't happen, but
          // guards against partial setups), try killing by PID.
          if (!task.pid) return false
          const conn = this.gateway.sessions.getConnection(task.sessionId)
          if (!conn) return false
          const client = conn.getFinalClient()
          const killCmd = `kill -TERM -${task.pid} 2>/dev/null || kill -TERM ${task.pid} 2>/dev/null; sleep 0.5; kill -9 -${task.pid} 2>/dev/null || kill -9 ${task.pid} 2>/dev/null; true`
          client.exec(killCmd, () => {})
          return true
        },
        startBackground: (
          task: any,
          onOutput: (stdout: string, stderr: string) => void,
          onClose: (code: number, signal?: string) => void
        ) => {
          const conn = this.gateway.sessions.getConnection(task.sessionId)
          if (!conn) throw new Error(`Session ${task.sessionId} not found for background task`)
          const client = conn.getFinalClient()

          let fullCommand = task.command
          if (task.effectiveCwd) {
            fullCommand = `cd ${shellQuote(task.effectiveCwd)} && ${fullCommand}`
          }
          const wrappedCommand = `setsid sh -c 'echo "SSH_TOOL_PID:$$" >&2; exec sh -c "$1"' ssh-tool ${shellQuote(fullCommand)}`

          let currentPid: number | null = null
          let pidCaptured = false
          let closed = false
          let stream: ClientChannel | null = null
          let timeoutId: ReturnType<typeof setTimeout> | null = null

          const finalize = (code: number, signal?: string) => {
            if (closed) return
            closed = true
            if (timeoutId) { clearTimeout(timeoutId); timeoutId = null }
            if (stream) { try { stream.close() } catch { /* best-effort */ } }
            onClose(code, signal)
          }

          client.exec(wrappedCommand, (err, s) => {
            if (err) {
              logError("daemon", `Failed to start background task ${task.id}`, err)
              onOutput("", err.message)
              finalize(1)
              return
            }
            stream = s

            // Hard timeout: if the SSH stream never emits close/error for
            // 5 minutes (e.g. partition), force-stop so daemon shutdown isn't
            // blocked forever.
            timeoutId = setTimeout(() => {
              if (closed) return
              log("daemon", `Background task ${task.id} orphaned, force-stopping after ${BACKGROUND_HANDLE_TIMEOUT_MS}ms`)
              finalize(1, "SIGKILL")
            }, BACKGROUND_HANDLE_TIMEOUT_MS)

            stream.on("data", (data: Buffer) => {
              const text = data.toString()
              if (!pidCaptured) {
                const pidMatch = text.match(/SSH_TOOL_PID:(\d+)/)
                if (pidMatch) {
                  currentPid = parseInt(pidMatch[1])
                  task.pid = currentPid
                  pidCaptured = true
                  const remaining = text.replace(/SSH_TOOL_PID:\d+\n?/, '')
                  if (remaining) onOutput(remaining, "")
                } else {
                  onOutput(text, "")
                }
              } else {
                onOutput(text, "")
              }
            })

            stream.stderr.on("data", (data: Buffer) => {
              const text = data.toString()
              if (!pidCaptured) {
                const pidMatch = text.match(/SSH_TOOL_PID:(\d+)/)
                if (pidMatch) {
                  currentPid = parseInt(pidMatch[1])
                  task.pid = currentPid
                  pidCaptured = true
                  const remaining = text.replace(/SSH_TOOL_PID:\d+\n?/, '')
                  if (remaining) onOutput("", remaining)
                } else {
                  onOutput("", text)
                }
              } else {
                onOutput("", text)
              }
            })

            stream.on("close", (code?: number, signal?: string) => {
              finalize(code ?? 1, signal)
            })

            stream.on("error", (streamErr) => {
              onOutput("", streamErr.message)
              finalize(1)
            })
          })

          return {
            get pid() { return currentPid },
            stop: () => {
              if (closed) return
              if (currentPid) {
                const killCmd = `kill -TERM -${currentPid} 2>/dev/null || kill -TERM ${currentPid} 2>/dev/null; sleep 0.5; kill -9 -${currentPid} 2>/dev/null || kill -9 ${currentPid} 2>/dev/null; true`
                client.exec(killCmd, () => {})
              }
              finalize(128 + 15, "SIGTERM")
            }
          }
        }
      },
    })
  }

  async start(): Promise<void> {
    // Write PID file
    this.writePid()

    this.server = createServer((socket) => this.handleConnection(socket))

    // Singleton check: prevent duplicate daemon instances
    if (this.isExistingDaemonAlive()) {
      throw new Error("Daemon already running. Use the existing daemon instead of starting a new one.")
    }

    // Clean up stale socket file on Unix (only if no live daemon owns it)
    if (process.platform !== "win32" && existsSync(this.pipePath)) {
      try {
        unlinkSync(this.pipePath)
      } catch {
        // ignore
      }
    }

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.pipePath, () => resolve())
      this.server!.on("error", reject)
    })

    // Restrict socket access on Unix (owner only)
    if (process.platform !== "win32") {
      try {
        const { chmodSync } = await import("fs")
        chmodSync(this.pipePath, 0o600)
      } catch {
        // non-fatal
      }
    }

    // One-shot migration of legacy exec-tasks → scheduler layout. Idempotent;
    // counts are logged so operators can see the first-boot migration size.
    try {
      const homedir = process.env.HOME || process.env.USERPROFILE || ""
      const srcDir = `${homedir}/.ssh-tool/exec-tasks`
      const schedulerBase = `${homedir}/.ssh-tool/scheduler`
      const destTaskDir = `${schedulerBase}/tasks`
      const destOutputDir = `${schedulerBase}/outputs`
      const migration = migrateExecTasks({ srcDir, destTaskDir, destOutputDir })
      if (migration.migrated > 0 || migration.failed > 0) {
        log("daemon", `migrated ${migration.migrated} legacy tasks (skipped=${migration.skipped}, failed=${migration.failed})`)
      }
    } catch (err) {
      // Migration failure must not block daemon startup; legacy data is
      // preserved on disk and will be retried on next boot.
      log("daemon", `migrator threw: ${(err as Error).message}`)
    }

    // Start idle sweeper
    this.idleSweeper = setInterval(() => this.sweepIdle(), 30_000)

    // Graceful shutdown (cross-platform)
    process.on("SIGTERM", this.signalShutdownHandler)
    process.on("SIGINT", this.signalShutdownHandler)
    if (process.platform === "win32") {
      // Windows: handle Ctrl+C and process exit
      process.on("SIGHUP", this.signalShutdownHandler)
    }

    console.log(`[daemon] listening on ${this.pipePath}`)
    console.log(`[daemon] idle timeout: ${this.idleTimeoutMs / 1000}s`)
  }

  async shutdown(): Promise<void> {
    await this.stop()
  }

  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    console.log("[daemon] shutting down...")
    process.off("SIGTERM", this.signalShutdownHandler)
    process.off("SIGINT", this.signalShutdownHandler)
    if (process.platform === "win32") {
      process.off("SIGHUP", this.signalShutdownHandler)
    }
    if (this.idleSweeper) clearInterval(this.idleSweeper)
    this.idleSweeper = null
    // scheduler.dispose() stops any running background-task streams and
    // clears associated timers, so we don't need a separate handle map here.
    this.scheduler.dispose()
    await this.gateway.disconnectAll()
    this.forwardManagers.clear()
    for (const socket of this.sockets) {
      try { socket.end() } catch {}
      try { socket.destroy() } catch {}
    }
    this.sockets.clear()
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve())
      })
      this.server = null
    }
    this.removePid()
  }

  async handleFatal(err: Error, opts?: { restart?: boolean; exit?: boolean }): Promise<void> {
    const reason = `Daemon fatal error: ${err.message}`
    console.error(`[daemon] fatal: ${err.message}`)
    logError("daemon", "fatal error", err)

    try {
      const result = this.scheduler.abortActiveTasks(reason)
      log("daemon", "Aborted active scheduler tasks before fatal shutdown", result)
    } catch (abortErr: any) {
      log("daemon", "Failed to abort active scheduler tasks: " + abortErr.message)
    }

    try {
      await this.stop()
    } catch (stopErr: any) {
      log("daemon", "Failed to stop daemon cleanly: " + stopErr.message)
    }

    if (opts?.restart) {
      this.restartReplacement()
    }

    if (opts?.exit !== false) {
      process.exit(1)
    }
  }

  private handleConnection(socket: Socket): void {
    this.sockets.add(socket)
    const parser = new IPCMessageParser()

    socket.on("data", (data) => {
      try {
        parser.push(data, (msg) => {
          this.handleRequest(socket, msg as IPCRequest).catch((err) => {
            const resp: IPCResponse = {
              id: (msg as IPCRequest).id,
              ok: false,
              error: err.message,
            }
            socket.write(encodeMessage(resp))
          })
        })
      } catch (err: any) {
        // maxRemainderBytes limit exceeded or other parse error.
        // Send an error response so the client knows why the socket is closing,
        // then destroy the socket to prevent further malformed input.
        const errorResp: IPCResponse = {
          id: "max-remainder",
          ok: false,
          error: err.message,
        }
        socket.write(encodeMessage(errorResp))
        socket.destroy()
      }
    })

    socket.on("error", () => {
      // client disconnected
    })

    socket.on("close", () => {
      this.sockets.delete(socket)
      parser.reset()
    })
  }

  private async handleRequest(socket: Socket, req: IPCRequest): Promise<void> {
    log("daemon", `IPC request: ${req.action}`, { id: req.id.slice(0, 8) })
    let resp: IPCResponse

    switch (req.action) {
      case "ping":
        resp = {
          id: req.id,
          ok: true,
          data: {
            uptime: Math.floor((Date.now() - this.startedAt) / 1000),
            sessionCount: this.gateway.listSessions().length,
          },
        }
        break

      case "connect":
        resp = await this.handleConnect(req)
        break

      case "connectJson":
        resp = await this.handleConnectJson(req)
        break

      case "exec":
        resp = await this.handleExec(req)
        break

      case "disconnect":
        resp = await this.handleDisconnect(req)
        break

      case "list":
        resp = {
          id: req.id,
          ok: true,
          data: this.gateway.listSessions().map((s) => ({
            id: s.id,
            name: s.name,
            status: s.status,
            hops: s.hops,
            chainSummary: s.chainSummary,
            lastActivity: s.lastActivity,
          })),
        }
        break

      case "shutdown":
        resp = { id: req.id, ok: true, data: { message: "shutting down" } }
        socket.write(encodeMessage(resp))
        await this.shutdown()
        return

      case "transfer":
        resp = await this.handleTransfer(req)
        break

      case "bgExec":
        resp = await this.handleBgExec(req)
        break

      case "portForward":
        resp = await this.handlePortForward(req)
        break

      case "schedule":
        resp = await this.handleSchedule(req as any)
        break

      case "queueStatus":
        resp = this.handleQueueStatus(req as any)
        break

      case "waitTask":
        resp = await this.handleWaitTask(req as any)
        break

      case "dequeueTask":
        resp = this.handleDequeueTask(req as any)
        break

      case "setCwd":
        resp = this.handleSetCwd(req as any)
        break

      case "cancelTask":
        resp = this.handleCancelTask(req as any)
        break

      case "getTaskOutput":
        resp = this.handleGetTaskOutput(req as any)
        break

      case "getTaskStatus":
        resp = this.handleGetTaskStatus(req as any)
        break

      case "cleanupOutputs":
        resp = this.handleCleanupOutputs(req as any)
        break

      case "abortActiveTasks":
        resp = this.handleAbortActiveTasks(req as any)
        break

      default:
        resp = { id: (req as any).id ?? "", ok: false, error: `Unknown action: ${(req as any).action}` }
    }

    socket.write(encodeMessage(resp))
  }

  private async handleConnect(req: IPCRequest & { action: "connect" }): Promise<IPCResponse> {
    const { configPath } = req.params

    // Read config with mtime-based cache. The cache stores both the raw
    // content (for cache hits, to skip the readFileSync) and the parsed
    // object (for the second `JSON.parse` in the hit path, so we go from
    // 2-3 parses per connect to 1 only on the cold path).
    const stat = (await import("fs/promises")).stat
    const statResult = await stat(configPath)
    const cached = this.configCache.get(configPath)
    let configHash: string
    let config: any

    if (cached && cached.mtime === statResult.mtimeMs) {
      // Hot path: zero reads, zero parses.
      configHash = cached.hash
      config = cached.parsed
    } else {
      const configContent = readFileSync(configPath, "utf-8")
      // Parse exactly once, then feed the object to normalizeConfig.
      const parsed = JSON.parse(configContent)
      const normalized = normalizeConfig(parsed)
      configHash = createHash("md5").update(normalized).digest("hex")
      config = parsed
      this.configCache.set(configPath, { hash: configHash, mtime: statResult.mtimeMs, content: configContent, parsed })
    }

    const existing = this.sessionMap.get(configHash)
    if (existing) {
      const session = this.gateway.sessions.getSession(existing.sessionId)
      const connection = this.gateway.sessions.getConnection(existing.sessionId)
      if (session?.status === "connected" && connection?.isConnected()) {
        return { id: req.id, ok: true, data: { sessionId: existing.sessionId, reused: true, configHash } }
      }
      this.sessionMap.delete(configHash)
      if (session) {
        this.gateway.disconnect(existing.sessionId).catch(() => {})
        this.forwardManagers.delete(existing.sessionId)
      }
    }

    if (!config.target?.host || !config.target?.username) {
      return { id: req.id, ok: false, error: "Config must have target.host and target.username" }
    }

    const jumpHosts = (config.gateways ?? []).map((g: any) => ({
      host: g.host,
      port: g.port ?? 22,
      username: g.username,
      password: g.password,
      privateKey: g.privateKey,
    }))

    try {
      const session = await this.gateway.connectSimple({
        host: config.target.host,
        port: config.target.port ?? 22,
        username: config.target.username,
        password: config.target.password,
        privateKey: config.target.privateKey,
        jumpHosts,
        name: `daemon-${config.target.host}`,
      })

      this.sessionMap.set(configHash, { sessionId: session.id, configHash })
      return { id: req.id, ok: true, data: { sessionId: session.id, reused: false, configHash } }
    } catch (err: any) {
      // Clean up any error sessions created during the failed connection
      for (const [sid, entry] of this.sessionMap) {
        const s = this.gateway.sessions.getSession(entry.sessionId)
        if (s && s.status === "error") {
          this.gateway.disconnect(entry.sessionId).catch(() => {})
          this.cleanupSession(entry.sessionId)
        }
      }
      // Also clean up error sessions not in sessionMap (freshly created ones)
      for (const s of this.gateway.sessions.getSessionsByStatus("error")) {
        this.gateway.disconnect(s.id).catch(() => {})
        this.forwardManagers.delete(s.id)
      }
      return { id: req.id, ok: false, error: err.message }
    }
  }

  private async handleConnectJson(req: IPCRequest & { action: "connectJson" }): Promise<IPCResponse> {
    const { configJson } = req.params

    const normalized = normalizeConfig(configJson)
    const configHash = createHash("md5").update(normalized).digest("hex")

    const existing = this.sessionMap.get(configHash)
    if (existing) {
      const session = this.gateway.sessions.getSession(existing.sessionId)
      const connection = this.gateway.sessions.getConnection(existing.sessionId)
      if (session?.status === "connected" && connection?.isConnected()) {
        return { id: req.id, ok: true, data: { sessionId: existing.sessionId, reused: true, configHash } }
      }
      this.sessionMap.delete(configHash)
      if (session) {
        this.gateway.disconnect(existing.sessionId).catch(() => {})
        this.forwardManagers.delete(existing.sessionId)
      }
    }

    // Parse config and connect
    const config = JSON.parse(configJson)
    if (!config.target?.host || !config.target?.username) {
      return { id: req.id, ok: false, error: "Config must have target.host and target.username" }
    }

    const jumpHosts = (config.gateways ?? []).map((g: any) => ({
      host: g.host,
      port: g.port ?? 22,
      username: g.username,
      password: g.password,
      privateKey: g.privateKey,
    }))

    try {
      const session = await this.gateway.connectSimple({
        host: config.target.host,
        port: config.target.port ?? 22,
        username: config.target.username,
        password: config.target.password,
        privateKey: config.target.privateKey,
        jumpHosts,
        name: `daemon-${config.target.host}`,
      })

      this.sessionMap.set(configHash, { sessionId: session.id, configHash })
      return { id: req.id, ok: true, data: { sessionId: session.id, reused: false, configHash } }
    } catch (err: any) {
      for (const [sid, entry] of this.sessionMap) {
        const s = this.gateway.sessions.getSession(entry.sessionId)
        if (s && s.status === "error") {
          this.gateway.disconnect(entry.sessionId).catch(() => {})
          this.cleanupSession(entry.sessionId)
        }
      }
      for (const s of this.gateway.sessions.getSessionsByStatus("error")) {
        this.gateway.disconnect(s.id).catch(() => {})
        this.forwardManagers.delete(s.id)
      }
      return { id: req.id, ok: false, error: err.message }
    }
  }

  private async handleExec(req: IPCRequest & { action: "exec" }): Promise<IPCResponse> {
    const { sessionId, command, timeout } = req.params

    const connection = this.gateway.sessions.getConnection(sessionId)
    if (!connection) {
      return { id: req.id, ok: false, error: `Session ${sessionId} not found` }
    }

    try {
      const client = connection.getFinalClient()
      const result = await remoteExec(client, command, { timeout: timeout ?? 30000 })
      return { id: req.id, ok: true, data: result }
    } catch (err: any) {
      // Connection might be dead, clean up
      try {
        await this.gateway.disconnect(sessionId)
        this.cleanupSession(sessionId)
      } catch {
        // ignore cleanup errors
      }
      return { id: req.id, ok: false, error: err.message }
    }
  }

  private async handleSchedule(req: { id: string; params: ScheduleRequest }): Promise<IPCResponse> {
    try {
      const decision = this.scheduler.schedule(req.params)
      if (decision.action === "run_now" && decision.taskId && !req.params.background) {
        try {
          const task = await this.scheduler.waitTask(decision.taskId, req.params.timeoutMs ?? 120_000)
          if (task.status === "running" || task.status === "queued") {
            return {
              id: req.id,
              ok: true,
              data: {
                ...decision,
                action: task.status === "queued" ? "queued" : decision.action,
                taskId: task.id,
                reason: `${decision.reason} Command is still ${task.status}; use ssh_exec_status with task_id=${task.id}.`,
                waitTimedOut: true,
                result: undefined,
              },
            }
          }
          const output = this.scheduler.getTaskOutput(task.id, "tail")
          return {
            id: req.id,
            ok: true,
            data: {
              ...decision,
              result: {
                stdout: output.stdout,
                stderr: output.stderr,
                code: task.exitCode ?? 0,
                signal: task.signal ?? undefined,
                stdoutBytes: output.stdoutBytes,
                stderrBytes: output.stderrBytes,
                stdoutPath: output.stdoutPath,
                stderrPath: output.stderrPath,
                outputFiles: output.outputFiles,
                truncated: output.truncated,
                stdoutTruncated: output.stdoutTruncated,
                stderrTruncated: output.stderrTruncated,
                stdoutFileTruncated: output.stdoutFileTruncated,
                stderrFileTruncated: output.stderrFileTruncated,
              },
            },
          }
        } catch (waitErr: any) {
          return {
            id: req.id,
            ok: true,
            data: {
              ...decision,
              reason: decision.reason + " (wait failed: " + waitErr.message + ")",
            },
          }
        }
      }
      return { id: req.id, ok: true, data: decision }
    } catch (err: any) {
      return { id: req.id, ok: false, error: err.message }
    }
  }

  private handleQueueStatus(req: { id: string; params: { agent?: AgentIdentity; hostId?: string; limit?: number } }): IPCResponse {
    try {
      const status = this.scheduler.queueStatus(req.params.hostId, req.params.limit, req.params.agent?.id)
      return { id: req.id, ok: true, data: status }
    } catch (err: any) {
      return { id: req.id, ok: false, error: err.message }
    }
  }

  private async handleWaitTask(req: { id: string; params: { taskId: string; timeoutMs?: number } }): Promise<IPCResponse> {
    try {
      const task = await this.scheduler.waitTask(req.params.taskId, req.params.timeoutMs)
      return { id: req.id, ok: true, data: task }
    } catch (err: any) {
      return { id: req.id, ok: false, error: err.message }
    }
  }

  private handleDequeueTask(req: { id: string; params: { taskId: string; agent?: AgentIdentity } }): IPCResponse {
    try {
      const success = this.scheduler.dequeueTask(req.params.taskId)
      return { id: req.id, ok: true, data: { dequeued: success } }
    } catch (err: any) {
      return { id: req.id, ok: false, error: err.message }
    }
  }

  private handleSetCwd(req: { id: string; params: { agent: AgentIdentity; host: HostIdentity; cwd: string } }): IPCResponse {
    try {
      const cwd = this.scheduler.setCwd(req.params.agent.id, req.params.host.id, req.params.cwd)
      return { id: req.id, ok: true, data: { success: true, cwd, message: "已设置当前 AI 会话在该 host 上的默认 cwd；不会影响其他 AI。" } }
    } catch (err: any) {
      return { id: req.id, ok: false, error: err.message }
    }
  }

  private handleCancelTask(req: { id: string; params: { taskId: string } }): IPCResponse {
    try {
      const cancelled = this.scheduler.cancelTask(req.params.taskId)
      return { id: req.id, ok: true, data: { cancelled } }
    } catch (err: any) {
      return { id: req.id, ok: false, error: err.message }
    }
  }

  private handleGetTaskOutput(req: { id: string; params: { taskId: string; mode?: string } }): IPCResponse {
    try {
      const result = this.scheduler.getTaskOutput(req.params.taskId, req.params.mode as any)
      return { id: req.id, ok: true, data: result }
    } catch (err: any) {
      return { id: req.id, ok: false, error: err.message }
    }
  }

  private handleGetTaskStatus(req: { id: string; params: { taskId: string } }): IPCResponse {
    try {
      const task = this.scheduler.getTask(req.params.taskId)
      if (!task) return { id: req.id, ok: false, error: `Task ${req.params.taskId} not found` }
      return { id: req.id, ok: true, data: task }
    } catch (err: any) {
      return { id: req.id, ok: false, error: err.message }
    }
  }

  private handleCleanupOutputs(req: { id: string; params: Record<string, never> }): IPCResponse {
    try {
      const result = this.scheduler.cleanupOutputs()
      return { id: req.id, ok: true, data: result }
    } catch (err: any) {
      return { id: req.id, ok: false, error: err.message }
    }
  }

  private handleAbortActiveTasks(req: { id: string; params: { reason: string } }): IPCResponse {
    try {
      const result = this.scheduler.abortActiveTasks(req.params.reason)
      return { id: req.id, ok: true, data: result }
    } catch (err: any) {
      return { id: req.id, ok: false, error: err.message }
    }
  }

  private async handleDisconnect(req: IPCRequest & { action: "disconnect" }): Promise<IPCResponse> {
    const { sessionId } = req.params
    try {
      await this.gateway.disconnect(sessionId)
      for (const [hash, entry] of this.sessionMap) {
        if (entry.sessionId === sessionId) {
          this.sessionMap.delete(hash)
          break
        }
      }
      return { id: req.id, ok: true, data: { disconnected: sessionId } }
    } catch (err: any) {
      return { id: req.id, ok: false, error: err.message }
    }
  }

  private async handleTransfer(req: IPCRequest & { action: "transfer" }): Promise<IPCResponse> {
    const { sessionId, action, localPath, remotePath } = req.params
    const connection = this.gateway.sessions.getConnection(sessionId)
    if (!connection) {
      return { id: req.id, ok: false, error: `Session ${sessionId} not found` }
    }
    const client = connection.getFinalClient()
    try {
      let result
      switch (action) {
        case "upload":
          result = await upload(client, localPath, remotePath)
          break
        case "download":
          result = await download(client, remotePath, localPath)
          break
        default:
          return { id: req.id, ok: false, error: `Unknown transfer action: ${action}` }
      }
      return { id: req.id, ok: true, data: result }
    } catch (err: any) {
      return { id: req.id, ok: false, error: err.message }
    }
  }

  private async handleBgExec(req: IPCRequest & { action: "bgExec" }): Promise<IPCResponse> {
    const { sessionId, subcommand, command, taskId } = req.params
    try {
      switch (subcommand) {
        case "start": {
          if (!command) return { id: req.id, ok: false, error: "command is required" }
          // Use scheduler's background task mechanism
          const entry = this.sessionMap.get(sessionId) ?? Array.from(this.sessionMap.values()).find(e => e.sessionId === sessionId)
          const hId = entry?.configHash ?? sessionId.slice(0, 16)
          const decision = this.scheduler.schedule({
            agent: { id: "daemon-bgexec", clientType: "cli" },
            host: { id: hId, profileKey: hId, targetHost: "unknown", targetUser: "unknown", displayName: "bgexec" },
            sessionId,
            command,
            background: true,
            scheduler: "auto",
          })
          return { id: req.id, ok: true, data: { taskId: decision.taskId, status: decision.action, command } }
        }
        case "status": {
          if (!taskId) return { id: req.id, ok: false, error: "taskId is required" }
          const task = this.scheduler.getTask(taskId)
          if (!task) return { id: req.id, ok: false, error: `Task ${taskId} not found` }
          return { id: req.id, ok: true, data: task }
        }
        case "output": {
          if (!taskId) return { id: req.id, ok: false, error: "taskId is required" }
          const output = this.scheduler.getTaskOutput(taskId, "full")
          return { id: req.id, ok: true, data: output }
        }
        case "cancel": {
          if (!taskId) return { id: req.id, ok: false, error: "taskId is required" }
          const result = this.scheduler.cancelTask(taskId)
          return { id: req.id, ok: true, data: result }
        }
        case "list": {
          const statusResp = this.scheduler.queueStatus(Array.from(this.sessionMap.values()).find(e => e.sessionId === sessionId)?.configHash ?? sessionId.slice(0, 16))
          const tasks = [
            ...(statusResp.running || []).filter(t => t.status),
            ...(statusResp.queued || []).filter(t => t.status),
            ...(statusResp.recent || []).filter(t => t.status),
          ]
          return { id: req.id, ok: true, data: tasks }
        }
        default:
          return { id: req.id, ok: false, error: `Unknown bgExec subcommand: ${subcommand}` }
      }
    } catch (err: any) {
      return { id: req.id, ok: false, error: err.message }
    }
  }

  private async handlePortForward(req: IPCRequest & { action: "portForward" }): Promise<IPCResponse> {
    const { sessionId, subcommand, type, bindAddr, bindPort, dstAddr, dstPort, forwardId } = req.params
    const connection = this.gateway.sessions.getConnection(sessionId)
    if (!connection) {
      return { id: req.id, ok: false, error: `Session ${sessionId} not found` }
    }
    const client = connection.getFinalClient()
    try {
      let manager = this.forwardManagers.get(sessionId)
      if (!manager) {
        manager = new PortForwardManager(client)
        this.forwardManagers.set(sessionId, manager)
      }
      switch (subcommand) {
        case "start": {
          if (!bindAddr || !bindPort || !dstAddr || !dstPort) {
            return { id: req.id, ok: false, error: "bindAddr, bindPort, dstAddr, dstPort are required" }
          }
          if (type === "local") {
            const forward = await manager.localForward(bindAddr, bindPort, dstAddr, dstPort)
            return { id: req.id, ok: true, data: forward }
          } else if (type === "remote") {
            const forward = await manager.remoteForward(bindAddr, bindPort, dstAddr, dstPort)
            return { id: req.id, ok: true, data: forward }
          }
          return { id: req.id, ok: false, error: `Unknown forward type: ${type}` }
        }
        case "stop": {
          if (!forwardId) return { id: req.id, ok: false, error: "forwardId is required" }
          const stopped = await manager.stop(forwardId)
          return { id: req.id, ok: true, data: { stopped } }
        }
        case "list": {
          const forwards = manager.list()
          return { id: req.id, ok: true, data: forwards }
        }
        default:
          return { id: req.id, ok: false, error: `Unknown portForward subcommand: ${subcommand}` }
      }
    } catch (err: any) {
      return { id: req.id, ok: false, error: err.message }
    }
  }

  private sweepIdle(): void {
    const now = Date.now()
    for (const session of this.gateway.listSessions()) {
      if (session.status === "connected" && now - session.lastActivity > this.idleTimeoutMs) {
        console.log(`[daemon] idle timeout: disconnecting ${session.name} (${session.id})`)
        this.gateway.disconnect(session.id).catch(() => {})
        this.cleanupSession(session.id)
      }
    }
  }

  /**
   * Remove per-session bookkeeping (sessionMap entry + forwardManager). Called
   * on every path that disconnects a session so the maps don't grow unbounded
   * over the daemon's lifetime.
   */
  private cleanupSession(sessionId: string): void {
    this.forwardManagers.delete(sessionId)
    for (const [hash, entry] of this.sessionMap) {
      if (entry.sessionId === sessionId) {
        this.sessionMap.delete(hash)
        break
      }
    }
  }

  private isExistingDaemonAlive(): boolean {
    try {
      const pidPath = getPidPath()
      if (!existsSync(pidPath)) return false
      const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10)
      if (isNaN(pid) || pid <= 0) return false
      // The current process may have just written its own PID via writePid().
      // A daemon should never consider itself a duplicate of itself.
      if (pid === process.pid) return false
      // process.kill(pid, 0) checks if process is alive without sending a signal
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  private writePid(): void {
    try {
      writeFileSync(getPidPath(), String(process.pid), "utf-8")
    } catch {
      // non-fatal
    }
  }

  private removePid(): void {
    try {
      const pidPath = getPidPath()
      if (!existsSync(pidPath)) return
      const content = readFileSync(pidPath, "utf-8").trim()
      const recordedPid = parseInt(content, 10)
      // Only delete if PID matches current process to avoid removing another daemon's PID file
      if (recordedPid === process.pid) {
        unlinkSync(pidPath)
      }
    } catch {
      // ignore
    }
  }

  private restartReplacement(): void {
    const env = {
      ...process.env,
      SSH_TOOL_DAEMON_RESTART_COUNT: String(Number(process.env.SSH_TOOL_DAEMON_RESTART_COUNT ?? "0") + 1),
    }
    const restartCount = Number(env.SSH_TOOL_DAEMON_RESTART_COUNT)
    if (restartCount > 3) {
      log("daemon", "Not restarting daemon after fatal error: restart limit reached")
      return
    }

    const child = spawn(process.execPath, replacementDaemonArgs(process.argv.slice(1)), {
      detached: true,
      stdio: "ignore",
      env,
    })
    child.unref()
    // P2-7: without an 'error' handler, a failed spawn (e.g. ENOENT on
    // process.execPath) would emit an unhandled 'error' event and Node
    // would crash the daemon — exactly the failure mode the restart
    // is supposed to recover from.
    child.once("error", (err) => {
      log("daemon", `Replacement daemon spawn failed: ${err.message}`)
    })
    log("daemon", `Spawned replacement daemon pid=${child.pid ?? "unknown"}`)
  }
}

// --- Main ---

import { checkDeps } from "./check-deps.js"

function replacementDaemonArgs(args: string[]): string[] {
  const filtered: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--test-fatal-after-start") {
      i++
      continue
    }
    filtered.push(args[i])
  }
  return filtered
}

async function main() {
  checkDeps()
  const args = process.argv.slice(2)

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`SSH Daemon - persistent SSH connection manager

Usage:
  node daemon.js [options]

Options:
  --debug                   Enable debug logging (logs to <skill>/logs/debug-daemon-<time>.log)
  --idle-timeout <seconds>  Idle timeout in seconds (default: 600)
  --pipe <path>             IPC pipe/socket path (default: auto)
  --help, -h                Show this help
`)
    process.exit(0)
  }

  if (args.includes("--debug")) {
    let label = "daemon"
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--label" && i + 1 < args.length) {
        label = `daemon-${args[++i]}`
        break
      }
    }
    enableDebug({ label })
  }

  let idleTimeout = 10 * 60 * 1000
  let pipePath: string | undefined
  let testFatalAfterStartMs: number | undefined

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--idle-timeout" && i + 1 < args.length) {
      idleTimeout = parseInt(args[++i]) * 1000
    } else if (args[i] === "--pipe" && i + 1 < args.length) {
      pipePath = args[++i]
    } else if (args[i] === "--test-fatal-after-start" && i + 1 < args.length) {
      testFatalAfterStartMs = parseInt(args[++i], 10)
    }
  }

  const daemon = new SSHDaemon({ pipePath, idleTimeoutMs: idleTimeout })
  let handlingFatal = false
  const handleFatal = (err: Error) => {
    if (handlingFatal) {
      console.error(`[daemon] fatal during fatal handling: ${err.message}`)
      process.exit(1)
    }
    handlingFatal = true
    daemon.handleFatal(err, { restart: true, exit: true }).catch((fatalErr) => {
      console.error(`[daemon] fatal handler failed: ${fatalErr.message}`)
      process.exit(1)
    })
  }
  process.on("uncaughtException", handleFatal)
  process.on("unhandledRejection", (err) => {
    handleFatal(err instanceof Error ? err : new Error(String(err)))
  })

  await daemon.start()
  if (testFatalAfterStartMs !== undefined) {
    if (process.env.SSH_TOOL_ENABLE_TEST_HOOKS !== "1") {
      throw new Error("--test-fatal-after-start requires SSH_TOOL_ENABLE_TEST_HOOKS=1")
    }
    setTimeout(() => {
      handleFatal(new Error("test fatal"))
    }, testFatalAfterStartMs)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`[daemon] fatal: ${err.message}`)
    process.exit(1)
  })
}
