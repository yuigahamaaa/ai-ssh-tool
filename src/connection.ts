/**
 * SSH Connection - handles a single N-hop SSH connection chain
 *
 * Flow:
 *   1. Connect to chain[0] directly
 *   2. For each subsequent host, create a TCP tunnel through the previous connection
 *   3. On the final host, open an interactive shell session
 */

import { Client, type ClientChannel, type ConnectConfig } from "ssh2"
import { EventEmitter } from "events"
import { log, logError } from "./logger.js"
import type {
  ConnectionEvent,
  ConnectionOptions,
  SSHConnectionChain,
  SSHHostConfig,
  TerminalSize,
} from "./types.js"

interface HopClient {
  client: Client
  host: SSHHostConfig
}

export class SSHConnection extends EventEmitter {
  private hops: HopClient[] = []
  private shell: ClientChannel | null = null
  private connected = false
  private sessionId = ""

  /** Connect through the chain of hosts */
  async connect(opts: ConnectionOptions & { sessionId?: string }): Promise<void> {
    const { chain, terminalSize = { cols: 80, rows: 24 }, timeout = 10000 } = opts
    this.sessionId = opts.sessionId ?? ""

    if (chain.length === 0) {
      throw new Error("Connection chain cannot be empty")
    }

    log("conn", `[${this.sessionId.slice(0, 8)}] Connecting through ${chain.length} hop(s), timeout=${timeout}ms`)
    log("conn", `[${this.sessionId.slice(0, 8)}] Chain: ${chain.map(h => `${h.host}:${h.port}`).join(" -> ")}`)

    try {
      for (let i = 0; i < chain.length; i++) {
        const host = chain[i]
        log("conn", `[${this.sessionId.slice(0, 8)}] Hop ${i}/${chain.length - 1}: ${host.host}:${host.port} as ${host.auth.username} (${i === 0 ? "direct" : "tunnel"})`)

        this.emitEvent({
          type: "connecting",
          sessionId: this.sessionId,
          hopIndex: i,
          host: host.host,
        })

        const client = new Client()
        const hopStart = Date.now()

        if (i === 0) {
          await this.connectDirect(client, host, timeout)
        } else {
          await this.connectThrough(client, host, i - 1, timeout)
        }

        log("conn", `[${this.sessionId.slice(0, 8)}] Hop ${i} connected in ${Date.now() - hopStart}ms`)
        this.hops.push({ client, host })
      }

      log("conn", `[${this.sessionId.slice(0, 8)}] Opening shell...`)
      const finalClient = this.hops[this.hops.length - 1].client
      this.shell = await this.openShell(finalClient, terminalSize)
      this.connected = true

      log("conn", `[${this.sessionId.slice(0, 8)}] Connected successfully`)
      this.emitEvent({ type: "connected", sessionId: this.sessionId })
    } catch (err: any) {
      logError("conn", `[${this.sessionId.slice(0, 8)}] Connection failed`, err)
      this.emitEvent({
        type: "error",
        sessionId: this.sessionId,
        error: err.message,
      })
      await this.cleanup()
      throw err
    }
  }

  /** Direct TCP connection to a host */
  private connectDirect(client: Client, host: SSHHostConfig, timeout: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        client.destroy()
        reject(new Error(`Connection to ${host.host}:${host.port} timed out`))
      }, timeout)

      client.on("ready", () => {
        clearTimeout(timer)
        resolve()
      })

      client.on("error", (err) => {
        clearTimeout(timer)
        reject(new Error(`Failed to connect to ${host.host}:${host.port}: ${err.message}`))
      })

      client.connect(this.toConnectConfig(host))
    })
  }

  /** Connect to a host by tunneling through a previous hop */
  private connectThrough(
    client: Client,
    host: SSHHostConfig,
    throughHopIndex: number,
    timeout: number,
  ): Promise<void> {
    const throughClient = this.hops[throughHopIndex].client

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        client.destroy()
        reject(new Error(`Tunnel to ${host.host}:${host.port} via hop ${throughHopIndex} timed out`))
      }, timeout)

      // Create a TCP forward through the previous hop
      throughClient.forwardOut(
        "127.0.0.1",
        0, // let the OS assign a port
        host.host,
        host.port,
        (err, stream) => {
          if (err) {
            clearTimeout(timer)
            reject(new Error(`Failed to create tunnel to ${host.host}:${host.port}: ${err.message}`))
            return
          }

          // Connect the new client through the tunnel stream
          client.on("ready", () => {
            clearTimeout(timer)
            resolve()
          })

          client.on("error", (clientErr) => {
            clearTimeout(timer)
            reject(new Error(`Failed to connect to ${host.host}:${host.port} through tunnel: ${clientErr.message}`))
          })

          client.connect({
            ...this.toConnectConfig(host),
            sock: stream,
          })
        },
      )
    })
  }

  /** Open an interactive shell session */
  private openShell(client: Client, size: TerminalSize): Promise<ClientChannel> {
    return new Promise((resolve, reject) => {
      client.shell(
        { term: "xterm-256color", cols: size.cols, rows: size.rows },
        (err, stream) => {
          if (err) {
            reject(new Error(`Failed to open shell: ${err.message}`))
            return
          }

          stream.on("data", (data: Buffer) => {
            this.emitEvent({
              type: "data",
              sessionId: this.sessionId,
              data,
            })
          })

          stream.on("close", () => {
            this.connected = false
            this.emitEvent({
              type: "disconnected",
              sessionId: this.sessionId,
            })
          })

          stream.stderr.on("data", (data: Buffer) => {
            this.emitEvent({
              type: "data",
              sessionId: this.sessionId,
              data,
            })
          })

          resolve(stream)
        },
      )
    })
  }

  /** Send data to the remote shell */
  async sendData(data: string | Buffer): Promise<void> {
    if (!this.shell || !this.connected) {
      throw new Error("Not connected")
    }
    return new Promise((resolve, reject) => {
      this.shell!.write(data, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  /** Resize the terminal */
  async resize(cols: number, rows: number): Promise<void> {
    if (!this.shell || !this.connected) return
    return new Promise((resolve, reject) => {
      this.shell!.setWindow(rows, cols, 0, 0, (err) => {
        if (err) reject(err)
        else {
          this.emitEvent({
            type: "resize",
            sessionId: this.sessionId,
            cols,
            rows,
          })
          resolve()
        }
      })
    })
  }

  /** Disconnect and clean up all hops */
  async disconnect(): Promise<void> {
    this.connected = false
    await this.cleanup()
    this.emitEvent({ type: "disconnected", sessionId: this.sessionId })
  }

  /** Check if connected */
  isConnected(): boolean {
    return this.connected
  }

  /** Get the ssh2 Client for the final (target) host. Used by remote tools (SFTP, exec). */
  getFinalClient(): Client {
    if (this.hops.length === 0) throw new Error("Not connected")
    return this.hops[this.hops.length - 1].client
  }

  /** Get the host config for the final (target) host */
  getFinalHost(): SSHHostConfig {
    if (this.hops.length === 0) throw new Error("Not connected")
    return this.hops[this.hops.length - 1].host
  }

  /** Get the hop chain clients (for advanced use) */
  getHopClients(): Client[] {
    return this.hops.map((h) => h.client)
  }

  /** Clean up resources in reverse order */
  private async cleanup(): Promise<void> {
    if (this.shell) {
      await new Promise<void>((resolve) => {
        this.shell!.once("close", () => resolve())
        this.shell!.close()
        // Fallback: don't wait forever
        setTimeout(resolve, 2000)
      })
      this.shell = null
    }
    // Close hops in reverse order (deepest first)
    for (let i = this.hops.length - 1; i >= 0; i--) {
      this.hops[i].client.destroy()
    }
    this.hops = []
  }

  /** Convert SSHHostConfig to ssh2 ConnectConfig */
  private toConnectConfig(host: SSHHostConfig): ConnectConfig {
    const config: ConnectConfig = {
      host: host.host,
      port: host.port,
      username: host.auth.username,
      readyTimeout: 10000,
      keepaliveInterval: 30000,
      keepaliveCountMax: 3,
    }

    if (host.auth.password) {
      config.password = host.auth.password
    }
    if (host.auth.privateKey) {
      config.privateKey = host.auth.privateKey
    }
    if (host.auth.passphrase) {
      config.passphrase = host.auth.passphrase
    }
    if (host.auth.agent) {
      config.agent = host.auth.agent
    }
    if (host.auth.agentForward) {
      config.agentForward = host.auth.agentForward
    }

    return config
  }

  private emitEvent(event: ConnectionEvent): void {
    this.emit("event", event)
  }
}
