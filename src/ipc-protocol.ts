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
 * Debug logger for malformed-frame diagnostics. We intentionally avoid
 * importing the project's debug-aware logger to keep the parser free of
 * side-effects that complicate unit tests. The output is gated by the
 * SSH_TOOL_DEBUG env var (matching the rest of the project).
 */
function debugLog(channel: string, message: string): void {
  if (process.env.SSH_TOOL_DEBUG === "1" || process.env.SSH_TOOL_DEBUG === "true") {
    // eslint-disable-next-line no-console
    console.error(`[${channel}] ${message}`)
  }
}

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
import type { FolderTransferOptions } from "./file-transfer.js"

// --- Request types ---

export type IPCRequest =
  | { id: string; action: "connect"; params: { configPath: string } }
  | { id: string; action: "connectJson"; params: { configJson: string } }
  | { id: string; action: "exec"; params: { sessionId: string; command: string; timeout?: number } }
  | { id: string; action: "disconnect"; params: { sessionId: string } }
  | { id: string; action: "transfer"; params: { sessionId: string; action: string; localPath: string; remotePath: string; options?: FolderTransferOptions } }
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
      } catch (e) {
        // P2-7: log malformed IPC lines so debugging a corrupt client
        // or a partial frame is possible. The line is dropped (we can't
        // recover), but we record what it was.
        debugLog("ipc", `Skipped malformed IPC line (${(e as Error).message}): ${line.slice(0, 256)}`)
      }
    }
  }

  return Buffer.from(remainder, "utf-8")
}

/**
 * Incremental newline-delimited JSON parser for socket streams.
 * Keeps the partial trailing line as a string to avoid Buffer.concat on every chunk.
 */
const DEFAULT_MAX_REMAINDER_BYTES = 16 * 1024 * 1024 // 16MB

export class IPCMessageParser {
  private chunks: Buffer[] = []
  // Offset into chunks[0] of the first byte not yet consumed. After a
  // newline splits off a frame we advance this; once it reaches
  // chunks[0].length we discard that buffer. The offset only ever moves
  // forward and never wraps, so a long stream of small frames doesn't
  // keep a 10MB+ buffer alive.
  private firstChunkOffset = 0
  private totalBytes = 0
  private maxRemainderBytes: number

  constructor(maxRemainderBytes?: number) {
    this.maxRemainderBytes = maxRemainderBytes ?? DEFAULT_MAX_REMAINDER_BYTES
  }

  get remainderLength(): number {
    return this.totalBytes
  }

  push(
    chunk: Buffer | string,
    onMessage: (msg: IPCRequest | IPCResponse) => void,
  ): void {
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk
    this.totalBytes += buf.length
    if (this.totalBytes > this.maxRemainderBytes) {
      const actualBytes = this.totalBytes
      this.chunks = []
      this.totalBytes = 0
      throw new Error(
        `IPC frame exceeded max size: ${actualBytes} bytes > ${this.maxRemainderBytes} bytes limit. ` +
        `The remote peer is sending malformed data or an oversized message without a newline terminator. ` +
        `Suggestion: reconnect to the daemon and resend the request. ` +
        `If this recurs, check for corrupt JSON or extremely large command output that should be transferred via SFTP instead.`,
      )
    }

    this.chunks.push(buf)

    // Scan the chunk list for newline boundaries and emit one frame per
    // newline, **without ever re-copying bytes we have already passed**.
    // The previous implementation called `Buffer.concat(this.chunks)` on
    // every push that contained a newline, which turned large-frame
    // streams (e.g. 10MB `getTaskOutput full` responses) into O(n²)
    // copies: each new 64KB chunk triggered a reallocation of the entire
    // growing remainder. Here we walk the chunks array with an offset
    // cursor and only allocate the bytes of the frame itself, so the
    // total per-frame allocation stays O(frame_size) regardless of how
    // many chunks came before it.
    while (this.chunks.length > 0) {
      // Find the next newline across all chunks. A newline may be:
      //  - inside chunks[0] at offset >= firstChunkOffset
      //  - inside chunks[k] for k >= 1 at offset >= 0
      // Returns (chunkIndex, byteIndex) of the newline byte, or null if
      // none was found yet.
      let newlineAt: { chunkIdx: number; byteIdx: number } | null = null
      for (let ci = 0; ci < this.chunks.length; ci++) {
        const c = this.chunks[ci]
        const start = ci === 0 ? this.firstChunkOffset : 0
        for (let i = start; i < c.length; i++) {
          if (c[i] === 10) {
            newlineAt = { chunkIdx: ci, byteIdx: i }
            break
          }
        }
        if (newlineAt) break
      }
      if (!newlineAt) {
        // No newline anywhere yet; keep accumulating.
        break
      }

      // Slice out the frame bytes. The frame starts at `firstChunkOffset`
      // in chunks[0] and ends at the byte before the newline.
      const { chunkIdx: nlChunk, byteIdx: nlByte } = newlineAt
      const frameEndExclusive = nlByte + 1 // skip the newline byte

      if (nlChunk === 0 && this.firstChunkOffset === 0 && frameEndExclusive === this.chunks[0].length) {
        // Single-chunk frame, fits entirely inside chunks[0]. Fast path:
        // take a subarray view, then drop chunks[0] entirely.
        const lineBuf = this.chunks[0]
        this.chunks.shift()
        this.firstChunkOffset = 0
        this.emitLine(lineBuf, onMessage)
        continue
      }

      if (nlChunk === 0 && frameEndExclusive <= this.chunks[0].length) {
        // Frame is contained in chunks[0] but the chunk has more bytes
        // after the newline.
        const lineBuf = this.chunks[0].subarray(this.firstChunkOffset, nlByte)
        this.firstChunkOffset = frameEndExclusive
        this.emitLine(lineBuf, onMessage)
        continue
      }

      // Frame spans multiple chunks. Walk chunks and accumulate only the
      // frame bytes; the remainder after the newline stays in chunks[0]
      // (a subarray view) so no re-allocation happens.
      const parts: Buffer[] = []
      let totalLen = 0
      for (let ci = 0; ci <= nlChunk; ci++) {
        const c = this.chunks[ci]
        const startInChunk = ci === 0 ? this.firstChunkOffset : 0
        if (ci === nlChunk) {
          parts.push(c.subarray(startInChunk, frameEndExclusive))
          totalLen += frameEndExclusive - startInChunk
        } else {
          parts.push(c.subarray(startInChunk))
          totalLen += c.length - startInChunk
        }
      }
      // Replace chunks[0] with the leftover bytes (everything after the
      // newline in the newline's chunk), and drop everything up to and
      // including that chunk.
      this.chunks[0] = this.chunks[nlChunk].subarray(frameEndExclusive)
      // Drop chunks[1..nlChunk] since their bytes are now in `parts`.
      this.chunks.splice(1, nlChunk)
      this.firstChunkOffset = 0
      const lineBuf = parts.length === 1 ? parts[0] : Buffer.concat(parts, totalLen)
      this.emitLine(lineBuf, onMessage)
    }

    // Recompute the cached byte count so `remainderLength` is accurate.
    let total = 0
    if (this.chunks.length > 0) {
      total += this.chunks[0].length - this.firstChunkOffset
      for (let i = 1; i < this.chunks.length; i++) total += this.chunks[i].length
    }
    this.totalBytes = total
  }

  private emitLine(
    lineBuf: Buffer,
    onMessage: (msg: IPCRequest | IPCResponse) => void,
  ): void {
    const line = lineBuf.toString("utf8").trim()
    if (!line) return
    try {
      onMessage(JSON.parse(line))
    } catch (e) {
      // P2-7: same as the legacy split() path — log the malformed
      // frame so the daemon can tell the operator why a request was
      // dropped without a response.
      debugLog("ipc", `Skipped malformed IPC frame (${(e as Error).message}): ${line.slice(0, 256)}`)
    }
  }

  reset(): void {
    this.chunks = []
    this.firstChunkOffset = 0
    this.totalBytes = 0
  }
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

/**
 * Deep-sort JSON keys to produce a canonical hash regardless of key order.
 * Accepts either a JSON string (one parse) or an already-parsed object (no
 * parse) so callers with a cached parsed tree can skip the second JSON.parse
 * the daemon previously had to do per `connect` call.
 */
export function normalizeConfig(input: string | unknown): string {
  const parsed = typeof input === "string" ? JSON.parse(input) : input
  return JSON.stringify(parsed, (_key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.keys(value as Record<string, unknown>).sort().reduce((sorted: Record<string, unknown>, key) => {
        sorted[key] = (value as Record<string, unknown>)[key]
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
  private parser = new IPCMessageParser()
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
      this.parser.push(data, (msg) => {
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
    this.parser.reset()
  }
}
