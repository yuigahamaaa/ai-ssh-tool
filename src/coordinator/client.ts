import { connect, type Socket } from "net"
import type { Client } from "ssh2"
import type { CoordinatorRequest, CoordinatorResponse } from "./protocol.js"

export interface CoordinatorTransport {
  request(request: CoordinatorRequest): Promise<CoordinatorResponse>
}

export class UnixSocketCoordinatorTransport implements CoordinatorTransport {
  constructor(private readonly socketPath: string, private readonly timeoutMs = 3000) {}

  request(request: CoordinatorRequest): Promise<CoordinatorResponse> {
    return new Promise((resolve, reject) => {
      const socket = connect(this.socketPath)
      let buffer = ""
      let settled = false
      const finish = (error?: Error, response?: CoordinatorResponse): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.destroy()
        if (error) reject(error)
        else resolve(response!)
      }
      const timer = setTimeout(() => finish(new Error("COORDINATION_UNAVAILABLE: coordinator request timed out")), this.timeoutMs)
      socket.setEncoding("utf8")
      socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`))
      socket.on("data", (chunk: string) => {
        buffer += chunk
        const newline = buffer.indexOf("\n")
        if (newline < 0) return
        try { finish(undefined, JSON.parse(buffer.slice(0, newline)) as CoordinatorResponse) }
        catch { finish(new Error("COORDINATION_PROTOCOL_ERROR: malformed coordinator response")) }
      })
      socket.on("error", (error) => finish(new Error(`COORDINATION_UNAVAILABLE: ${error.message}`)))
      socket.on("close", () => { if (!settled) finish(new Error("COORDINATION_UNAVAILABLE: coordinator socket closed")) })
    })
  }
}

export class SshExecCoordinatorTransport implements CoordinatorTransport {
  constructor(
    private readonly client: Client,
    private readonly helperCommand = "ssh-tool-coordinator-helper",
    private readonly timeoutMs = 3000,
  ) {}

  request(request: CoordinatorRequest): Promise<CoordinatorResponse> {
    return new Promise((resolve, reject) => {
      const command = `${this.helperCommand}`
      let stdout = ""
      let stderr = ""
      let settled = false
      let streamRef: any = null
      const maxResponseBytes = 256 * 1024
      const finish = (failure?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (failure) {
          try { streamRef?.close?.() } catch {}
          reject(failure)
          return
        }
        try { resolve(JSON.parse(stdout.trim()) as CoordinatorResponse) }
        catch { reject(new Error(`COORDINATION_PROTOCOL_ERROR: ${stderr || "invalid helper response"}`)) }
      }
      const timer = setTimeout(() => finish(new Error("COORDINATION_UNAVAILABLE: helper request timed out")), this.timeoutMs)

      try {
        this.client.exec(command, (error, stream) => {
          if (error) { finish(new Error(`COORDINATION_UNAVAILABLE: ${error.message}`)); return }
          streamRef = stream
          if (settled) {
            try { stream.close?.() } catch {}
            return
          }
          stream.on("data", (chunk: Buffer | string) => {
            if (settled) return
            stdout += chunk.toString()
            if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > maxResponseBytes) {
              finish(new Error("COORDINATION_PROTOCOL_ERROR: helper response exceeds limit"))
            }
          })
          stream.stderr?.on("data", (chunk: Buffer | string) => {
            if (settled) return
            stderr += chunk.toString()
            if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > maxResponseBytes) {
              finish(new Error("COORDINATION_PROTOCOL_ERROR: helper response exceeds limit"))
            }
          })
          stream.on("error", (streamError: Error) => finish(new Error(`COORDINATION_UNAVAILABLE: ${streamError.message}`)))
          stream.on("close", (code?: number) => code && code !== 0
            ? finish(new Error(`COORDINATION_UNAVAILABLE: helper exited ${code}`))
            : finish())
          // The helper reads one newline-delimited request from stdin. Use a
          // real newline and close stdin so it can dispatch immediately.
          stream.write(`${JSON.stringify(request)}\n`)
          ;(stream as any).end?.()
        })
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }
}

export class RemoteCoordinatorClient {
  constructor(private readonly transport: CoordinatorTransport, private readonly protocolVersion = 1) {}

  private async call(request: CoordinatorRequest): Promise<CoordinatorResponse> {
    try { return await this.transport.request(request) }
    catch (error) { return { ok: false, errorCode: "COORDINATION_UNAVAILABLE", message: (error as Error).message } }
  }

  health(): Promise<CoordinatorResponse> { return this.call({ action: "health", protocolVersion: this.protocolVersion }) }
  registerClient(client: Extract<CoordinatorRequest, { action: "registerClient" }>['client']): Promise<CoordinatorResponse> { return this.call({ action: "registerClient", protocolVersion: this.protocolVersion, client }) }
  beginTask(task: Extract<CoordinatorRequest, { action: "beginTask" }>['task'], force = false): Promise<CoordinatorResponse> { return this.call({ action: "beginTask", protocolVersion: this.protocolVersion, task, force }) }
  announceTask(task: Extract<CoordinatorRequest, { action: "announceTask" }>['task'], source: "manual" | "ci"): Promise<CoordinatorResponse> { return this.call({ action: "announceTask", protocolVersion: this.protocolVersion, task, source }) }
  heartbeat(taskId: string, leaseToken: string): Promise<CoordinatorResponse> { return this.call({ action: "heartbeat", protocolVersion: this.protocolVersion, taskId, leaseToken }) }
  finishTask(taskId: string, leaseToken: string, outcome: "success" | "failed" | "cancelled"): Promise<CoordinatorResponse> { return this.call({ action: "finishTask", protocolVersion: this.protocolVersion, taskId, leaseToken, outcome }) }
  listActive(workspace?: string): Promise<CoordinatorResponse> { return this.call({ action: "listActive", protocolVersion: this.protocolVersion, ...(workspace === undefined ? {} : { workspace }) }) }
}

export function socketRequest(socket: Socket, request: CoordinatorRequest): void {
  socket.write(`${JSON.stringify(request)}\n`)
}
