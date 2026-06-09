
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
    try {
      const TAIL_CHUNK = 64 * 1024
      const fd = openSync(this.currentFile, "r")
      try {
        const stats = fstatSync(fd)
        const fileSize = stats.size
        if (fileSize === 0) return []
        const readSize = Math.min(TAIL_CHUNK, fileSize)
        const buffer = Buffer.alloc(readSize)
        readSync(fd, buffer, 0, readSize, fileSize - readSize)
        const chunk = buffer.toString("utf8")
        const events: SchedulerEvent[] = []
        const lines = chunk.split("\n")
        const startIdx = fileSize > readSize ? 1 : 0
        for (let i = lines.length - 1; i >= startIdx; i--) {
          if (events.length >= limit) break
          const line = lines[i].trim()
          if (!line) continue
          try {
            const event = JSON.parse(line) as SchedulerEvent
            if (!hostId || event.hostId === hostId) {
              events.push(event)
            }
          } catch {
            continue
          }
        }
        if (events.length < limit && fileSize > readSize) {
          const fullContent = readFileSync(this.currentFile, "utf8")
          const allLines = fullContent.trim().split("\n").reverse()
          const fallback: SchedulerEvent[] = []
          for (const line of allLines) {
            if (fallback.length >= limit) break
            if (!line.trim()) continue
            try {
              const event = JSON.parse(line) as SchedulerEvent
              if (!hostId || event.hostId === hostId) {
                fallback.push(event)
              }
            } catch {
              continue
            }
          }
          return fallback
        }
        return events
      } finally {
        closeSync(fd)
      }
    } catch {
      return []
    }
  }
}
