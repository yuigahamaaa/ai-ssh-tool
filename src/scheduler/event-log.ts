
import { existsSync, mkdirSync, appendFileSync, readFileSync } from "fs"
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
    const events: SchedulerEvent[] = []
    try {
      const content = readFileSync(this.currentFile, "utf8")
      const lines = content.trim().split("\n").reverse()
      for (const line of lines) {
        if (events.length >= limit) break
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line) as SchedulerEvent
          if (!hostId || event.hostId === hostId) {
            events.push(event)
          }
        } catch {
          continue
        }
      }
    } catch {
      // ignore
    }
    return events
  }
}
