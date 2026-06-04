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
  createRequest,
  IPCSocket,
  type IPCRequest,
  type IPCResponse,
} from "./ipc-protocol.js"
import { log, logError } from "./logger.js"

export class DaemonClient {
  private pipePath: string
  private socket: Socket | null = null
  private ipc: IPCSocket | null = null

  constructor(pipePath?: string) {
    this.pipePath = pipePath ?? getPipePath()
  }

  /** Connect to the daemon */
  async connect(): Promise<void> {
    if (this.socket) return

    log("client", `Connecting to daemon at ${this.pipePath}`)
    this.socket = connect(this.pipePath)
    await new Promise<void>((resolve, reject) => {
      this.socket!.on("connect", () => {
        this.ipc = new IPCSocket(this.socket!)
        log("client", "Connected to daemon")
        resolve()
      })
      this.socket!.on("error", (err) => {
        logError("client", "Connection failed", err)
        this.socket = null
        reject(err)
      })
    })
  }

  /** Disconnect from the daemon */
  disconnect(): void {
    if (this.ipc) {
      this.ipc.dispose()
      this.ipc = null
    }
    if (this.socket) {
      this.socket.destroy()
      this.socket = null
    }
  }

  /** Send a request and wait for response */
  async send(req: IPCRequest, timeoutMs?: number): Promise<IPCResponse> {
    if (!this.ipc) await this.connect()
    log("client", `Sending IPC: ${req.action}`, { id: req.id.slice(0, 8) })
    const resp = await this.ipc!.send(req, timeoutMs)
    log("client", `IPC response: ${req.action} ok=${resp.ok}`, { id: req.id.slice(0, 8) })
    return resp
  }

  /** Check if daemon is running */
  async isRunning(): Promise<boolean> {
    try {
      await this.connect()
      const resp = await this.ping()
      return resp.ok
    } catch {
      return false
    }
  }

  /** Ensure daemon is running, start it if not */
  async ensureDaemon(opts?: { debug?: boolean; label?: string }): Promise<void> {
    // Try connecting first
    try {
      await this.connect()
      const resp = await this.ping()
      if (resp.ok) return
    } catch {
      // not running
    }

    // Start daemon
    await this.startDaemon({ debug: opts?.debug, label: opts?.label })

    // Wait for it to be ready (retry with backoff)
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

  /** Ping the daemon */
  async ping(): Promise<IPCResponse> {
    return this.send(createRequest("ping"))
  }

  /** Connect to a remote host via config file */
  async connectHost(configPath: string): Promise<IPCResponse> {
    const absPath = resolve(configPath)
    return this.send(createRequest("connect", { configPath: absPath }))
  }

  /** Connect to a remote host via JSON config string */
  async connectHostJson(configJson: string): Promise<IPCResponse> {
    return this.send(createRequest("connectJson", { configJson }))
  }

  /** Execute a command on a session */
  async exec(sessionId: string, command: string, timeout?: number): Promise<IPCResponse> {
    return this.send(createRequest("exec", { sessionId, command, timeout }), timeout ?? 60000)
  }

  /** List active sessions */
  async list(): Promise<IPCResponse> {
    return this.send(createRequest("list"))
  }

  /** Disconnect a session */
  async disconnectSession(sessionId: string): Promise<IPCResponse> {
    return this.send(createRequest("disconnect", { sessionId }))
  }

  /** Shutdown the daemon */
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

  /** Schedule a command through the daemon scheduler */
  async schedule(req: Record<string, unknown>): Promise<IPCResponse> {
    return this.send(createRequest("schedule", req), 120000)
  }

  /** Get queue status */
  async queueStatus(params: { agent?: { id: string; name?: string; clientType: string }; hostId?: string; limit?: number }): Promise<IPCResponse> {
    return this.send(createRequest("queueStatus", params))
  }

  /** Wait for a task to complete */
  async waitTask(taskId: string, timeoutMs?: number): Promise<IPCResponse> {
    return this.send(createRequest("waitTask", { taskId, timeoutMs }), timeoutMs ?? 120000)
  }

  /** Remove a task from the queue */
  async dequeueTask(taskId: string, agent?: { id: string; name?: string; clientType: string }): Promise<IPCResponse> {
    return this.send(createRequest("dequeueTask", { taskId, agent }))
  }

  /** Cancel a running or queued task */
  async cancelTask(taskId: string): Promise<IPCResponse> {
    return this.send(createRequest("cancelTask", { taskId }))
  }

  /** Get task output (stdout/stderr) */
  async getTaskOutput(taskId: string, mode?: "tail" | "full"): Promise<IPCResponse> {
    return this.send(createRequest("getTaskOutput", { taskId, mode }))
  }

  /** Set virtual cwd for an agent on a host */
  async setCwd(agent: { id: string; name?: string; clientType: string }, host: { id: string; profileKey: string; targetHost: string; targetUser: string; displayName: string }, cwd: string): Promise<IPCResponse> {
    return this.send(createRequest("setCwd", { agent, host, cwd }))
  }

  /** Spawn daemon as a detached background process */
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
