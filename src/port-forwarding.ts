/**
 * Port Forwarding - SSH local and remote port forwarding
 *
 * Local forward (ssh -L):
 *   Maps a remote service to a local port.
 *   Use case: AI agent needs to access remote DB/API that's only on internal network.
 *
 * Remote forward (ssh -R):
 *   Exposes a local service to the remote server.
 *   Use case: AI agent wants to expose local dev server to remote machine.
 */

import { createConnection, createServer, type Server, type Socket } from "net"
import type { Client } from "ssh2"
import { randomUUID } from "crypto"
import { log } from "./logger.js"

export interface PortForward {
  id: string
  type: "local" | "remote"
  bindAddr: string
  bindPort: number
  dstAddr: string
  dstPort: number
  status: "active" | "stopped" | "error"
  createdAt: number
  connections: number
}

interface ActiveLocalForward {
  server: Server
  forward: PortForward
}

interface ActiveRemoteForward {
  forward: PortForward
  routeKey: string            // key into remoteRoutes for cleanup on stop
}

interface RemoteRoute {
  forwardId: string
  localDstAddr: string
  localDstPort: number
  forward: PortForward
}

/** A live tunneled connection that can be force-destroyed on client loss. */
interface ActiveConnection {
  destroy: () => void
}

export class PortForwardManager {
  private forwards = new Map<string, ActiveLocalForward | ActiveRemoteForward>()
  private client: Client
  // Single dispatcher for "tcp connection" events — keyed by `${dstIP}:${dstPort}`.
  // Replaces the previous per-forward listener model which leaked listeners on
  // stop and caused multiple forwards to interfere with each other.
  private remoteRoutes = new Map<string, RemoteRoute>()
  private tcpConnectionBound = false
  // Set to true when the underlying SSH client has disconnected. Once set,
  // new forward creation is rejected and existing forwards are marked "error".
  private clientClosed = false
  // Ids currently being torn down by stop(). Makes stop() idempotent under
  // concurrent/repeated calls: a second stop for an in-flight id is a no-op.
  private stoppingIds = new Set<string>()
  // Every active tunneled socket (local + remote). Drained when the SSH
  // client drops so no connection is left half-open.
  private activeConnections = new Set<ActiveConnection>()

  private drainAllConnections(): void {
    for (const conn of this.activeConnections) {
      try { conn.destroy() } catch { /* best-effort */ }
    }
    this.activeConnections.clear()
  }

  constructor(client: Client) {
    this.client = client
    // Subscribe to client disconnect events for self-healing. Guard with a
    // typeof check so mock clients without an `.on` method (e.g. in tests)
    // don't blow up during construction.
    if (typeof (this.client as any).on === "function") {
      this.client.on("close", () => this.handleClientDisconnect())
      this.client.on("error", () => this.handleClientDisconnect())
    }
  }

  /**
   * Called when the underlying SSH client disconnects (close/error events).
   * Idempotent: subsequent events are no-ops. Marks all forwards as "error"
   * so list() reflects real status, and best-effort stops local servers to
   * release the bound ports.
   */
  private handleClientDisconnect(): void {
    if (this.clientClosed) return
    this.clientClosed = true
    log("portforward", `SSH client disconnected, stopping all forwards and marking as error`)
    // Tear down any in-flight tunneled sockets first so pipes don't sit
    // half-open once the client's channels are gone.
    this.drainAllConnections()
    // Mark all forwards as error so list()/get() reflect real status instead of
    // pretending they are still "active".
    for (const entry of this.forwards.values()) {
      entry.forward.status = "error"
    }
    // stopAll() closes local net.Server instances (releasing ports). For
    // remote forwards it calls client.unforwardIn() which will throw on a
    // dead client - stop() already guards that call with try/catch.
    this.stopAll().catch(() => { /* best-effort cleanup */ })
  }

  /** Ensure the single "tcp connection" dispatcher is installed on the client. */
  private bindTcpConnection(): void {
    if (this.tcpConnectionBound) return
    this.tcpConnectionBound = true

    this.client.on("tcp connection", (details, accept, rejectConn) => {
      // ssh2 emits the forwarded-tcpip channel data as `destIP`/`destPort`
      // (the bind address the remote peer connected to on the SSH server).
      // These must match the route key registered by remoteForward(), which
      // uses the same `bindAddr:bindPort`.
      const key = `${details.destIP}:${details.destPort}`
      const route = this.remoteRoutes.get(key)
      if (!route) {
        rejectConn()
        return
      }

      route.forward.connections++
      log("fwd", `[${route.forwardId}] Incoming remote connection (total: ${route.forward.connections})`)

      const stream = accept()
      const localSocket = createConnection(route.localDstPort, route.localDstAddr)
      const conn: ActiveConnection = {
        destroy: () => { try { localSocket.destroy() } catch {}; try { stream.close() } catch {} },
      }
      this.activeConnections.add(conn)

      localSocket.on("connect", () => {
        stream.pipe(localSocket)
        localSocket.pipe(stream)
      })

      localSocket.on("error", (socketErr: Error) => {
        log("fwd", `[${route.forwardId}] Local connection error: ${socketErr.message}`)
        try { stream.close() } catch {}
      })

      stream.on("error", (streamErr: Error) => {
        log("fwd", `[${route.forwardId}] Stream error: ${streamErr.message}`)
        localSocket.destroy()
      })

      stream.on("close", () => {
        this.activeConnections.delete(conn)
        route.forward.connections--
        localSocket.destroy()
      })
    })
  }

  /** Remove the dispatcher when no remote forwards remain. */
  private unbindTcpConnection(): void {
    if (this.tcpConnectionBound && this.remoteRoutes.size === 0) {
      this.client.removeAllListeners("tcp connection")
      this.tcpConnectionBound = false
    }
  }

  /**
   * Start local port forwarding (ssh -L).
   * Listens on localBindAddr:localBindPort and tunnels to remoteDstAddr:remoteDstPort via SSH.
   */
  async localForward(
    localBindAddr: string,
    localBindPort: number,
    remoteDstAddr: string,
    remoteDstPort: number,
  ): Promise<PortForward> {
    if (this.clientClosed) {
      throw new Error("SSH client is disconnected, cannot create forward. Please reconnect first.")
    }
    const id = randomUUID().slice(0, 12)
    const forward: PortForward = {
      id,
      type: "local",
      bindAddr: localBindAddr,
      bindPort: localBindPort,
      dstAddr: remoteDstAddr,
      dstPort: remoteDstPort,
      status: "active",
      createdAt: Date.now(),
      connections: 0,
    }

    const server = createServer((socket: Socket) => {
      forward.connections++
      log("fwd", `[${id}] New connection (total: ${forward.connections})`)
      const conn: ActiveConnection = { destroy: () => { try { socket.destroy() } catch {} } }
      this.activeConnections.add(conn)

      this.client.forwardOut(
        localBindAddr,
        0,
        remoteDstAddr,
        remoteDstPort,
        (err, stream) => {
          if (err) {
            log("fwd", `[${id}] forwardOut error: ${err.message}`)
            this.activeConnections.delete(conn)
            socket.destroy()
            forward.connections--
            return
          }

          socket.pipe(stream)
          stream.pipe(socket)

          // Count each connection exactly once: only the socket 'close' event
          // releases it, and all failure paths funnel into that event.
          const closeOnce = (): void => {
            this.activeConnections.delete(conn)
            forward.connections--
            try { stream.close() } catch {}
            log("fwd", `[${id}] Connection closed (remaining: ${forward.connections})`)
          }

          socket.on("error", (socketErr: Error) => {
            log("fwd", `[${id}] Socket error: ${socketErr.message}`)
            try { stream.close() } catch {}
          })

          stream.on("error", (streamErr: Error) => {
            log("fwd", `[${id}] Stream error: ${streamErr.message}`)
            socket.destroy()
          })

          socket.on("close", closeOnce)
          stream.on("close", () => { socket.destroy() })
        },
      )
    })

    await new Promise<void>((resolve, reject) => {
      server.listen(localBindPort, localBindAddr, () => {
        const addr = server.address()
        if (typeof addr === "object" && addr) {
          forward.bindPort = addr.port
        }
        log("fwd", `[${id}] Local forward started: ${localBindAddr}:${forward.bindPort} -> ${remoteDstAddr}:${remoteDstPort}`)
        resolve()
      })
      server.on("error", (err) => {
        forward.status = "error"
        reject(new Error(`Failed to start local forward: ${err.message}`))
      })
    })

    this.forwards.set(id, { server, forward })
    return forward
  }

  /**
   * Start remote port forwarding (ssh -R).
   * Remote server listens on remoteBindAddr:remoteBindPort and tunnels back to localDstAddr:localDstPort.
   */
  async remoteForward(
    remoteBindAddr: string,
    remoteBindPort: number,
    localDstAddr: string,
    localDstPort: number,
  ): Promise<PortForward> {
    if (this.clientClosed) {
      throw new Error("SSH client is disconnected, cannot create forward. Please reconnect first.")
    }
    const id = randomUUID().slice(0, 12)
    const forward: PortForward = {
      id,
      type: "remote",
      bindAddr: remoteBindAddr,
      bindPort: remoteBindPort,
      dstAddr: localDstAddr,
      dstPort: localDstPort,
      status: "active",
      createdAt: Date.now(),
      connections: 0,
    }

    return new Promise((resolve, reject) => {
      this.client.forwardIn(remoteBindAddr, remoteBindPort, (err) => {
        if (err) {
          forward.status = "error"
          reject(new Error(`Failed to start remote forward: ${err.message}`))
          return
        }

        log("fwd", `[${id}] Remote forward registered: ${remoteBindAddr}:${remoteBindPort} -> ${localDstAddr}:${localDstPort}`)

        const routeKey = `${remoteBindAddr}:${remoteBindPort}`
        this.remoteRoutes.set(routeKey, { forwardId: id, localDstAddr, localDstPort, forward })
        this.bindTcpConnection()

        this.forwards.set(id, { forward, routeKey })
        resolve(forward)
      })
    })
  }

  /**
   * Stop a port forward. Idempotent: concurrent or repeated calls for the
   * same id collapse into one close, and stopping an already-removed id
   * returns false.
   */
  async stop(id: string): Promise<boolean> {
    const entry = this.forwards.get(id)
    if (!entry) return false
    if (this.stoppingIds.has(id)) return true
    this.stoppingIds.add(id)

    try {
      if (entry.forward.type === "local") {
        const { server } = entry as ActiveLocalForward
        await new Promise<void>((resolve) => {
          try {
            server.close(() => resolve())
          } catch {
            // server was never listening (e.g. start failed); release any
            // lingering connections and treat the close as done.
            try { (server as any).closeAllConnections?.() } catch { /* best-effort */ }
            resolve()
          }
        })
      } else {
        const remoteEntry = entry as ActiveRemoteForward
        // unforwardIn will throw if the underlying SSH client is already dead
        // (e.g. after handleClientDisconnect fired). Guard it so stopAll() can
        // complete cleanup without bubbling the error up.
        try {
          this.client.unforwardIn(entry.forward.bindAddr, entry.forward.bindPort, () => {})
        } catch (e) {
          log("portforward", `[${id}] unforwardIn failed (client likely disconnected): ${(e as Error).message}`)
        }
        if (remoteEntry.routeKey) {
          this.remoteRoutes.delete(remoteEntry.routeKey)
          this.unbindTcpConnection()
        }
      }

      entry.forward.status = "stopped"
      this.forwards.delete(id)
      log("fwd", `[${id}] Forward stopped`)
      return true
    } finally {
      this.stoppingIds.delete(id)
    }
  }

  /**
   * List all active forwards.
   */
  list(): PortForward[] {
    return Array.from(this.forwards.values()).map((e) => ({ ...e.forward }))
  }

  /**
   * Get a specific forward by ID.
   */
  get(id: string): PortForward | null {
    const entry = this.forwards.get(id)
    return entry ? { ...entry.forward } : null
  }

  /**
   * Stop all forwards.
   */
  async stopAll(): Promise<void> {
    for (const id of this.forwards.keys()) {
      await this.stop(id)
    }
  }
}
