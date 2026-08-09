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
  constructor(private readonly client: Client, private readonly helperCommand = "ssh-tool-coordinator-helper") {}

  request(request: CoordinatorRequest): Promise<CoordinatorResponse> {
    return new Promise((resolve, reject) => {
      const command = `${this.helperCommand}`
      this.client.exec(command, (error, stream) => {
        if (error) { reject(error); return }
        let stdout = ""
        let stderr = ""
        let settled = false
        const finish = (failure?: Error): void => {
          if (settled) return
          settled = true
          if (failure) reject(failure)
          else {
            try { resolve(JSON.parse(stdout.trim()) as CoordinatorResponse) }
            catch { reject(new Error(`COORDINATION_PROTOCOL_ERROR: ${stderr || "invalid helper response"}`)) }
          }
        }
        stream.on("data", (chunk: Buffer | string) => { stdout += chunk.toString() })
        stream.stderr?.on("data", (chunk: Buffer | string) => { stderr += chunk.toString() })
        stream.on("error", (streamError: Error) => finish(streamError))
        stream.on("close", (code?: number) => code && code !== 0 ? finish(new Error(`COORDINATION_UNAVAILABLE: helper exited ${code}`)) : finish())
        stream.write(`${JSON.stringify(request)}\\n`)
      })
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
