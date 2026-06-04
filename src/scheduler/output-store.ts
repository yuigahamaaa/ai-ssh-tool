
import { existsSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, unlinkSync } from "fs"
import { join, dirname } from "path"
import { homedir } from "os"

export const OUTPUT_TAIL_LIMIT = 64 * 1024
const MAX_OUTPUT_FILE_SIZE = 10 * 1024 * 1024

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

export class OutputStore {
  private baseDir: string
  private inMemory = new Map<string, { stdoutTail: string; stderrTail: string; stdoutBytes: number; stderrBytes: number }>()

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(getUserDataDir(), ".ssh-tool", "scheduler", "outputs")
    if (!existsSync(this.baseDir)) {
      mkdirSync(this.baseDir, { recursive: true, mode: 0o700 })
    }
  }

  private getStdoutPath(taskId: string): string {
    return join(this.baseDir, `${taskId}.stdout`)
  }

  private getStderrPath(taskId: string): string {
    return join(this.baseDir, `${taskId}.stderr`)
  }

  create(taskId: string): void {
    this.inMemory.set(taskId, { stdoutTail: "", stderrTail: "", stdoutBytes: 0, stderrBytes: 0 })
    writeFileSync(this.getStdoutPath(taskId), "", { mode: 0o600 })
    writeFileSync(this.getStderrPath(taskId), "", { mode: 0o600 })
  }

  appendStdout(taskId: string, data: string): void {
    const entry = this.inMemory.get(taskId)
    if (!entry) return
    entry.stdoutTail += data
    entry.stdoutBytes += Buffer.byteLength(data)
    if (entry.stdoutTail.length > OUTPUT_TAIL_LIMIT) {
      entry.stdoutTail = entry.stdoutTail.slice(-OUTPUT_TAIL_LIMIT)
    }
    const stdoutPath = this.getStdoutPath(taskId)
    if (entry.stdoutBytes <= MAX_OUTPUT_FILE_SIZE) {
      appendFileSync(stdoutPath, data)
    }
  }

  appendStderr(taskId: string, data: string): void {
    const entry = this.inMemory.get(taskId)
    if (!entry) return
    entry.stderrTail += data
    entry.stderrBytes += Buffer.byteLength(data)
    if (entry.stderrTail.length > OUTPUT_TAIL_LIMIT) {
      entry.stderrTail = entry.stderrTail.slice(-OUTPUT_TAIL_LIMIT)
    }
    const stderrPath = this.getStderrPath(taskId)
    if (entry.stderrBytes <= MAX_OUTPUT_FILE_SIZE) {
      appendFileSync(stderrPath, data)
    }
  }

  get(taskId: string): { stdoutTail: string; stderrTail: string; stdoutBytes: number; stderrBytes: number } | undefined {
    return this.inMemory.get(taskId)
  }

  getFullStdout(taskId: string): string {
    try {
      return readFileSync(this.getStdoutPath(taskId), "utf8")
    } catch {
      return ""
    }
  }

  getFullStderr(taskId: string): string {
    try {
      return readFileSync(this.getStderrPath(taskId), "utf8")
    } catch {
      return ""
    }
  }

  remove(taskId: string): void {
    this.inMemory.delete(taskId)
    try { unlinkSync(this.getStdoutPath(taskId)) } catch {}
    try { unlinkSync(this.getStderrPath(taskId)) } catch {}
  }
}
