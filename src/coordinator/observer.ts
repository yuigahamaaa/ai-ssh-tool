import { readFileSync, readlinkSync, readdirSync } from "fs"
import { execFile } from "child_process"
import { promisify } from "util"
import { toObservedProcess, toObservedSession, type ProcessSample, type SessionSample, MAX_OBSERVED_PROCESSES } from "./observer-protocol.js"
import type { ObservedProcess, ObservedSession } from "./protocol.js"

const execFileAsync = promisify(execFile)

export interface ObserverSubmitter {
  submit(sessions: ObservedSession[], processes: ObservedProcess[]): Promise<void>
}

export interface ObserverReaders {
  readSessions(): Promise<SessionSample[]>
  readProcesses(): Promise<ProcessSample[]>
}

export class SshToolObserver {
  private timer: NodeJS.Timeout | null = null
  private stopped = false

  constructor(private readonly readers: ObserverReaders, private readonly submitter: ObserverSubmitter, private readonly intervalMs = 30_000) {}

  async scan(now = Date.now()): Promise<void> {
    const [sessions, processes] = await Promise.all([this.readers.readSessions(), this.readers.readProcesses()])
    await this.submitter.submit(sessions.map((session) => toObservedSession(session, now)), processes.slice(0, MAX_OBSERVED_PROCESSES).map((process) => toObservedProcess(process, now)))
  }

  start(): void {
    if (this.timer) return
    this.stopped = false
    this.timer = setInterval(() => { void this.scan().catch(() => {}) }, this.intervalMs)
    this.timer.unref()
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

export function createSystemObserverReaders(): ObserverReaders {
  return {
    async readSessions(): Promise<SessionSample[]> {
      const { stdout } = await execFileAsync("who", [], { maxBuffer: 1024 * 1024 })
      return stdout.split("\n").filter(Boolean).map((line) => {
        const match = /^(\S+)\s+(\S+)\s+(.+?)(?:\s+\(([^)]+)\))?$/.exec(line.trim())
        if (!match) return null
        return { sessionId: `${match[1]}:${match[2]}`, username: match[1], tty: match[2], sourceAddress: match[4], uid: 0 } as SessionSample
      }).filter((value): value is SessionSample => value !== null)
    },
    async readProcesses(): Promise<ProcessSample[]> {
      const result: ProcessSample[] = []
      for (const name of readdirSync("/proc")) {
        if (!/^\d+$/.test(name)) continue
        try {
          const status = readFileSync(`/proc/${name}/status`, "utf8")
          const uidLine = /^Uid:\s+(\d+)/m.exec(status)
          const ppidLine = /^PPid:\s+(\d+)/m.exec(status)
          if (!uidLine || !ppidLine) continue
          const command = readFileSync(`/proc/${name}/cmdline`).toString("utf8").replace(/\0/g, " ").trim()
          if (!command) continue
          const uid = Number(uidLine[1])
          result.push({ pid: Number(name), parentPid: Number(ppidLine[1]), uid, username: String(uid), cwd: readlinkSync(`/proc/${name}/cwd`), command })
        } catch {
          continue
        }
      }
      return result
    },
  }
}
