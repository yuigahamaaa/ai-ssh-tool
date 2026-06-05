/**
 * IPC Protocol - shared types and framing for daemon <-> CLI communication
 * Transport: named pipe (Windows) or Unix socket (Unix)
 * Framing: newline-delimited JSON
 */

import type { Socket } from "net"
import { randomUUID } from "crypto"
import { join } from "path"
import { homedir } from "os"

/**
 * Get user data directory with cross-platform support.
 */
function getUserDataDir(): string {
  if (process.platform === "win32") {
    const userProfile = process.env.USERPROFILE || process.env.HOMEPATH
    if (userProfile) return userProfile
  }
  return homedir()
}

// --- Transport paths ---

export function getPipePath(): string {
  if (process.platform === "win32") {
    return "\\\\.\\pipe\\ssh-exec-daemon"
  }
  return join(getUserDataDir(), ".ssh-exec-daemon.sock")
}

export function getPidPath(): string {
  return join(getUserDataDir(), ".ssh-exec-daemon.pid")
}

import type { ScheduleRequest } from "./scheduler/types.js"

// --- Request types ---

export type IPCRequest =
  | { id: string; action: "connect"; params: { configPath: string } }
  | { id: string; action: "connectJson"; params: { configJson: string } }
  | { id: string; action: "exec"; params: { sessionId: string; command: string; timeout?: number } }
  | { id: string; action: "disconnect"; params: { sessionId: string } }
  | { id: string; action: "transfer"; params: { sessionId: string; action: string; localPath: string; remotePath: string } }
  | { id: string; action: "bgExec"; params: { sessionId: string; subcommand: string; command?: string; taskId?: string } }
  | { id: string; action: "portForward"; params: { sessionId: string; subcommand: string; type?: string; bindAddr?: string; bindPort?: number; dstAddr?: string; dstPort?: number; forwardId?: string } }
  | { id: string; action: "schedule"; params: ScheduleRequest }
  | { id: string; action: "queueStatus"; params: { agent?: { id: string; name?: string; clientType: string }; hostId?: string; limit?: number } }
  | { id: string; action: "waitTask"; params: { taskId: string; timeoutMs?: number } }
  | { id: string; action: "dequeueTask"; params: { taskId: string; agent?: { id: string; name?: string; clientType: string } } }
  | { id: string; action: "cancelTask"; params: { taskId: string } }
  | { id: string; action: "getTaskOutput"; params: { taskId: string; mode?: string } }
  | { id: string; action: "getTaskStatus"; params: { taskId: string } }
  | { id: string; action: "cleanupOutputs"; params: Record<string, never> }
  | { id: string; action: "abortActiveTasks"; params: { reason: string } }
  | { id: string; action: "setCwd"; params: { agent: { id: string; name?: string; clientType: string }; host: { id: string; profileKey: string; targetHost: string; targetUser: string; displayName: string }; cwd: string } }
  | { id: string; action: "list" }
  | { id: string; action: "ping" }
  | { id: string; action: "shutdown" }

// --- Response types ---

export type IPCResponse =
  | { id: string; ok: true; data: unknown }
  | { id: string; ok: false; error: string }

// --- Message framing ---

export function encodeMessage(msg: IPCRequest | IPCResponse): string {
  return JSON.stringify(msg) + "\n"
}

/**
 * Parse newline-delimited JSON from a buffer.
 * Returns remaining unconsumed bytes.
 */
export function parseMessages(
  buffer: Buffer,
  onMessage: (msg: IPCRequest | IPCResponse) => void,
): Buffer<ArrayBuffer> {
  const str = buffer.toString("utf-8")
  const lines = str.split("\n")

  // Last element is either empty (complete) or partial data
  const remainder = lines.pop() ?? ""

  for (const line of lines) {
    if (line.trim()) {
      try {
        onMessage(JSON.parse(line))
      } catch {
        // skip malformed lines
      }
    }
  }

  return Buffer.from(remainder, "utf-8")
}

// --- Request helpers ---

export function createRequest(
  action: IPCRequest["action"],
  params?: Record<string, unknown>,
): IPCRequest {
  const id = randomUUID()
  if (action === "connect" || action === "connectJson" || action === "exec" || action === "disconnect" || action === "transfer" || action === "bgExec" || action === "portForward" || action === "schedule" || action === "queueStatus" || action === "waitTask" || action === "dequeueTask" || action === "cancelTask" || action === "getTaskOutput" || action === "getTaskStatus" || action === "cleanupOutputs" || action === "abortActiveTasks" || action === "setCwd") {
    return { id, action, params: params as any }
  }
  return { id, action } as IPCRequest
}

/** Deep-sort JSON keys to produce a canonical hash regardless of key order */
export function normalizeConfig(jsonStr: string): string {
  const parsed = JSON.parse(jsonStr)
  return JSON.stringify(parsed, (_key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.keys(value).sort().reduce((sorted: Record<string, unknown>, key) => {
        sorted[key] = value[key]
        return sorted
      }, {})
    }
    return value
  })
}

// --- Per-socket client state ---

interface PendingRequest {
  resolve: (resp: IPCResponse) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Per-socket IPC client. Each instance owns its own buffer and pending map.
 * No shared global state — safe for concurrent use across multiple sockets.
 */
export class IPCSocket {
  private buffer = Buffer.alloc(0)
  private pending = new Map<string, PendingRequest>()
  private dataHandler: ((data: Buffer) => void) | null = null
  private closeHandler: (() => void) | null = null

  constructor(private socket: Socket) {
    // When socket closes, reject all pending requests immediately
    this.closeHandler = () => {
      this.rejectAll(new Error("IPC socket closed"))
    }
    socket.on("close", this.closeHandler)

    this.dataHandler = (data: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, data])
      this.buffer = parseMessages(this.buffer, (msg) => {
        const resp = msg as IPCResponse
        if (resp.id && this.pending.has(resp.id)) {
          const p = this.pending.get(resp.id)!
          clearTimeout(p.timer)
          this.pending.delete(resp.id)
          p.resolve(resp)
        }
      })
    }
    socket.on("data", this.dataHandler)
  }

  /** Send a request and wait for the matching response */
  send(req: IPCRequest, timeoutMs = 30000): Promise<IPCResponse> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(req.id)
        reject(new Error(`IPC request timed out after ${timeoutMs}ms: ${req.action}`))
      }, timeoutMs)

      this.pending.set(req.id, { resolve, reject, timer })
      this.socket.write(encodeMessage(req))
    })
  }

  /** Reject all pending requests and clean up */
  rejectAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }

  /** Detach listeners and clean up */
  dispose(): void {
    this.rejectAll(new Error("IPC client disposed"))
    if (this.dataHandler) {
      this.socket.off("data", this.dataHandler)
      this.dataHandler = null
    }
    if (this.closeHandler) {
      this.socket.off("close", this.closeHandler)
      this.closeHandler = null
    }
    this.buffer = Buffer.alloc(0)
  }
}
