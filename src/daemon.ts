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
import { createHash, randomUUID } from "crypto"
import { spawn } from "child_process"
import { pathToFileURL } from "url"
import { SSHGateway } from "./gateway.js"
import { remoteExec, resolveRemoteCwd } from "./remote-shell.js"
import { targetIdentityHash } from "./mcp-scheduler-contract.js"
import { upload, download } from "./file-transfer.js"
import { PortForwardManager } from "./port-forwarding.js"
import { enableDebug, log, logError } from "./logger.js"
import {
  getPipePath,
  getPidPath,
  getPidPathCandidates,
  encodeMessage,
  IPCMessageParser,
  type IPCRequest,
  type IPCResponse,
  normalizeConfig,
} from "./ipc-protocol.js"
import { SchedulerService } from "./scheduler/scheduler-service.js"
import { BatchedPersistenceStore, PersistenceStore } from "./scheduler/persistence-store.js"
import { migrateExecTasks } from "./scheduler/migrator.js"
import type { AgentIdentity, HostIdentity, ScheduleRequest, ScheduledTask, TaskOutputResult } from "./scheduler/types.js"
import { shellQuote, splitTopLevelSemicolonCommands } from "./shell-quote.js"
import { getDialect } from "./remote-dialect/index.js"
import { getLegacyExecTasksDir, getSchedulerTasksDir, getSchedulerOutputsDir } from "./paths.js"
import { SshExecCoordinatorTransport, RemoteCoordinatorClient } from "./coordinator/client.js"
import { CoordinatorTaskScope } from "./coordinator/task-scope.js"

interface DaemonSession {
  sessionId: string
  configHash: string
  /** Remote target identity hash (host/port/user). Scheduler tasks are keyed
   *  by this, so rebinding can find the session even when the config hash
   *  (which includes credentials) differs from the task's hostId. */
  targetHash?: string
}

interface CachedConfig {
  hash: string
  mtime: number
  content: string           // raw JSON string, avoids re-read on cache hit
  parsed?: Record<string, unknown>  // pre-parsed config object, avoids double JSON.parse
}

const BACKGROUND_HANDLE_TIMEOUT_MS = 5 * 60 * 1000
/**
 * Safest "full" output size to ship over IPC. IPCMessageParser rejects frames
 * over 16MB; JSON serialization adds ~1.5-2x, so staying well under the frame
 * cap avoids both transfer failures and multi-copy memory spikes on the daemon.
 */
const FULL_IPC_SAFE_LIMIT = 8 * 1024 * 1024

/** IPC request lanes. Heavy resource users (exec/transfer/wait) are bounded
 *  independently; light requests are never blocked by them. */
type RequestLane = "light" | "exec" | "transfer" | "wait"

interface DaemonResourceLimits {
  maxInflightPerSocket: number
  maxInflightExec: number
  maxInflightTransfers: number
  maxInflightWaits: number
}

const DEFAULT_DAEMON_RESOURCE_LIMITS: DaemonResourceLimits = {
  maxInflightPerSocket: 16,
  maxInflightExec: 4,
  maxInflightTransfers: 2,
  maxInflightWaits: 32,
}

interface SocketRequestState {
  inflight: number
  closed: boolean
}

function execScheduledStreamSingle(
  client: Client,
  command: string,
  timeoutMs: number,
  onOutput?: (stdout: string, stderr: string) => void,
  onPid?: (pid: number) => void,
  sessionKey?: string,
): Promise<{ code: number; stdout: string; stderr: string; signal?: string }> {
  return new Promise((resolve, reject) => {
    const wrappedCommand = getDialect(sessionKey).buildExec(command)
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
          const killCmd = getDialect(sessionKey).buildKill(pid)
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
          const pidMatch = text.match(getDialect(sessionKey).pidMarkerPattern())
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

export async function execScheduledStream(
  client: Client,
  command: string,
  timeoutMs: number,
  onOutput?: (stdout: string, stderr: string) => void,
  onPid?: (pid: number) => void,
  cwd?: string,
  sessionKey?: string,
): Promise<{ code: number; stdout: string; stderr: string; signal?: string }> {
  const commands = splitTopLevelSemicolonCommands(command)
  if (commands.length <= 1) {
    const singleCommand = cwd ? `cd ${shellQuote(cwd)} && ${command}` : command
    return execScheduledStreamSingle(client, singleCommand, timeoutMs, onOutput, onPid, sessionKey)
  }

  let stdout = ""
  let stderr = ""
  let code = 0
  let signal: string | undefined
  for (const commandPart of commands) {
    const currentCommand = cwd ? `cd ${shellQuote(cwd)} && ${commandPart}` : commandPart
    const result = await execScheduledStreamSingle(client, currentCommand, timeoutMs, onOutput, onPid, sessionKey)
    stdout += result.stdout
    stderr += result.stderr
    code = result.code
    signal = result.signal
  }
  return { code, stdout, stderr, ...(signal ? { signal } : {}) }
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
  /**
   * In-flight connect promises keyed by config hash. Concurrent connect
   * requests for the same config share one underlying SSH connection instead
   * of racing to create duplicate sessions.
   */
  private pendingConnects = new Map<string, Promise<{ sessionId: string; configHash: string; reused: boolean }>>()
  private startedAt = Date.now()
  private forwardManagers = new Map<string, PortForwardManager>()
  private coordinatorScopes = new Map<string, CoordinatorTaskScope>()
  private coordinatorClientId = randomUUID()
  private coordinatorInstallationId = randomUUID()
  private coordinatorRegisteredClients = new Set<string>()
  private scheduler: SchedulerService
  private stopping = false
  private resourceLimits: DaemonResourceLimits
  private socketRequestStates = new WeakMap<Socket, SocketRequestState>()
  private inflightByLane: Record<RequestLane, number> = {
    light: 0,
    exec: 0,
    transfer: 0,
    wait: 0,
  }
  private readonly signalShutdownHandler = () => { this.shutdown().catch((err) => log("daemon", `signal shutdown failed: ${err.message}`)) }

  constructor(opts?: { pipePath?: string; idleTimeoutMs?: number; scheduler?: SchedulerService; resourceLimits?: Partial<DaemonResourceLimits> }) {
    this.pipePath = opts?.pipePath ?? getPipePath()
    this.idleTimeoutMs = opts?.idleTimeoutMs ?? 10 * 60 * 1000 // 10 min default
    this.resourceLimits = { ...DEFAULT_DAEMON_RESOURCE_LIMITS, ...opts?.resourceLimits }
    for (const key of ["maxInflightPerSocket", "maxInflightExec", "maxInflightTransfers", "maxInflightWaits"] as const) {
      const value = this.resourceLimits[key]
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`Invalid daemon resource limit: ${key} must be a positive integer`)
      }
    }
    this.gateway = new SSHGateway({
      connectionTimeout: 15000,
      maxSessions: 50,
    })
    this.scheduler = opts?.scheduler ?? new SchedulerService({
      hooks: {
        onTaskStarted: (task) => { this.beginCoordinatorTask(task) },
        onTaskFinished: (task) => { this.finishCoordinatorTask(task) },
      },
      // Use batched persistence so a task's many state-transition writes
      // (create → queue → start → finish) coalesce into ~1 disk write per
      // 100ms quiet window instead of 6-8 synchronous writeFileSync calls
      // hitting the event loop on every transition.
      persistence: new BatchedPersistenceStore(new PersistenceStore()),
      runner: {
        start: async (task, onOutput) => {
          const conn = this.resolveTaskConnection(task)
          if (!conn) throw new Error(`Session ${task.sessionId} not found for scheduled task`)
          const client = conn.getFinalClient()
          return execScheduledStream(client, task.command, task.timeoutMs ?? 120_000, onOutput, (pid) => {
            task.pid = pid
          }, task.effectiveCwd, task.hostId)
        },
        cancel: (task) => {
          // Backstop cancel: if the scheduler's own background-task
          // controller couldn't stop the stream (shouldn't happen, but
          // guards against partial setups), try killing by PID.
          if (!task.pid) return false
          // Only kill on the ORIGINAL session. If the task was rebound to a
          // different session (resolveTaskConnection mutates task.sessionId),
          // the recorded PID belongs to a process on the old (dead) session
          // and killing that PID on the new session risks killing an unrelated
          // process that reused the number.
          const direct = this.gateway.sessions.getConnection(task.sessionId)
          if (!direct || !direct.isConnected()) return false
          const client = direct.getFinalClient()
          const killCmd = getDialect(direct.getHostId()).buildKill(task.pid, { group: true })
          client.exec(killCmd, () => {})
          return true
        },
        startBackground: (
          task: any,
          onOutput: (stdout: string, stderr: string) => void,
          onClose: (code: number, signal?: string) => void
        ) => {
          const conn = this.resolveTaskConnection(task)
          if (!conn) throw new Error(`Session ${task.sessionId} not found for background task`)
          const client = conn.getFinalClient()
          const hostId = conn.getHostId()

          let fullCommand = task.command
          if (task.effectiveCwd) {
            fullCommand = `cd ${shellQuote(task.effectiveCwd)} && ${fullCommand}`
          }
          const wrappedCommand = getDialect(hostId).buildBackground(fullCommand)

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

          // exec 启动超时：在死 client 上 client.exec 的回调可能永远不触发，
          // 原本要等 5 分钟 hard timeout。这里加 30s 短超时，回调未触发就
          // 立即 finalize，让用户尽快看到失败而不是假死。
          let execStartTimeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
            if (closed) return
            if (!stream) {
              log("daemon", `Background task ${task.id} exec did not start within 30s, force-stopping (likely dead session)`)
              onOutput("", "exec did not start within 30s (session may be disconnected)")
              finalize(1, "SIGKILL")
            }
          }, 30_000)

          client.exec(wrappedCommand, (err, s) => {
            if (execStartTimeout) { clearTimeout(execStartTimeout); execStartTimeout = null }
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
                const pidMatch = text.match(getDialect(hostId).pidMarkerPattern())
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
                const pidMatch = text.match(getDialect(hostId).pidMarkerPattern())
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
                const killCmd = getDialect(hostId).buildKill(currentPid, { group: true })
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
      const migration = migrateExecTasks({
        srcDir: getLegacyExecTasksDir(),
        destTaskDir: getSchedulerTasksDir(),
        destOutputDir: getSchedulerOutputsDir(),
      })
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
    // Reject new connects and wait for in-flight ones to settle. A connect
    // that completes after this point would register a session that
    // disconnectAll below never sees; allSettled closes that window so no
    // SSH connection leaks past shutdown.
    const pendingConnects = Array.from(this.pendingConnects.values())
    this.pendingConnects.clear()
    if (pendingConnects.length > 0) {
      await Promise.allSettled(pendingConnects)
    }
    // scheduler.dispose() stops any running background-task streams and
    // clears associated timers, so we don't need a separate handle map here.
    this.scheduler.dispose()
    await Promise.allSettled(Array.from(this.coordinatorScopes.values()).map((scope) => scope.dispose()))
    this.coordinatorScopes.clear()
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

  private requestLane(req: IPCRequest): RequestLane {
    if (req.action === "exec") return "exec"
    if (req.action === "transfer") return "transfer"
    if (req.action === "waitTask") return "wait"
    return "light"
  }

  private laneLimit(lane: RequestLane): number {
    switch (lane) {
      case "exec": return this.resourceLimits.maxInflightExec
      case "transfer": return this.resourceLimits.maxInflightTransfers
      case "wait": return this.resourceLimits.maxInflightWaits
      case "light": return Number.MAX_SAFE_INTEGER
    }
  }

  /** Attempt to reserve capacity for one request. On success returns a
   *  once-only release handle; on overload returns the client-visible error. */
  private tryAcquireRequest(socket: Socket, req: IPCRequest): { release: () => void } | { error: string } {
    const state = this.socketRequestStates.get(socket)
    if (!state || state.closed) return { error: "RESOURCE_LIMIT_EXCEEDED: socket is closed" }
    if (state.inflight >= this.resourceLimits.maxInflightPerSocket) {
      return { error: "RESOURCE_LIMIT_EXCEEDED: too many concurrent socket requests; retry shortly" }
    }
    const lane = this.requestLane(req)
    if (this.inflightByLane[lane] >= this.laneLimit(lane)) {
      return { error: `RESOURCE_LIMIT_EXCEEDED: too many concurrent ${lane} requests; retry shortly` }
    }
    state.inflight++
    this.inflightByLane[lane]++
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        state.inflight--
        this.inflightByLane[lane]--
      },
    }
  }

  /** Write a response only when the socket is still open. Completed requests
   *  for a socket the client already dropped are silently discarded; the
   *  request's release() in its finally block still frees lane capacity. */
  private writeResponse(socket: Socket, resp: IPCResponse): void {
    const state = this.socketRequestStates.get(socket)
    if (!state || state.closed || socket.destroyed) return
    socket.write(encodeMessage(resp))
  }

  private handleConnection(socket: Socket): void {
    this.sockets.add(socket)
    this.socketRequestStates.set(socket, { inflight: 0, closed: false })
    const parser = new IPCMessageParser()

    socket.on("data", (data) => {
      try {
        parser.push(data, (msg) => {
          const req = msg as IPCRequest
          const acquired = this.tryAcquireRequest(socket, req)
          if ("error" in acquired) {
            this.writeResponse(socket, { id: req.id, ok: false, error: acquired.error })
            return
          }
          void this.handleRequest(socket, req)
            .catch((err) => {
              this.writeResponse(socket, { id: req.id, ok: false, error: err.message })
            })
            .finally(acquired.release)
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
        this.writeResponse(socket, errorResp)
        socket.destroy()
      }
    })

    socket.on("error", () => {
      // client disconnected
    })

    socket.on("close", () => {
      const state = this.socketRequestStates.get(socket)
      if (state) state.closed = true
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
        this.writeResponse(socket, resp)
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
        resp = await this.handleSetCwd(req as any)
        break

      case "getCwd":
        resp = this.handleGetCwd(req as any)
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

    this.writeResponse(socket, resp)
  }

  private async handleConnect(req: IPCRequest & { action: "connect" }): Promise<IPCResponse> {
    const { configPath } = req.params

    if (this.stopping) {
      return { id: req.id, ok: false, error: "Daemon is shutting down" }
    }

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
        this.gateway.disconnect(existing.sessionId).catch((err) => log("daemon", `disconnect stale session ${existing.sessionId.slice(0, 8)} failed: ${err.message}`))
        void this.cleanupSession(existing.sessionId)
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
      strictHostKeyChecking: g.strictHostKeyChecking,
      knownHostsPath: g.knownHostsPath,
    }))

    try {
      const data = await this.withPendingConnect(configHash, async () => {
        const session = await this.gateway.connectSimple({
          host: config.target.host,
          port: config.target.port ?? 22,
          username: config.target.username,
          password: config.target.password,
          privateKey: config.target.privateKey,
          strictHostKeyChecking: config.target.strictHostKeyChecking,
          knownHostsPath: config.target.knownHostsPath,
          jumpHosts,
          name: `daemon-${config.target.host}`,
        })
        this.sessionMap.set(configHash, {
          sessionId: session.id,
          configHash,
          targetHash: targetIdentityHash({ host: config.target.host, port: config.target.port ?? 22, username: config.target.username }),
        })
        return { sessionId: session.id, configHash, reused: false }
      })
      return { id: req.id, ok: true, data }
    } catch (err: any) {
      // Clean up any error sessions created during the failed connection
      for (const [sid, entry] of this.sessionMap) {
        const s = this.gateway.sessions.getSession(entry.sessionId)
        if (s && s.status === "error") {
          this.gateway.disconnect(entry.sessionId).catch((e) => log("daemon", `disconnect error session ${entry.sessionId.slice(0, 8)} failed: ${e.message}`))
          void this.cleanupSession(entry.sessionId)
        }
      }
      // Also clean up error sessions not in sessionMap (freshly created ones)
      for (const s of this.gateway.sessions.getSessionsByStatus("error")) {
        this.gateway.disconnect(s.id).catch((e) => log("daemon", `disconnect error session ${s.id.slice(0, 8)} failed: ${e.message}`))
        void this.cleanupSession(s.id)
      }
      return { id: req.id, ok: false, error: err.message }
    }
  }

  /**
   * Resolve the connection for a scheduled task. If the task's pinned session
   * is gone or dead (session dropped, or daemon restarted while the task was
   * queued), rebind to the current healthy session for the same host before
   * the command starts. The task has not executed yet at this point, so
   * rebinding cannot duplicate side effects.
   */
  private beginCoordinatorTask(task: ScheduledTask): void {
    if (task.classification.intent === "inspect" || task.classification.intent === "search") return
    const connection = this.resolveTaskConnection(task)
    if (!connection) return
    const client = connection.getFinalClient()
    const coordinator = new RemoteCoordinatorClient(new SshExecCoordinatorTransport(client))
    if (!this.coordinatorRegisteredClients.has(task.hostId)) {
      this.coordinatorRegisteredClients.add(task.hostId)
      void coordinator.registerClient({ clientId: this.coordinatorClientId, installationId: this.coordinatorInstallationId, operatorLabel: task.agentName ?? task.agentId, sshUser: "unknown", toolVersion: "ssh-tool" }).catch(() => {})
    }
    const scope = new CoordinatorTaskScope(
      coordinator,
      {
        clientId: this.coordinatorClientId,
        workspace: task.effectiveCwd ?? "/",
        kind: task.classification.intent === "build" ? "build" : task.classification.intent === "deploy" || task.classification.intent === "server" ? "service" : "write",
        summary: task.reason ?? task.classification.reason,
        ttlMs: Math.min(Math.max(task.timeoutMs ?? 120_000, 30_000), 24 * 60 * 60 * 1000),
        pid: task.pid ?? undefined,
        source: "ssh-tool",
      },
      false,
    )
    this.coordinatorScopes.set(task.id, scope)
    void scope.begin().catch(() => {})
  }

  private finishCoordinatorTask(task: ScheduledTask): void {
    const scope = this.coordinatorScopes.get(task.id)
    if (!scope) return
    this.coordinatorScopes.delete(task.id)
    const outcome = task.status === "completed" ? "success" : task.status === "cancelled" ? "cancelled" : "failed"
    void scope.finish(outcome).catch(() => {})
  }

  private resolveTaskConnection(task: { sessionId: string; hostId: string }) {
    const direct = this.gateway.sessions.getConnection(task.sessionId)
    if (direct && direct.isConnected()) return direct
    // Tasks are keyed by target identity hash (host/port/user), while
    // sessionMap is keyed by config hash (which also includes credentials).
    // Rebinding must therefore scan for an entry whose targetHash matches the
    // task's hostId — a plain sessionMap.get(task.hostId) would miss every
    // session because the keys live in different namespaces.
    const entry =
      Array.from(this.sessionMap.values()).find((e) => e.targetHash === task.hostId) ??
      this.sessionMap.get(task.hostId)
    if (entry) {
      const rebound = this.gateway.sessions.getConnection(entry.sessionId)
      if (rebound && rebound.isConnected()) {
        task.sessionId = entry.sessionId
        return rebound
      }
    }
    return undefined
  }

  /**
   * Deduplicate concurrent connects for the same config hash: the first
   * caller runs the connection, every concurrent caller awaits the same
   * in-flight promise (sharing both its success and its failure).
   */
  private withPendingConnect(
    configHash: string,
    connect: () => Promise<{ sessionId: string; configHash: string; reused: boolean }>,
  ): Promise<{ sessionId: string; configHash: string; reused: boolean }> {
    if (this.stopping) {
      return Promise.reject(new Error("Daemon is shutting down"))
    }
    const inflight = this.pendingConnects.get(configHash)
    if (inflight) return inflight
    const p = connect().finally(() => {
      if (this.pendingConnects.get(configHash) === p) {
        this.pendingConnects.delete(configHash)
      }
    })
    this.pendingConnects.set(configHash, p)
    return p
  }

  private async handleConnectJson(req: IPCRequest & { action: "connectJson" }): Promise<IPCResponse> {
    const { configJson } = req.params

    if (this.stopping) {
      return { id: req.id, ok: false, error: "Daemon is shutting down" }
    }

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
        this.gateway.disconnect(existing.sessionId).catch((err) => log("daemon", `disconnect stale session ${existing.sessionId.slice(0, 8)} failed: ${err.message}`))
        void this.cleanupSession(existing.sessionId)
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
      const data = await this.withPendingConnect(configHash, async () => {
        const session = await this.gateway.connectSimple({
          host: config.target.host,
          port: config.target.port ?? 22,
          username: config.target.username,
          password: config.target.password,
          privateKey: config.target.privateKey,
          jumpHosts,
          name: `daemon-${config.target.host}`,
        })
        this.sessionMap.set(configHash, {
          sessionId: session.id,
          configHash,
          targetHash: targetIdentityHash({ host: config.target.host, port: config.target.port ?? 22, username: config.target.username }),
        })
        return { sessionId: session.id, configHash, reused: false }
      })
      return { id: req.id, ok: true, data }
    } catch (err: any) {
      for (const [sid, entry] of this.sessionMap) {
        const s = this.gateway.sessions.getSession(entry.sessionId)
        if (s && s.status === "error") {
          this.gateway.disconnect(entry.sessionId).catch((e) => log("daemon", `disconnect error session ${entry.sessionId.slice(0, 8)} failed: ${e.message}`))
          void this.cleanupSession(entry.sessionId)
        }
      }
      for (const s of this.gateway.sessions.getSessionsByStatus("error")) {
        this.gateway.disconnect(s.id).catch((e) => log("daemon", `disconnect error session ${s.id.slice(0, 8)} failed: ${e.message}`))
        void this.cleanupSession(s.id)
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
      const result = await remoteExec(client, command, { timeout: timeout ?? 30000, sessionKey: connection.getHostId() })
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

  private async handleSetCwd(req: { id: string; params: { agent: AgentIdentity; host: HostIdentity; cwd: string; sessionId: string } }): Promise<IPCResponse> {
    try {
      const connection = this.gateway.sessions.getConnection(req.params.sessionId)
      if (!connection) {
        return { id: req.id, ok: false, error: `Session ${req.params.sessionId} not found` }
      }
      // Half-open sessions can leave client.exec callbacks pending forever.
      // Pre-check like handleTransfer/handleBgExec and clean up so the next
      // connectHostJson recreates the session instead of hanging the request.
      if (!connection.isConnected()) {
        try {
          await this.gateway.disconnect(req.params.sessionId)
          await this.cleanupSession(req.params.sessionId)
        } catch {
          // ignore cleanup errors
        }
        return { id: req.id, ok: false, error: `Session ${req.params.sessionId} is not connected` }
      }
      const previousCwd = this.scheduler.resolveCwd(req.params.agent.id, req.params.host.id)
      const cwd = await resolveRemoteCwd(connection.getFinalClient(), req.params.cwd, previousCwd)
      this.scheduler.setCwd(req.params.agent.id, req.params.host.id, cwd)
      return { id: req.id, ok: true, data: { success: true, cwd, message: "已设置当前 AI 会话在该 host 上的默认 cwd；不会影响其他 AI。" } }
    } catch (err: any) {
      return { id: req.id, ok: false, error: err.message }
    }
  }

  private handleGetCwd(req: { id: string; params: { agent: AgentIdentity; host: HostIdentity } }): IPCResponse {
    try {
      const state = this.scheduler.getCwdState(req.params.agent.id, req.params.host.id)
      return {
        id: req.id,
        ok: true,
        data: {
          hostId: req.params.host.id,
          profileName: req.params.host.displayName,
          targetHost: req.params.host.targetHost,
          targetUser: req.params.host.targetUser,
          virtualCwd: state?.cwd ?? null,
          updatedAt: state?.updatedAt ?? null,
        },
      }
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

  private getIpcSafeTaskOutput(
    taskId: string,
    mode: string | undefined,
  ): TaskOutputResult & { fullTruncated?: boolean; fullOutputUnavailableOverIpc?: boolean; message?: string } {
    const requestedMode = mode ?? "tail"
    if (requestedMode !== "full") {
      return this.scheduler.getTaskOutput(taskId, requestedMode as "tail" | "full")
    }
    // IPC frames are capped at 16MB (IPCMessageParser). A "full" read of
    // a large output would blow that cap AND allocate several copies of
    // the payload (file Buffer → string → JSON → socket → parse). Probe
    // the real byte counts first and fall back to a bounded tail when the
    // output is too large, pointing the caller at the on-disk paths.
    const preview = this.scheduler.getTaskOutput(taskId, "tail")
    const totalBytes = (preview.stdoutBytes ?? 0) + (preview.stderrBytes ?? 0)
    if (totalBytes <= FULL_IPC_SAFE_LIMIT) {
      return this.scheduler.getTaskOutput(taskId, "full")
    }
    return {
      ...preview,
      truncated: true,
      fullTruncated: true,
      fullOutputUnavailableOverIpc: true,
      message: `Output (${totalBytes} bytes) exceeds the IPC-safe limit (${FULL_IPC_SAFE_LIMIT} bytes). Use the on-disk stdoutPath/stderrPath files to read the full output.`,
    }
  }

  private handleGetTaskOutput(req: { id: string; params: { taskId: string; mode?: string } }): IPCResponse {
    try {
      const result = this.getIpcSafeTaskOutput(req.params.taskId, req.params.mode)
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
    const { sessionId, action, localPath, remotePath, options } = req.params
    const connection = this.gateway.sessions.getConnection(sessionId)
    if (!connection) {
      return { id: req.id, ok: false, error: `Session ${sessionId} not found` }
    }
    // Guard against half-open sessions the same way handleExec does: if the
    // SSHConnection already knows it's disconnected, don't even try the
    // transfer — just clean up so the next connectHostJson recreates the
    // session.
    if (!connection.isConnected()) {
      try {
        await this.gateway.disconnect(sessionId)
        await this.cleanupSession(sessionId)
      } catch {
        // ignore cleanup errors
      }
      return { id: req.id, ok: false, error: `Session ${sessionId} is not connected` }
    }
    const client = connection.getFinalClient()
    try {
      let result
      switch (action) {
        case "upload":
          result = await upload(client, localPath, remotePath, options)
          break
        case "download":
          result = await download(client, remotePath, localPath, options)
          break
        default:
          return { id: req.id, ok: false, error: `Unknown transfer action: ${action}` }
      }
      return { id: req.id, ok: true, data: result }
    } catch (err: any) {
      // Connection might be dead, clean up so the next connectHostJson
      // call recreates the session instead of reusing a stale one.
      try {
        await this.gateway.disconnect(sessionId)
        await this.cleanupSession(sessionId)
      } catch {
        // ignore cleanup errors
      }
      return { id: req.id, ok: false, error: err.message }
    }
  }

  private async handleBgExec(req: IPCRequest & { action: "bgExec" }): Promise<IPCResponse> {
    const { sessionId, subcommand, command, taskId } = req.params
    try {
      switch (subcommand) {
        case "start": {
          if (!command) return { id: req.id, ok: false, error: "command is required" }
          // 预检 session 是否还连着。死 session 上启动的 background task 会在
          // scheduler 的 startBackground runner 里 client.exec 失败，但回调可能
          // 不触发导致 task 卡 5 分钟才超时。这里提前拦截并清理，让 CLI 端
          // 触发重连。
          const bgConn = this.gateway.sessions.getConnection(sessionId)
          if (!bgConn || !bgConn.isConnected()) {
            try {
              await this.gateway.disconnect(sessionId)
              await this.cleanupSession(sessionId)
            } catch {
              // ignore cleanup errors
            }
            return { id: req.id, ok: false, error: `Session ${sessionId} is not connected` }
          }
          // Use scheduler's background task mechanism. The host id must be the
          // target identity hash (not the config hash / sessionId prefix) so
          // that queueStatus filtering and task rebinding share one namespace
          // with MCP/CLI scheduled tasks.
          const entry = this.sessionMap.get(sessionId) ?? Array.from(this.sessionMap.values()).find(e => e.sessionId === sessionId)
          const hId = entry?.targetHash ?? entry?.configHash ?? sessionId.slice(0, 16)
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
          const output = this.getIpcSafeTaskOutput(taskId, "full")
          return { id: req.id, ok: true, data: output }
        }
        case "cancel": {
          if (!taskId) return { id: req.id, ok: false, error: "taskId is required" }
          const result = this.scheduler.cancelTask(taskId)
          return { id: req.id, ok: true, data: result }
        }
        case "list": {
          const listEntry = Array.from(this.sessionMap.values()).find(e => e.sessionId === sessionId)
          const listHostId = listEntry?.targetHash ?? listEntry?.configHash ?? sessionId.slice(0, 16)
          const statusResp = this.scheduler.queueStatus(listHostId)
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
    // 预检 session 是否还连着，避免在死 client 上 localForward 静默"成功"
    // （server.listen 是本地操作，必然成功，但每个进来的连接都会失败）。
    if (!connection.isConnected()) {
      try {
        await this.gateway.disconnect(sessionId)
        await this.cleanupSession(sessionId)
      } catch {
        // ignore cleanup errors
      }
      return { id: req.id, ok: false, error: `Session ${sessionId} is not connected` }
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
      // 连接类错误时清理死 session（含 forwardManager.stopAll 释放本地端口），
      // 让下一次 connectHostJson 重建 session 而不是复用僵尸。
      const msg = err.message ?? ""
      if (/socket closed|EPIPE|ECONNRESET|not connected|Failed to open|connection lost/i.test(msg)) {
        try {
          await this.gateway.disconnect(sessionId)
          await this.cleanupSession(sessionId)
        } catch {
          // ignore cleanup errors
        }
      }
      return { id: req.id, ok: false, error: err.message }
    }
  }

  private sweepIdle(): void {
    const now = Date.now()
    for (const session of this.gateway.listSessions()) {
      if (session.status === "connected" && now - session.lastActivity > this.idleTimeoutMs) {
        console.log(`[daemon] idle timeout: disconnecting ${session.name} (${session.id})`)
        this.gateway.disconnect(session.id).catch((err) => log("daemon", `idle disconnect ${session.id.slice(0, 8)} failed: ${err.message}`))
        this.cleanupSession(session.id)
      }
    }
  }

  /**
   * Remove per-session bookkeeping (sessionMap entry + forwardManager). Called
   * on every path that disconnects a session so the maps don't grow unbounded
   * over the daemon's lifetime.
   */
  private async cleanupSession(sessionId: string): Promise<void> {
    // 必须先停 forwardManager 持有的本地 net.Server，否则端口会被孤儿
    // server 占住，重建同端口的 forward 会失败，用户只能重启 daemon 才能恢复。
    const manager = this.forwardManagers.get(sessionId)
    if (manager) {
      try {
        await manager.stopAll()
      } catch (err: any) {
        log("daemon", `stopAll forwards for session ${sessionId.slice(0, 8)} failed: ${err.message}`)
      }
      this.forwardManagers.delete(sessionId)
    }
    for (const [hash, entry] of this.sessionMap) {
      if (entry.sessionId === sessionId) {
        this.sessionMap.delete(hash)
        break
      }
    }
  }

  private isExistingDaemonAlive(): boolean {
    for (const pidPath of getPidPathCandidates()) {
      try {
        if (!existsSync(pidPath)) continue
        const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10)
        if (isNaN(pid) || pid <= 0) continue
        // The current process may have just written its own PID via writePid().
        // A daemon should never consider itself a duplicate of itself.
        if (pid === process.pid) continue
        // process.kill(pid, 0) checks if process is alive without sending a signal
        process.kill(pid, 0)
        return true
      } catch {
        continue
      }
    }
    return false
  }

  private writePid(): void {
    try {
      writeFileSync(getPidPath(), String(process.pid), "utf-8")
    } catch {
      // non-fatal
    }
  }

  private removePid(): void {
    for (const pidPath of getPidPathCandidates()) {
      try {
        if (!existsSync(pidPath)) continue
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
