/**
 * Daemon Client - IPC client for communicating with the SSH daemon
 */

import { connect, type Socket } from "net"
import { spawn } from "child_process"
import { existsSync } from "fs"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"
import {
  getPipePath,
  getPipePathCandidates,
  createRequest,
  IPCSocket,
  type IPCRequest,
  type IPCResponse,
} from "./ipc-protocol.js"
import { log, logError } from "./logger.js"

export class DaemonClient {
  private pipePath: string
  private pipePathCandidates: string[]
  private socket: Socket | null = null
  private ipc: IPCSocket | null = null
  private connecting: Promise<void> | null = null
  private connectCancelled = false
  /**
   * If a connect() is in flight, disconnect() can settle that promise
   * explicitly with a "disconnected" error so the awaiter never hangs.
   * Reset to null whenever the in-flight connect settles.
   */
  private connectingReject: ((err: Error) => void) | null = null
  private ensuring: Promise<void> | null = null

  constructor(pipePath?: string | string[]) {
    this.pipePathCandidates = Array.isArray(pipePath)
      ? pipePath
      : pipePath
        ? [pipePath]
        : getPipePathCandidates()
    this.pipePath = this.pipePathCandidates[0] ?? getPipePath()
  }

  async connect(): Promise<void> {
    if (this.ipc && this.socket && !this.socket.destroyed) return
    if (this.connecting) return this.connecting

    this.connectCancelled = false
    this.connecting = this._connect()
    try {
      await this.connecting
    } finally {
      this.connecting = null
      this.connectingReject = null
    }
  }

  private async _connect(): Promise<void> {
    this.closeTransport()

    let lastError: Error | undefined
    for (const candidate of this.pipePathCandidates) {
      this.pipePath = candidate
      try {
        await this.connectToCurrentPath()
        return
      } catch (err) {
        lastError = err as Error
        this.closeTransport()
        if (this.connectCancelled) throw lastError
      }
    }
    throw lastError ?? new Error("No daemon pipe paths configured")
  }

  private async connectToCurrentPath(): Promise<void> {
    log("client", `Connecting to daemon at ${this.pipePath}`)
    this.socket = connect(this.pipePath)
    await new Promise<void>((resolve, reject) => {
      // Expose the reject handle so a concurrent disconnect() can settle
      // the in-flight connect promise instead of leaving the awaiter hanging.
      this.connectingReject = reject
      const onError = (err: Error) => {
        logError("client", "Connection failed", err)
        this.socket = null
        reject(err)
      }
      this.socket!.once("error", onError)
      this.socket!.once("connect", () => {
        this.socket!.removeListener("error", onError)
        this.ipc = new IPCSocket(this.socket!)
        this.socket!.on("error", (err) => {
          logError("client", "Socket error", err)
          this.disconnect()
        })
        this.socket!.on("close", () => {
          this.disconnect()
        })
        log("client", "Connected to daemon")
        resolve()
      })
    })
  }

  disconnect(): void {
    this.connectCancelled = true
    this.closeTransport()
  }

  private closeTransport(): void {
    // If a connect() is in flight, settle it before tearing the socket
    // down — otherwise the awaiter would hang forever (we're about to
    // remove all listeners and destroy the only transport the connect
    // promise is waiting on).
    if (this.connectingReject) {
      const reject = this.connectingReject
      this.connectingReject = null
      reject(new Error("disconnected"))
    }
    if (this.ipc) {
      this.ipc.dispose()
      this.ipc = null
    }
    if (this.socket) {
      this.socket.removeAllListeners()
      this.socket.destroy()
      this.socket = null
    }
  }

  private isConnected(): boolean {
    return this.ipc !== null && this.socket !== null && !this.socket.destroyed
  }

  async send(req: IPCRequest, timeoutMs?: number): Promise<IPCResponse> {
    if (!this.isConnected()) await this.connect()
    log("client", `Sending IPC: ${req.action}`, { id: req.id.slice(0, 8) })
    try {
      const resp = await this.ipc!.send(req, timeoutMs)
      log("client", `IPC response: ${req.action} ok=${resp.ok}`, { id: req.id.slice(0, 8) })
      return resp
    } catch (err: any) {
      if (err.message?.includes("socket closed") || err.message?.includes("EPIPE") || err.message?.includes("ECONNRESET")) {
        this.disconnect()
      }
      throw err
    }
  }

  async isRunning(): Promise<boolean> {
    try {
      await this.connect()
      const resp = await this.ping()
      return resp.ok
    } catch {
      return false
    }
  }

  async ensureDaemon(opts?: { debug?: boolean; label?: string }): Promise<void> {
    if (this.ensuring) return this.ensuring
    this.ensuring = this._ensureDaemon(opts)
    try {
      await this.ensuring
    } finally {
      this.ensuring = null
    }
  }

  private async _ensureDaemon(opts?: { debug?: boolean; label?: string }): Promise<void> {
    try {
      await this.connect()
      const resp = await this.ping()
      if (resp.ok) return
    } catch {
      // not running
    }

    await this.startDaemon({ debug: opts?.debug, label: opts?.label })

    for (let attempt = 0; attempt < 5; attempt++) {
      await sleep(500 * (attempt + 1))
      try {
        this.disconnect()
        await this.connect()
        const resp = await this.ping()
        if (resp.ok) return
      } catch {
        // retry
      }
    }
    throw new Error("Failed to start daemon after multiple attempts")
  }

  async ping(): Promise<IPCResponse> {
    return this.send(createRequest("ping"))
  }

  async connectHost(configPath: string): Promise<IPCResponse> {
    const absPath = resolve(configPath)
    return this.send(createRequest("connect", { configPath: absPath }))
  }

  async connectHostJson(configJson: string): Promise<IPCResponse> {
    return this.send(createRequest("connectJson", { configJson }))
  }

  async exec(sessionId: string, command: string, timeout?: number): Promise<IPCResponse> {
    return this.send(createRequest("exec", { sessionId, command, timeout }), timeout ?? 60000)
  }

  async list(): Promise<IPCResponse> {
    return this.send(createRequest("list"))
  }

  async disconnectSession(sessionId: string): Promise<IPCResponse> {
    return this.send(createRequest("disconnect", { sessionId }))
  }

  async shutdown(): Promise<IPCResponse> {
    try {
      const resp = await this.send(createRequest("shutdown"))
      this.disconnect()
      return resp
    } catch {
      this.disconnect()
      return { id: "", ok: true, data: { message: "daemon stopped" } }
    }
  }

  async schedule(req: Record<string, unknown>): Promise<IPCResponse> {
    return this.send(createRequest("schedule", req), 120000)
  }

  async queueStatus(params: { agent?: { id: string; name?: string; clientType: string }; hostId?: string; limit?: number }): Promise<IPCResponse> {
    return this.send(createRequest("queueStatus", params))
  }

  async waitTask(taskId: string, timeoutMs?: number): Promise<IPCResponse> {
    const ipcTimeoutMs = timeoutMs === undefined ? 120000 : timeoutMs + 5000
    return this.send(createRequest("waitTask", { taskId, timeoutMs }), ipcTimeoutMs)
  }

  async dequeueTask(taskId: string, agent?: { id: string; name?: string; clientType: string }): Promise<IPCResponse> {
    return this.send(createRequest("dequeueTask", { taskId, agent }))
  }

  async cancelTask(taskId: string): Promise<IPCResponse> {
    return this.send(createRequest("cancelTask", { taskId }))
  }

  async getTaskOutput(taskId: string, mode?: "tail" | "full"): Promise<IPCResponse> {
    return this.send(createRequest("getTaskOutput", { taskId, mode }))
  }

  async getTaskStatus(taskId: string): Promise<IPCResponse> {
    return this.send(createRequest("getTaskStatus", { taskId }))
  }

  async cleanupOutputs(): Promise<IPCResponse> {
    return this.send(createRequest("cleanupOutputs", {}))
  }

  async abortActiveTasks(reason: string): Promise<IPCResponse> {
    return this.send(createRequest("abortActiveTasks", { reason }))
  }

  async setCwd(agent: { id: string; name?: string; clientType: string }, host: { id: string; profileKey: string; targetHost: string; targetUser: string; displayName: string }, cwd: string): Promise<IPCResponse> {
    return this.send(createRequest("setCwd", { agent, host, cwd }))
  }

  async getCwd(agent: { id: string; name?: string; clientType: string }, host: { id: string; profileKey: string; targetHost: string; targetUser: string; displayName: string }): Promise<IPCResponse> {
    return this.send(createRequest("getCwd", { agent, host }))
  }

  private async startDaemon(opts?: { debug?: boolean; label?: string }): Promise<void> {
    const daemonScript = this.findDaemonScript()
    const args = [daemonScript]
    if (opts?.debug) args.push("--debug")
    if (opts?.label) args.push("--label", opts.label)

    log("client", `Spawning daemon: node ${args.join(" ")}`)
    const child = spawn("node", args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    })
    child.unref()
  }

  private findDaemonScript(): string {
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const candidates = [
      resolve(__dirname, "daemon.js"),
      resolve(__dirname, "..", "dist", "daemon.js"),
    ]

    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate
    }

    throw new Error(
      "Cannot find daemon.js. Run 'npm run build' first.\nSearched: " + candidates.join(", "),
    )
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
