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

import { createServer, type Server, type Socket } from "net"
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

export class PortForwardManager {
  private forwards = new Map<string, ActiveLocalForward | ActiveRemoteForward>()
  private client: Client
  // Single dispatcher for "tcp connection" events — keyed by `${dstIP}:${dstPort}`.
  // Replaces the previous per-forward listener model which leaked listeners on
  // stop and caused multiple forwards to interfere with each other.
  private remoteRoutes = new Map<string, RemoteRoute>()
  private tcpConnectionBound = false

  constructor(client: Client) {
    this.client = client
  }

  /** Ensure the single "tcp connection" dispatcher is installed on the client. */
  private bindTcpConnection(): void {
    if (this.tcpConnectionBound) return
    this.tcpConnectionBound = true

    this.client.on("tcp connection", (details, accept, rejectConn) => {
      const key = `${details.dstIP}:${details.dstPort}`
      const route = this.remoteRoutes.get(key)
      if (!route) {
        rejectConn()
        return
      }

      route.forward.connections++
      log("fwd", `[${route.forwardId}] Incoming remote connection (total: ${route.forward.connections})`)

      const stream = accept()
      const net = require("net") as typeof import("net")
      const localSocket = net.createConnection(route.localDstPort, route.localDstAddr)

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

      this.client.forwardOut(
        localBindAddr,
        0,
        remoteDstAddr,
        remoteDstPort,
        (err, stream) => {
          if (err) {
            log("fwd", `[${id}] forwardOut error: ${err.message}`)
            socket.destroy()
            forward.connections--
            return
          }

          socket.pipe(stream)
          stream.pipe(socket)

          socket.on("error", (socketErr: Error) => {
            log("fwd", `[${id}] Socket error: ${socketErr.message}`)
            try { stream.close() } catch {}
          })

          stream.on("error", (streamErr: Error) => {
            log("fwd", `[${id}] Stream error: ${streamErr.message}`)
            socket.destroy()
          })

          socket.on("close", () => {
            forward.connections--
            try { stream.close() } catch {}
            log("fwd", `[${id}] Connection closed (remaining: ${forward.connections})`)
          })

          stream.on("close", () => {
            socket.destroy()
          })
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
   * Stop a port forward.
   */
  async stop(id: string): Promise<boolean> {
    const entry = this.forwards.get(id)
    if (!entry) return false

    if (entry.forward.type === "local") {
      const { server } = entry as ActiveLocalForward
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    } else {
      const remoteEntry = entry as ActiveRemoteForward
      this.client.unforwardIn(entry.forward.bindAddr, entry.forward.bindPort, () => {})
      if (remoteEntry.routeKey) {
        this.remoteRoutes.delete(remoteEntry.routeKey)
        this.unbindTcpConnection()
      }
    }

    entry.forward.status = "stopped"
    this.forwards.delete(id)
    log("fwd", `[${id}] Forward stopped`)
    return true
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
