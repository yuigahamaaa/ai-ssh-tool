
import { existsSync, mkdirSync, appendFileSync, readFileSync, readdirSync, unlinkSync, statSync } from "fs"
import { openSync, readSync, closeSync, fstatSync } from "fs"
import { join } from "path"
import type { SchedulerEvent, EventType } from "./types.js"
import { getSchedulerEventsDir, ensureDir } from "../paths.js"

const MAX_EVENTS_PER_FILE = 1000
const FLUSH_INTERVAL_MS = 200
const DEFAULT_EVENT_RETENTION_DAYS = 30

export class EventLog {
  private baseDir: string
  private currentFile = ""
  private currentDate = ""
  private eventCount = 0
  // Batched-write buffer. Multiple log() calls within FLUSH_INTERVAL_MS are
  // coalesced into a single appendFileSync, eliminating the per-event disk
  // stall that previously blocked the daemon event loop on every scheduler
  // state transition (a single task lifecycle can produce 4-6 events).
  private buffer: string[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? getSchedulerEventsDir()
    if (!existsSync(this.baseDir)) {
      mkdirSync(this.baseDir, { recursive: true, mode: 0o700 })
    }
    this.initCurrentFile()
    this.cleanupOldFiles()
  }

  /**
   * Find or create the current event file for today. If today's base file
   * (events-YYYY-MM-DD.jsonl) already has >= MAX_EVENTS_PER_FILE lines,
   * advance to the next numbered suffix (events-YYYY-MM-DD.1.jsonl, etc.).
   */
  private initCurrentFile(): void {
    const now = new Date()
    const dateStr = now.toISOString().slice(0, 10)
    this.currentDate = dateStr
    const baseName = `events-${dateStr}.jsonl`
    const basePath = join(this.baseDir, baseName)

    if (!existsSync(basePath)) {
      this.currentFile = basePath
      this.eventCount = 0
      return
    }

    const baseCount = this.countLines(basePath)
    if (baseCount < MAX_EVENTS_PER_FILE) {
      this.currentFile = basePath
      this.eventCount = baseCount
      return
    }

    // Base file is full, find the next available numbered suffix
    let seq = 1
    while (existsSync(join(this.baseDir, `events-${dateStr}.${seq}.jsonl`))) {
      const seqCount = this.countLines(join(this.baseDir, `events-${dateStr}.${seq}.jsonl`))
      if (seqCount < MAX_EVENTS_PER_FILE) {
        this.currentFile = join(this.baseDir, `events-${dateStr}.${seq}.jsonl`)
        this.eventCount = seqCount
        return
      }
      seq++
    }
    this.currentFile = join(this.baseDir, `events-${dateStr}.${seq}.jsonl`)
    this.eventCount = 0
  }

  /**
   * Rotate to a new file when the current one hits MAX_EVENTS_PER_FILE.
   * If the date has changed, start a new base file for the new day.
   * Otherwise, advance to the next numbered suffix for the current day.
   */
  private rotateFile(): void {
    const now = new Date()
    const dateStr = now.toISOString().slice(0, 10)
    if (dateStr !== this.currentDate) {
      // New day: reset to base file
      this.currentDate = dateStr
      this.currentFile = join(this.baseDir, `events-${dateStr}.jsonl`)
      this.eventCount = 0
    } else {
      // Same day: advance to next numbered suffix
      let seq = 1
      while (existsSync(join(this.baseDir, `events-${dateStr}.${seq}.jsonl`))) {
        seq++
      }
      this.currentFile = join(this.baseDir, `events-${dateStr}.${seq}.jsonl`)
      this.eventCount = 0
    }
  }

  private countLines(filePath: string): number {
    try {
      const content = readFileSync(filePath, "utf8")
      let count = 0
      for (let i = 0; i < content.length; i++) {
        if (content.charCodeAt(i) === 10) count++
      }
      // If the file doesn't end with a newline, count the last line too
      if (content.length > 0 && content.charCodeAt(content.length - 1) !== 10) count++
      return count
    } catch {
      return 0
    }
  }

  /**
   * Delete event files older than `retentionDays`. Called once at
   * construction to prevent unbounded accumulation of historical logs.
   */
  cleanupOldFiles(retentionDays: number = DEFAULT_EVENT_RETENTION_DAYS): number {
    const now = Date.now()
    const retentionMs = retentionDays * 24 * 60 * 60 * 1000
    let deleted = 0
    try {
      const files = readdirSync(this.baseDir)
      for (const file of files) {
        if (!file.startsWith("events-") || !file.endsWith(".jsonl")) continue
        const filePath = join(this.baseDir, file)
        try {
          const stat = statSync(filePath)
          if (now - stat.mtimeMs > retentionMs) {
            try { unlinkSync(filePath); deleted++ } catch {}
          }
        } catch {}
      }
    } catch {}
    return deleted
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

    this.buffer.push(JSON.stringify(event) + "\n")
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flush()
    }, FLUSH_INTERVAL_MS)
  }

  /**
   * Force an immediate flush of any pending events. Callers (notably
   * `SchedulerService.dispose()` and the auto-flush in `getRecent`) use this
   * to make sure no event is lost on shutdown or stays invisible to a
   * subsequent read.
   */
  flushSync(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.flush()
  }

  private flush(): void {
    if (this.buffer.length === 0) return
    // Snapshot then clear so a re-entrant log() during flush is re-buffered
    // for the next round instead of being lost.
    const batch = this.buffer
    this.buffer = []
    const payload = batch.join("")
    try {
      appendFileSync(this.currentFile, payload, { mode: 0o600 })
      this.eventCount += batch.length
    } catch (err) {
      // Re-buffer the batch on failure so the next flush retries. Avoid
      // throwing from log() — a failed event write must never crash the
      // scheduler.
      this.buffer.unshift(...batch)
      return
    }

    if (this.eventCount >= MAX_EVENTS_PER_FILE) {
      this.rotateFile()
    }
  }

  getRecent(limit = 100, hostId?: string): SchedulerEvent[] {
    // Auto-flush before reading so callers always see the most recent events,
    // not whatever the 200ms debounce hasn't drained yet. This preserves
    // the original "log + getRecent sees the event immediately" contract.
    this.flushSync()
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
