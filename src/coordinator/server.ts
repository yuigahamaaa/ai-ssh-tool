import { createServer, type Server, type Socket } from "net"
import { existsSync, lstatSync, unlinkSync } from "fs"
import { CoordinatorStore, type StoreIdentity } from "./store.js"
import { parseCoordinatorRequest, type CoordinatorRequest, type CoordinatorResponse } from "./protocol.js"

const MAX_LINE_BYTES = 64 * 1024

export interface CoordinatorServerOptions {
  socketPath: string
  observerSocketPath?: string
  store: CoordinatorStore
  version?: string
}

export class CoordinatorServer {
  private readonly server: Server
  private readonly observerServer: Server | null
  private readonly clients = new Set<Socket>()
  private readonly observerClients = new Set<Socket>()
  private started = false
  private stopping = false

  constructor(private readonly options: CoordinatorServerOptions) {
    this.server = createServer((socket) => this.handleSocket(socket, false))
    this.observerServer = options.observerSocketPath
      ? createServer((socket) => this.handleSocket(socket, true))
      : null
  }

  get socketPath(): string { return this.options.socketPath }

  async start(): Promise<void> {
    if (this.started) return
    this.prepareSocket(this.options.socketPath)
    if (this.options.observerSocketPath) this.prepareSocket(this.options.observerSocketPath)
    await this.listen(this.server, this.options.socketPath)
    if (this.observerServer && this.options.observerSocketPath) await this.listen(this.observerServer, this.options.observerSocketPath)
    this.started = true
  }

  async stop(): Promise<void> {
    if (!this.started || this.stopping) return
    this.stopping = true
    for (const socket of [...this.clients, ...this.observerClients]) socket.destroy()
    await Promise.all([
      this.closeServer(this.server),
      this.observerServer ? this.closeServer(this.observerServer) : Promise.resolve(),
    ])
    for (const path of [this.options.socketPath, this.options.observerSocketPath]) {
      if (path) this.removeSocket(path)
    }
    this.options.store.close()
    this.started = false
    this.stopping = false
  }

  private prepareSocket(path: string): void {
    if (!existsSync(path)) return
    const stat = lstatSync(path)
    if (!stat.isSocket()) throw new Error(`COORDINATOR_SOCKET_EXISTS: refusing non-socket path ${path}`)
    this.removeSocket(path)
  }

  private removeSocket(path: string): void {
    try { unlinkSync(path) } catch (error: any) { if (error?.code !== "ENOENT") throw error }
  }

  private listen(server: Server, path: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error): void => { server.off("listening", onListening); reject(error) }
      const onListening = (): void => { server.off("error", onError); resolve() }
      server.once("error", onError)
      server.once("listening", onListening)
      server.listen(path)
    })
  }

  private closeServer(server: Server): Promise<void> {
    return new Promise((resolve) => {
      if (!server.listening) { resolve(); return }
      server.close(() => resolve())
    })
  }

  private handleSocket(socket: Socket, observer: boolean): void {
    const bucket = observer ? this.observerClients : this.clients
    bucket.add(socket)
    let buffer = ""
    const identity: StoreIdentity = { identityTrust: "self-asserted" }
    socket.setEncoding("utf8")
    socket.on("data", (chunk: string) => {
      buffer += chunk
      if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
        this.write(socket, { ok: false, errorCode: "REQUEST_TOO_LARGE", message: "request exceeds limit" })
        socket.destroy()
        return
      }
      let newline = buffer.indexOf("\n")
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) this.dispatch(socket, line, observer, identity)
        newline = buffer.indexOf("\n")
      }
    })
    socket.once("close", () => bucket.delete(socket))
    socket.once("error", () => bucket.delete(socket))
  }

  private async dispatch(socket: Socket, line: string, observer: boolean, identity: StoreIdentity): Promise<void> {
    let request: CoordinatorRequest
    try {
      request = parseCoordinatorRequest(line)
      if (observer && request.action !== "submitObservation") throw new Error("INVALID_REQUEST: observer socket only accepts observations")
      if (!observer && request.action === "submitObservation") throw new Error("INVALID_REQUEST: observation requires private socket")
    } catch (error: any) {
      this.write(socket, { ok: false, errorCode: String(error?.message ?? "INVALID_REQUEST").split(":", 1)[0], message: String(error?.message ?? "invalid request") })
      return
    }
    try {
      const response = this.handleRequest(request, identity)
      this.write(socket, response)
    } catch (error: any) {
      const message = String(error?.message ?? "COORDINATOR_ERROR")
      this.write(socket, { ok: false, errorCode: message.split(":", 1)[0], message })
    }
  }

  private handleRequest(request: CoordinatorRequest, identity: StoreIdentity): CoordinatorResponse {
    switch (request.action) {
      case "health": return { ok: true, data: { version: this.options.version ?? "dev", protocolVersion: request.protocolVersion } }
      case "registerClient": this.options.store.registerClient(request.client); return { ok: true, data: { registered: true } }
      case "beginTask":
      case "announceTask": {
        const task = request.task
        const result = this.options.store.beginTask({ ...task, source: request.action === "announceTask" ? request.source : task.source }, identity)
        return { ok: true, data: result }
      }
      case "heartbeat": this.options.store.heartbeat(request.taskId, request.leaseToken); return { ok: true, data: { renewed: true } }
      case "finishTask": this.options.store.finishTask(request.taskId, request.leaseToken, request.outcome); return { ok: true, data: { finished: true } }
      case "listActive": return { ok: true, data: { conflicts: this.options.store.listActive(request.workspace), observed: this.options.store.listObserved(request.workspace) } }
      case "submitObservation": this.options.store.submitObservations(request.sessions, request.processes); return { ok: true, data: { accepted: true } }
    }
  }

  private write(socket: Socket, response: CoordinatorResponse): void {
    if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`)
  }
}
