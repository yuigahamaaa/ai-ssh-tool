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
import { resolvePrivateKeyContent } from "./private-key.js"
import { hostIdOf } from "./remote-dialect/cache.js"
import { DEFAULT_STRICT_HOST_KEY_CHECKING, KnownHostsStore } from "./known-hosts.js"
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
  // Guards against emitting multiple "disconnected" events for a single
  // lifecycle: an abnormal drop fires ssh2 "error" AND "close", and the
  // interactive shell also emits "close" — all for the same disconnect.
  private disconnectedEmitted = false

  /** Connect through the chain of hosts */
  async connect(opts: ConnectionOptions & { sessionId?: string }): Promise<void> {
    const { chain, terminalSize = { cols: 80, rows: 24 }, timeout = 10000, openShell = true } = opts
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

      const finalClient = this.hops[this.hops.length - 1].client
      if (openShell) {
        log("conn", `[${this.sessionId.slice(0, 8)}] Opening shell...`)
        this.shell = await this.openShell(finalClient, terminalSize, timeout)
      }
      this.connected = true
      // Reset the guard so the NEXT lifecycle (reconnect on the same
      // SSHConnection instance) can emit its own disconnected event.
      this.disconnectedEmitted = false

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
      let hostKeyVerificationError: Error | undefined
      const timer = setTimeout(() => {
        client.destroy()
        reject(new Error(`Connection to ${host.host}:${host.port} timed out`))
      }, timeout)
      timer.unref?.()

      const onReady = () => {
        clearTimeout(timer)
        client.removeListener("error", onError)
        this.installPostConnectHandlers(client, host)
        resolve()
      }
      const onError = (err: Error) => {
        clearTimeout(timer)
        client.removeListener("ready", onReady)
        client.destroy()
        reject(hostKeyVerificationError ?? new Error(`Failed to connect to ${host.host}:${host.port}: ${err.message}`))
      }

      client.once("ready", onReady)
      client.once("error", onError)

      client.connect(this.toConnectConfig(host, timeout, (error) => {
        hostKeyVerificationError = error
      }))
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
      let hostKeyVerificationError: Error | undefined
      const timer = setTimeout(() => {
        client.destroy()
        reject(new Error(`Tunnel to ${host.host}:${host.port} via hop ${throughHopIndex} timed out`))
      }, timeout)
      timer.unref?.()

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
          const onReady = () => {
            clearTimeout(timer)
            client.removeListener("error", onError)
            this.installPostConnectHandlers(client, host)
            resolve()
          }
          const onError = (clientErr: Error) => {
            clearTimeout(timer)
            client.removeListener("ready", onReady)
            client.destroy()
            reject(hostKeyVerificationError ?? new Error(`Failed to connect to ${host.host}:${host.port} through tunnel: ${clientErr.message}`))
          }

          client.once("ready", onReady)
          client.once("error", onError)

          client.connect({
            ...this.toConnectConfig(host, undefined, (error) => {
              hostKeyVerificationError = error
            }),
            sock: stream,
          })
        },
      )
    })
  }

  /** Open an interactive shell session */
  private openShell(client: Client, size: TerminalSize, timeoutMs: number): Promise<ClientChannel> {
    return new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Error(`Opening interactive shell timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      client.shell(
        { term: "xterm-256color", cols: size.cols, rows: size.rows },
        (err, stream) => {
          if (settled) {
            try { stream?.close() } catch {}
            return
          }
          settled = true
          clearTimeout(timer)
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
            this.shell = null
            this.emitEvent({ type: "shell-closed", sessionId: this.sessionId })
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
      throw new Error(this.connected ? "Interactive shell is not open" : "Not connected")
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
    this.emitDisconnectedOnce()
    await this.cleanup()
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

  /** 目标主机的方言缓存键（user@host:port）。未连接返回空串。 */
  getHostId(): string {
    if (this.hops.length === 0) return ""
    const h = this.hops[this.hops.length - 1].host
    return hostIdOf(h.host, h.port, h.auth.username)
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
        const timer = setTimeout(resolve, 2000)
        timer.unref?.()
      })
      this.shell = null
    }
    // Close hops in reverse order (deepest first)
    for (let i = this.hops.length - 1; i >= 0; i--) {
      this.hops[i].client.destroy()
    }
    this.hops = []
  }

  /** Convert SSHHostConfig to ssh2 ConnectConfig. `readyTimeoutMs` lets callers
   *  (e.g. tests) override the default 10-second handshake timeout. */
  private toConnectConfig(
    host: SSHHostConfig,
    readyTimeoutMs?: number,
    onHostKeyError?: (error: Error) => void,
  ): ConnectConfig {
    const config: ConnectConfig = {
      host: host.host,
      port: host.port,
      username: host.auth.username,
      readyTimeout: readyTimeoutMs ?? 10000,
      keepaliveInterval: 30000,
      keepaliveCountMax: 3,
    }

    const strictHostKeyChecking = host.strictHostKeyChecking ?? DEFAULT_STRICT_HOST_KEY_CHECKING
    if (strictHostKeyChecking !== "no") {
      const knownHosts = new KnownHostsStore(host.knownHostsPath)
      config.hostVerifier = (key: Buffer) => {
        const result = knownHosts.verify(host.host, host.port, key, strictHostKeyChecking)
        if (!result.accepted) {
          const error = result.error ?? new Error(`Host key verification failed for ${host.host}:${host.port}`)
          onHostKeyError?.(error)
          return false
        }
        return true
      }
    }

    if (host.auth.password) {
      config.password = host.auth.password
    }
    if (host.auth.privateKey) {
      // 兼容历史 profile 把私钥"路径"存进 privateKey 字段的情况：
      // 路径→读文件取内容，内容→归一化换行，公钥/坏头→明确报错。
      config.privateKey = resolvePrivateKeyContent(host.auth.privateKey)
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

  /** Emit at most one "disconnected" event per connection lifecycle. */
  private emitDisconnectedOnce(): void {
    if (this.disconnectedEmitted) return
    this.disconnectedEmitted = true
    this.connected = false
    this.emitEvent({ type: "disconnected", sessionId: this.sessionId })
  }

  /** Install long-lived error/close handlers after a hop is connected. */
  private installPostConnectHandlers(client: Client, host: SSHHostConfig): void {
    client.on("error", (err) => {
      log("conn", `[${this.sessionId.slice(0, 8)}] Hop ${host.host} error after connect: ${err.message}`)
      this.emitDisconnectedOnce()
    })
    client.on("close", () => {
      log("conn", `[${this.sessionId.slice(0, 8)}] Hop ${host.host} connection closed`)
      this.emitDisconnectedOnce()
    })
  }
}
