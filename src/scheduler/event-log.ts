
import { existsSync, mkdirSync, appendFileSync, readFileSync } from "fs"
import { openSync, readSync, closeSync, fstatSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import type { SchedulerEvent, EventType } from "./types.js"

const MAX_EVENTS_PER_FILE = 1000

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

export class EventLog {
  private baseDir: string
  private currentFile = ""
  private eventCount = 0

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(getUserDataDir(), ".ssh-tool", "scheduler", "events")
    if (!existsSync(this.baseDir)) {
      mkdirSync(this.baseDir, { recursive: true, mode: 0o700 })
    }
    this.rotateFile()
  }

  private rotateFile(): void {
    const now = new Date()
    const dateStr = now.toISOString().slice(0, 10)
    this.currentFile = join(this.baseDir, `events-${dateStr}.jsonl`)
    this.eventCount = 0
  }

  log(
    type: EventType,
    params: { taskId?: string; hostId?: string; agentId?: string; data?: Record<string, unknown> }
  ): void {
    const event: SchedulerEvent = {
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type,
      timestamp: Date.now(),
      ...params,
    }

    appendFileSync(this.currentFile, JSON.stringify(event) + "\n", { mode: 0o600 })
    this.eventCount++

    if (this.eventCount >= MAX_EVENTS_PER_FILE) {
      this.rotateFile()
    }
  }

  getRecent(limit = 100, hostId?: string): SchedulerEvent[] {
    if (limit <= 0) return []
    try {
      const TAIL_CHUNK = 64 * 1024
      const MAX_CHUNKS = 16 // cap at 1MB to avoid runaway reads
      const fd = openSync(this.currentFile, "r")
      try {
        const fileSize = fstatSync(fd).size
        if (fileSize === 0) return []

        // Incrementally read backwards from the end of the file. Each iteration
        // grows the read window by TAIL_CHUNK; we stop as soon as we have
        // enough matching events or the file is exhausted. The first time we
        // exceed the limit (or run out of file) we fall through to a single
        // bounded full-file read so we can return oldest-first results in
        // correct reverse order.
        let offset = fileSize
        let buffer = Buffer.alloc(0)
        for (let chunkIdx = 0; chunkIdx < MAX_CHUNKS; chunkIdx++) {
          const want = Math.min(TAIL_CHUNK, offset)
          if (want <= 0) break
          const tmp = Buffer.alloc(want)
          readSync(fd, tmp, 0, want, offset - want)
          buffer = Buffer.concat([tmp, buffer], buffer.length + want)
          offset -= want

          // Try to parse the lines we have. If the head of `buffer` is a
          // truncated line (no leading newline), drop it — we'll keep
          // extending backwards until we have a clean line boundary.
          const text = buffer.toString("utf8")
          if (!text.startsWith("\n") && offset > 0) continue

          const events = this.collectEvents(text, limit, hostId, /*fromStart=*/ true)
          if (events.length >= limit) return events
          if (offset === 0) {
            // Whole file scanned; return what we have.
            return events
          }
        }

        // Fallback: we exhausted the chunk budget without enough matches.
        // Bounded full-file read so we don't keep streaming forever.
        const fullContent = readFileSync(this.currentFile, "utf8")
        return this.collectEvents(fullContent, limit, hostId, /*fromStart=*/ true)
      } finally {
        closeSync(fd)
      }
    } catch {
      return []
    }
  }

  /**
   * Parse lines from `text` and return the most recent `limit` events,
   * optionally filtered by hostId. Returns events in reverse chronological
   * order (newest first).
   */
  private collectEvents(text: string, limit: number, hostId: string | undefined, fromStart: boolean): SchedulerEvent[] {
    const events: SchedulerEvent[] = []
    const lines = text.split("\n")
    // When fromStart=true, the caller has already trimmed the first line
    // because it was a partial — start from the end of `lines` and skip the
    // empty trailing line that split() always produces.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim()
      if (!line) continue
      try {
        const event = JSON.parse(line) as SchedulerEvent
        if (!hostId || event.hostId === hostId) {
          events.push(event)
          if (events.length >= limit) break
        }
      } catch {
        continue
      }
    }
    return events
  }
}
