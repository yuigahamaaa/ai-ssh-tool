/**
 * SSH Session Manager - manages multiple concurrent SSH sessions
 * Each session can independently connect to different targets through different hop chains
 */

import { createHash } from "crypto"
import { randomUUID } from "crypto"
import { EventEmitter } from "events"
import { SSHConnection } from "./connection.js"
import { log } from "./logger.js"
import type {
  ConnectionEvent,
  ConnectionEventListener,
  ConnectionOptions,
  SSHSession,
  SessionStatus,
  TerminalSize,
} from "./types.js"

export class SSHSessionManager extends EventEmitter {
  private sessions = new Map<string, {
    connection: SSHConnection
    session: SSHSession
    listeners: ConnectionEventListener[]
  }>()

  private sessionsByProfile = new Map<string, string>()

  private maxSessions: number
  private defaultTerminalSize: TerminalSize

  constructor(options?: { maxSessions?: number; defaultTerminalSize?: TerminalSize }) {
    super()
    this.maxSessions = options?.maxSessions ?? 50
    this.defaultTerminalSize = options?.defaultTerminalSize ?? { cols: 80, rows: 24 }
  }

  private generateConfigHash(chain: ConnectionOptions["chain"]): string {
    const normalized = chain.map((hop) => {
      return {
        host: hop.host,
        port: hop.port,
        username: hop.auth?.username,
      }
    }).sort((a, b) => a.host.localeCompare(b.host))
    return createHash("md5").update(JSON.stringify(normalized)).digest("hex").slice(0, 16)
  }

  private normalizeChain(chain: ConnectionOptions["chain"]): { host: string; port: number; username: string }[] {
    return chain.map((hop) => {
      return {
        host: hop.host,
        port: hop.port,
        username: hop.auth?.username ?? "",
      }
    }).sort((a, b) => a.host.localeCompare(b.host))
  }

  /** Get existing session by config hash (for session reuse) */
  getSessionByHash(hash: string): SSHSession | undefined {
    const sessionId = this.sessionsByProfile.get(hash)
    if (!sessionId) return undefined
    return this.getSession(sessionId)
  }

  /** Get all sessions grouped by profile */
  getSessionsByProfile(): Map<string, SSHSession[]> {
    const result = new Map<string, SSHSession[]>()
    for (const [hash, sessionId] of this.sessionsByProfile) {
      const session = this.getSession(sessionId)
      if (session) {
        const list = result.get(hash) ?? []
        list.push(session)
        result.set(hash, list)
      }
    }
    return result
  }

  /** Create and connect a new SSH session */
  async connect(opts: ConnectionOptions): Promise<SSHSession> {
    if (this.sessions.size >= this.maxSessions) {
      log("sm", `Max sessions (${this.maxSessions}) reached, rejecting`)
      throw new Error(`Maximum concurrent sessions (${this.maxSessions}) reached`)
    }

    if (opts.chain.length === 0) {
      throw new Error("Connection chain cannot be empty")
    }

    const configHash = this.generateConfigHash(opts.chain)
    log("sm", `Config hash: ${configHash}, chain: ${opts.chain.map(h => h.host).join(" -> ")}`)

    if (opts.reuseSession !== false) {
      const existingSession = this.getSessionByHash(configHash)
      if (existingSession && existingSession.status === "connected") {
        log("sm", `Reusing existing session ${existingSession.id.slice(0, 8)} for config ${configHash}`)
        return existingSession
      }
    }

    const id = randomUUID()
    log("sm", `Creating session ${id.slice(0, 8)}, chain: ${opts.chain.map(h => h.host).join(" -> ")}`)
    const chainNames = opts.chain.map((h) => h.host)
    const chainSummary = chainNames.join(" -> ")
    const name = opts.name ?? chainSummary

    const session: SSHSession = {
      id,
      name,
      status: "connecting",
      chainSummary,
      hops: opts.chain.length - 1,
      createdAt: Date.now(),
      lastActivity: Date.now(),
    }

    const connection = new SSHConnection()
    const entry: { connection: SSHConnection; session: SSHSession; listeners: ConnectionEventListener[] } = { connection, session, listeners: [] }
    this.sessions.set(id, entry)
    this.sessionsByProfile.set(configHash, id)

    // Forward connection events
    connection.on("event", (event: ConnectionEvent) => {
      entry.session.lastActivity = Date.now()
      if (event.type === "connected") {
        entry.session.status = "connected"
      } else if (event.type === "disconnected") {
        entry.session.status = "disconnected"
      } else if (event.type === "error") {
        entry.session.status = "error"
        entry.session.error = (event as { type: "error"; error: string }).error
      }
      for (const listener of entry.listeners) {
        listener(event)
      }
      this.emit("session-event", event)
    })

    const terminalSize = opts.terminalSize ?? this.defaultTerminalSize

    try {
      await connection.connect({
        chain: opts.chain,
        terminalSize,
        timeout: opts.timeout,
        sessionId: id,
      })
    } catch (err: any) {
      entry.session.status = "error"
      entry.session.error = err.message
      throw err
    }

    return session
  }

  /** Disconnect a specific session */
  async disconnect(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId)
    if (!entry) throw new Error(`Session ${sessionId} not found`)
    log("sm", `Disconnecting session ${sessionId.slice(0, 8)}`)
    await entry.connection.disconnect()
    entry.session.status = "closed"
    this.sessions.delete(sessionId)

    for (const [hash, id] of this.sessionsByProfile) {
      if (id === sessionId) {
        this.sessionsByProfile.delete(hash)
        break
      }
    }

    log("sm", `Session ${sessionId.slice(0, 8)} disconnected and removed`)
  }

  /** Disconnect all sessions */
  async disconnectAll(): Promise<void> {
    const promises: Promise<void>[] = []
    for (const [, entry] of this.sessions) {
      promises.push(
        entry.connection.disconnect().then(() => {
          entry.session.status = "closed"
        })
      )
    }
    await Promise.allSettled(promises)
    this.sessions.clear()
  }

  /** Send data to a session's remote shell */
  async sendData(sessionId: string, data: string | Buffer): Promise<void> {
    const entry = this.sessions.get(sessionId)
    if (!entry) throw new Error(`Session ${sessionId} not found`)
    if (entry.session.status !== "connected") {
      throw new Error(`Session ${sessionId} is not connected (status: ${entry.session.status})`)
    }
    await entry.connection.sendData(data)
    entry.session.lastActivity = Date.now()
  }

  /** Resize the terminal for a session */
  async resize(sessionId: string, cols: number, rows: number): Promise<void> {
    const entry = this.sessions.get(sessionId)
    if (!entry) throw new Error(`Session ${sessionId} not found`)
    await entry.connection.resize(cols, rows)
  }

  /** Subscribe to events from a specific session */
  subscribe(sessionId: string, listener: ConnectionEventListener): () => void {
    const entry = this.sessions.get(sessionId)
    if (!entry) throw new Error(`Session ${sessionId} not found`)
    entry.listeners.push(listener)
    return () => {
      const idx = entry.listeners.indexOf(listener)
      if (idx >= 0) entry.listeners.splice(idx, 1)
    }
  }

  /** Get a session by ID */
  getSession(sessionId: string): SSHSession | undefined {
    return this.sessions.get(sessionId)?.session
  }

  /** List all sessions */
  listSessions(): SSHSession[] {
    return Array.from(this.sessions.values()).map((e) => ({ ...e.session }))
  }

  /** Get sessions filtered by status */
  getSessionsByStatus(status: SessionStatus): SSHSession[] {
    return this.listSessions().filter((s) => s.status === status)
  }

  /** Number of active sessions */
  get sessionCount(): number {
    return this.sessions.size
  }

  /** Check if a session exists */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  /** Get last activity timestamp for a session */
  getLastActivity(sessionId: string): number | undefined {
    return this.sessions.get(sessionId)?.session.lastActivity
  }

  /** Get the underlying SSHConnection for a session (for remote tools / SFTP / exec) */
  getConnection(sessionId: string): SSHConnection | undefined {
    return this.sessions.get(sessionId)?.connection
  }
}
