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
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "fs"
import { createHash } from "crypto"
import { SSHGateway } from "./gateway.js"
import { remoteExec } from "./remote-shell.js"
import { BackgroundExecManager } from "./background-exec.js"
import { upload, download } from "./file-transfer.js"
import { PortForwardManager } from "./port-forwarding.js"
import { enableDebug, log, logError } from "./logger.js"
import {
  getPipePath,
  getPidPath,
  encodeMessage,
  parseMessages,
  type IPCRequest,
  type IPCResponse,
  normalizeConfig,
} from "./ipc-protocol.js"
import { SchedulerService } from "./scheduler/scheduler-service.js"
import type { AgentIdentity, HostIdentity, ScheduleRequest } from "./scheduler/types.js"

interface BackgroundTaskHandle {
  stream: any
  stop: () => void
}
const backgroundTaskHandles = new Map<string, BackgroundTaskHandle>()

interface DaemonSession {
  sessionId: string
  configHash: string
}

interface CachedConfig {
  hash: string
  mtime: number
}

export class SSHDaemon {
  private gateway: SSHGateway
  private server: Server | null = null
  private pipePath: string
  private idleTimeoutMs: number
  private idleSweeper: ReturnType<typeof setInterval> | null = null
  private sessionMap = new Map<string, DaemonSession>() // configHash -> session
  private configCache = new Map<string, CachedConfig>() // path -> cached hash
  private startedAt = Date.now()
  private bgManager = new BackgroundExecManager()
  private forwardManagers = new Map<string, PortForwardManager>()
  private scheduler: SchedulerService

  constructor(opts?: { pipePath?: string; idleTimeoutMs?: number; scheduler?: SchedulerService }) {
    this.pipePath = opts?.pipePath ?? getPipePath()
    this.idleTimeoutMs = opts?.idleTimeoutMs ?? 10 * 60 * 1000 // 10 min default
    this.gateway = new SSHGateway({
      connectionTimeout: 15000,
      maxSessions: 50,
    })
    this.scheduler = opts?.scheduler ?? new SchedulerService({
      runner: {
        start: async (task) => {
          const conn = this.gateway.sessions.getConnection(task.sessionId)
          if (!conn) throw new Error(`Session ${task.sessionId} not found for scheduled task`)
          const client = conn.getFinalClient()
          const cmd = task.effectiveCwd
            ? `cd ${JSON.stringify(task.effectiveCwd)} && ${task.command}`
            : task.command
          const result = await remoteExec(client, cmd, { timeout: 120_000 })
          return { code: result.code, stdout: result.stdout, stderr: result.stderr, signal: result.signal }
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
            fullCommand = `cd ${JSON.stringify(task.effectiveCwd)} && ${fullCommand}`
          }
          const wrappedCommand = `echo "SSH_TOOL_PID:$$" >&2; exec ${fullCommand}`
          
          let currentPid: number | null = null
          let pidCaptured = false
          
          client.exec(wrappedCommand, (err, stream) => {
            if (err) {
              logError("daemon", `Failed to start background task ${task.id}`, err)
              onOutput("", err.message)
              onClose(1)
              return
            }
            
            const handle: BackgroundTaskHandle = {
              stream,
              stop: () => {
                if (currentPid) {
                  const killCmd = `kill -TERM ${currentPid} 2>/dev/null; sleep 0.1; kill -9 ${currentPid} 2>/dev/null; true`
                  client.exec(killCmd, () => {})
                }
                try { stream.close() } catch {}
              }
            }
            backgroundTaskHandles.set(task.id, handle)
            
            stream.on("data", (data: Buffer) => {
              const text = data.toString()
              if (!pidCaptured) {
                const pidMatch = text.match(/SSH_TOOL_PID:(\d+)/)
                if (pidMatch) {
                  currentPid = parseInt(pidMatch[1])
                  pidCaptured = true
                  const remaining = text.replace(/SSH_TOOL_PID:\d+\n?/, '')
                  if (remaining) {
                    onOutput(remaining, "")
                  }
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
                let pidMatch = text.match(/SSH_TOOL_PID:(\d+)/)
                if (pidMatch) {
                  currentPid = parseInt(pidMatch[1])
                  pidCaptured = true
                  const remaining = text.replace(/SSH_TOOL_PID:\d+\n?/, '')
                  if (remaining) {
                    onOutput("", remaining)
                  }
                } else {
                  onOutput("", text)
                }
              } else {
                onOutput("", text)
              }
            })
            
            stream.on("close", (code?: number, signal?: string) => {
              backgroundTaskHandles.delete(task.id)
              onClose(code ?? 1, signal)
            })
            
            stream.on("error", (streamErr: Error) => {
              backgroundTaskHandles.delete(task.id)
              onOutput("", streamErr.message)
              onClose(1)
            })
          })
          
          return {
            get pid() { return currentPid },
            stop: () => {
              const handle = backgroundTaskHandles.get(task.id)
              if (handle) handle.stop()
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

    // Clean up stale socket file on Unix
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

    // Start idle sweeper
    this.idleSweeper = setInterval(() => this.sweepIdle(), 30_000)

    // Graceful shutdown (cross-platform)
    process.on("SIGTERM", () => this.shutdown())
    process.on("SIGINT", () => this.shutdown())
    if (process.platform === "win32") {
      // Windows: handle Ctrl+C and process exit
      process.on("SIGHUP", () => this.shutdown())
    }

    console.log(`[daemon] listening on ${this.pipePath}`)
    console.log(`[daemon] idle timeout: ${this.idleTimeoutMs / 1000}s`)
  }

  async shutdown(): Promise<void> {
    console.log("[daemon] shutting down...")
    if (this.idleSweeper) clearInterval(this.idleSweeper)
    await this.gateway.disconnectAll()
    if (this.server) {
      this.server.close()
      this.server = null
    }
    this.removePid()
    process.exit(0)
  }

  private handleConnection(socket: Socket): void {
    let buffer: Buffer<ArrayBuffer> = Buffer.alloc(0)

    socket.on("data", (data) => {
      buffer = Buffer.concat([buffer, data])
      buffer = parseMessages(buffer, (msg) => {
        this.handleRequest(socket, msg as IPCRequest).catch((err) => {
          const resp: IPCResponse = {
            id: (msg as IPCRequest).id,
            ok: false,
            error: err.message,
          }
          socket.write(encodeMessage(resp))
        })
      })
    })

    socket.on("error", () => {
      // client disconnected
    })

    socket.on("close", () => {
      buffer = Buffer.alloc(0)
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
        resp = this.handleSchedule(req as any)
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

      default:
        resp = { id: (req as any).id ?? "", ok: false, error: `Unknown action: ${(req as any).action}` }
    }

    socket.write(encodeMessage(resp))
  }

  private async handleConnect(req: IPCRequest & { action: "connect" }): Promise<IPCResponse> {
    const { configPath } = req.params

    // Read config with mtime-based cache
    const stat = (await import("fs/promises")).stat
    const statResult = await stat(configPath)
    const cached = this.configCache.get(configPath)
    let configHash: string
    let configContent: string

    if (cached && cached.mtime === statResult.mtimeMs) {
      configHash = cached.hash
      configContent = readFileSync(configPath, "utf-8")
    } else {
      configContent = readFileSync(configPath, "utf-8")
      const normalized = normalizeConfig(configContent)
      configHash = createHash("md5").update(normalized).digest("hex")
      this.configCache.set(configPath, { hash: configHash, mtime: statResult.mtimeMs })
    }

    const existing = this.sessionMap.get(configHash)
    if (existing) {
      const session = this.gateway.sessions.getSession(existing.sessionId)
      const connection = this.gateway.sessions.getConnection(existing.sessionId)
      if (session?.status === "connected" && connection?.isConnected()) {
        return { id: req.id, ok: true, data: { sessionId: existing.sessionId, reused: true } }
      }
      this.sessionMap.delete(configHash)
      if (session) {
        this.gateway.disconnect(existing.sessionId).catch(() => {})
      }
    }

    // Parse config and connect
    const config = JSON.parse(configContent)
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
      return { id: req.id, ok: true, data: { sessionId: session.id, reused: false } }
    } catch (err: any) {
      // Clean up any error sessions created during the failed connection
      for (const [sid, entry] of this.sessionMap) {
        const s = this.gateway.sessions.getSession(entry.sessionId)
        if (s && s.status === "error") {
          this.gateway.disconnect(entry.sessionId).catch(() => {})
          this.sessionMap.delete(sid)
        }
      }
      // Also clean up error sessions not in sessionMap (freshly created ones)
      for (const s of this.gateway.sessions.getSessionsByStatus("error")) {
        this.gateway.disconnect(s.id).catch(() => {})
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
        return { id: req.id, ok: true, data: { sessionId: existing.sessionId, reused: true } }
      }
      this.sessionMap.delete(configHash)
      if (session) {
        this.gateway.disconnect(existing.sessionId).catch(() => {})
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
      return { id: req.id, ok: true, data: { sessionId: session.id, reused: false } }
    } catch (err: any) {
      for (const [sid, entry] of this.sessionMap) {
        const s = this.gateway.sessions.getSession(entry.sessionId)
        if (s && s.status === "error") {
          this.gateway.disconnect(entry.sessionId).catch(() => {})
          this.sessionMap.delete(sid)
        }
      }
      for (const s of this.gateway.sessions.getSessionsByStatus("error")) {
        this.gateway.disconnect(s.id).catch(() => {})
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
        // Remove from sessionMap
        for (const [hash, entry] of this.sessionMap) {
          if (entry.sessionId === sessionId) {
            this.sessionMap.delete(hash)
            break
          }
        }
      } catch {
        // ignore cleanup errors
      }
      return { id: req.id, ok: false, error: err.message }
    }
  }

  private handleSchedule(req: { id: string; params: ScheduleRequest }): IPCResponse {
    try {
      const decision = this.scheduler.schedule(req.params)
      return { id: req.id, ok: true, data: decision }
    } catch (err: any) {
      return { id: req.id, ok: false, error: err.message }
    }
  }

  private handleQueueStatus(req: { id: string; params: { agent?: AgentIdentity; hostId?: string; limit?: number } }): IPCResponse {
    try {
      const status = this.scheduler.queueStatus(req.params.hostId, req.params.limit)
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
      const result = this.scheduler.cancelTask(req.params.taskId)
      return { id: req.id, ok: true, data: result }
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
    const connection = this.gateway.sessions.getConnection(sessionId)
    if (!connection) {
      return { id: req.id, ok: false, error: `Session ${sessionId} not found` }
    }
    const client = connection.getFinalClient()
    try {
      switch (subcommand) {
        case "start": {
          if (!command) return { id: req.id, ok: false, error: "command is required" }
          const task = await this.bgManager.start(client, command)
          return { id: req.id, ok: true, data: task }
        }
        case "status": {
          if (!taskId) return { id: req.id, ok: false, error: "taskId is required" }
          const task = this.bgManager.getStatus(taskId)
          if (!task) return { id: req.id, ok: false, error: `Task ${taskId} not found` }
          return { id: req.id, ok: true, data: task }
        }
        case "output": {
          if (!taskId) return { id: req.id, ok: false, error: "taskId is required" }
          const output = this.bgManager.getOutput(taskId)
          if (!output) return { id: req.id, ok: false, error: `Task ${taskId} not found` }
          return { id: req.id, ok: true, data: output }
        }
        case "cancel": {
          if (!taskId) return { id: req.id, ok: false, error: "taskId is required" }
          const cancelled = this.bgManager.cancel(taskId, { client })
          return { id: req.id, ok: true, data: { cancelled } }
        }
        case "list": {
          const tasks = this.bgManager.list()
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
        for (const [hash, entry] of this.sessionMap) {
          if (entry.sessionId === session.id) {
            this.sessionMap.delete(hash)
            break
          }
        }
      }
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
      if (existsSync(pidPath)) unlinkSync(pidPath)
    } catch {
      // ignore
    }
  }
}

// --- Main ---

import { checkDeps } from "./check-deps.js"

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

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--idle-timeout" && i + 1 < args.length) {
      idleTimeout = parseInt(args[++i]) * 1000
    } else if (args[i] === "--pipe" && i + 1 < args.length) {
      pipePath = args[++i]
    }
  }

  const daemon = new SSHDaemon({ pipePath, idleTimeoutMs: idleTimeout })
  await daemon.start()
}

main().catch((err) => {
  console.error(`[daemon] fatal: ${err.message}`)
  process.exit(1)
})
