import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs"
import { join, relative, resolve } from "path"
import { homedir } from "os"
import type { TaskOutputFiles, TaskOutputResult } from "./types.js"

export const OUTPUT_TAIL_LIMIT = 64 * 1024
export const DEFAULT_OUTPUT_RETURN_LIMIT = 16 * 1024
const DEFAULT_MAX_OUTPUT_FILE_SIZE = 50 * 1024 * 1024
const DEFAULT_RETENTION_DAYS = 7
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024
const DEFAULT_KEEP_RECENT_TASKS = 200

export interface OutputEntry {
  stdoutTail: string
  stderrTail: string
  stdoutBytes: number
  stderrBytes: number
  stdoutPath: string
  stderrPath: string
  stdoutFileTruncated: boolean
  stderrFileTruncated: boolean
}

export interface OutputCleanupPolicy {
  retentionMs?: number
  maxTotalBytes?: number
  keepRecentTasks?: number
}

export interface OutputCleanupResult {
  deletedFiles: number
  deletedBytes: number
  keptFiles: number
}

function getUserDataDir(): string {
  if (process.platform === "win32") {
    const userProfile = process.env.USERPROFILE || process.env.HOMEPATH
    if (userProfile) return userProfile
  }
  return homedir()
}

function safeTaskId(taskId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(taskId)) {
    throw new Error(`Invalid task id for output path: ${taskId}`)
  }
  return taskId
}

function appendTail(current: string, data: string): string {
  const next = current + data
  if (next.length <= OUTPUT_TAIL_LIMIT) return next
  return next.slice(-OUTPUT_TAIL_LIMIT)
}

export class OutputStore {
  private baseDir: string
  private maxOutputFileSize: number
  private inMemory = new Map<string, OutputEntry>()

  constructor(baseDir?: string, opts?: { maxOutputFileSize?: number }) {
    this.baseDir = resolve(baseDir ?? join(getUserDataDir(), ".ssh-tool", "scheduler", "outputs"))
    this.maxOutputFileSize = opts?.maxOutputFileSize ?? DEFAULT_MAX_OUTPUT_FILE_SIZE
    if (!existsSync(this.baseDir)) {
      mkdirSync(this.baseDir, { recursive: true, mode: 0o700 })
    }
  }

  getBaseDir(): string {
    return this.baseDir
  }

  getPaths(taskId: string): TaskOutputFiles {
    const id = safeTaskId(taskId)
    return {
      stdout: join(this.baseDir, `${id}.stdout`),
      stderr: join(this.baseDir, `${id}.stderr`),
    }
  }

  create(taskId: string): void {
    const paths = this.getPaths(taskId)
    this.inMemory.set(taskId, {
      stdoutTail: "",
      stderrTail: "",
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutPath: paths.stdout,
      stderrPath: paths.stderr,
      stdoutFileTruncated: false,
      stderrFileTruncated: false,
    })
    writeFileSync(paths.stdout, "", { mode: 0o600 })
    writeFileSync(paths.stderr, "", { mode: 0o600 })
  }

  appendStdout(taskId: string, data: string): void {
    const entry = this.ensureEntry(taskId)
    entry.stdoutTail = appendTail(entry.stdoutTail, data)
    entry.stdoutBytes += Buffer.byteLength(data)
    this.appendWithinLimit(entry.stdoutPath, data, entry.stdoutBytes, (truncated) => {
      entry.stdoutFileTruncated = truncated
    })
  }

  appendStderr(taskId: string, data: string): void {
    const entry = this.ensureEntry(taskId)
    entry.stderrTail = appendTail(entry.stderrTail, data)
    entry.stderrBytes += Buffer.byteLength(data)
    this.appendWithinLimit(entry.stderrPath, data, entry.stderrBytes, (truncated) => {
      entry.stderrFileTruncated = truncated
    })
  }

  get(taskId: string): OutputEntry | undefined {
    return this.inMemory.get(taskId) ?? this.loadEntryFromDisk(taskId)
  }

  getFullStdout(taskId: string): string {
    return this.readFile(this.getPaths(taskId).stdout)
  }

  getFullStderr(taskId: string): string {
    return this.readFile(this.getPaths(taskId).stderr)
  }

  getOutput(taskId: string, mode: "tail" | "full" = "tail", returnLimit = DEFAULT_OUTPUT_RETURN_LIMIT): TaskOutputResult {
    const entry = this.get(taskId)
    const paths = this.getPaths(taskId)
    const stdoutBytes = entry?.stdoutBytes ?? this.sizeOf(paths.stdout)
    const stderrBytes = entry?.stderrBytes ?? this.sizeOf(paths.stderr)
    const stdoutFileTruncated = entry?.stdoutFileTruncated ?? false
    const stderrFileTruncated = entry?.stderrFileTruncated ?? false

    let stdout = mode === "full" ? this.getFullStdout(taskId) : (entry?.stdoutTail ?? "")
    let stderr = mode === "full" ? this.getFullStderr(taskId) : (entry?.stderrTail ?? "")
    let stdoutTruncated = stdoutBytes > Buffer.byteLength(stdout) || stdoutFileTruncated
    let stderrTruncated = stderrBytes > Buffer.byteLength(stderr) || stderrFileTruncated

    if (mode === "tail") {
      const limitedStdout = this.limitReturnedText(stdout, returnLimit)
      const limitedStderr = this.limitReturnedText(stderr, returnLimit)
      stdoutTruncated = stdoutTruncated || limitedStdout.truncated
      stderrTruncated = stderrTruncated || limitedStderr.truncated
      stdout = limitedStdout.text
      stderr = limitedStderr.text
    }

    return {
      stdout,
      stderr,
      stdoutBytes,
      stderrBytes,
      stdoutPath: paths.stdout,
      stderrPath: paths.stderr,
      outputFiles: paths,
      truncated: stdoutTruncated || stderrTruncated,
      stdoutTruncated,
      stderrTruncated,
      stdoutFileTruncated,
      stderrFileTruncated,
    }
  }

  remove(taskId: string): void {
    this.inMemory.delete(taskId)
    const paths = this.getPaths(taskId)
    this.safeUnlink(paths.stdout)
    this.safeUnlink(paths.stderr)
  }

  cleanup(policy: OutputCleanupPolicy = {}, protectedTaskIds: Iterable<string> = []): OutputCleanupResult {
    const retentionMs = policy.retentionMs ?? DEFAULT_RETENTION_DAYS * 24 * 60 * 60 * 1000
    const maxTotalBytes = policy.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES
    const keepRecentTasks = policy.keepRecentTasks ?? DEFAULT_KEEP_RECENT_TASKS
    const protectedIds = new Set(protectedTaskIds)
    const now = Date.now()
    const files = this.listOutputFiles()
    const taskNewest = new Map<string, number>()

    for (const file of files) {
      taskNewest.set(file.taskId, Math.max(taskNewest.get(file.taskId) ?? 0, file.mtimeMs))
    }

    const recentTaskIds = new Set(
      Array.from(taskNewest.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, keepRecentTasks)
        .map(([taskId]) => taskId),
    )

    let deletedFiles = 0
    let deletedBytes = 0
    let keptFiles = 0
    let totalBytes = files.reduce((sum, file) => sum + file.size, 0)

    const deleteFile = (file: OutputFileRecord): void => {
      if (!this.safeUnlink(file.path)) return
      deletedFiles += 1
      deletedBytes += file.size
      totalBytes -= file.size
      if (!existsSync(this.getPaths(file.taskId).stdout) && !existsSync(this.getPaths(file.taskId).stderr)) {
        this.inMemory.delete(file.taskId)
      }
    }

    for (const file of files) {
      if (protectedIds.has(file.taskId) || recentTaskIds.has(file.taskId)) {
        keptFiles += 1
        continue
      }
      if (now - file.mtimeMs > retentionMs) {
        deleteFile(file)
      }
    }

    if (totalBytes > maxTotalBytes) {
      for (const file of this.listOutputFiles().sort((a, b) => a.mtimeMs - b.mtimeMs)) {
        if (totalBytes <= maxTotalBytes) break
        if (protectedIds.has(file.taskId) || recentTaskIds.has(file.taskId)) {
          keptFiles += 1
          continue
        }
        deleteFile(file)
      }
    }

    return { deletedFiles, deletedBytes, keptFiles }
  }

  private ensureEntry(taskId: string): OutputEntry {
    const existing = this.inMemory.get(taskId)
    if (existing) return existing
    this.create(taskId)
    return this.inMemory.get(taskId)!
  }

  private appendWithinLimit(path: string, data: string, logicalBytes: number, setTruncated: (value: boolean) => void): void {
    if (logicalBytes <= this.maxOutputFileSize) {
      appendFileSync(path, data)
      return
    }

    const previousBytes = logicalBytes - Buffer.byteLength(data)
    if (previousBytes < this.maxOutputFileSize) {
      const remaining = this.maxOutputFileSize - previousBytes
      if (remaining > 0) {
        appendFileSync(path, Buffer.from(data).subarray(0, remaining))
      }
    }
    setTruncated(true)
  }

  private loadEntryFromDisk(taskId: string): OutputEntry | undefined {
    let paths: TaskOutputFiles
    try {
      paths = this.getPaths(taskId)
    } catch {
      return undefined
    }
    if (!existsSync(paths.stdout) && !existsSync(paths.stderr)) return undefined
    const stdout = this.readFileTail(paths.stdout)
    const stderr = this.readFileTail(paths.stderr)
    const entry: OutputEntry = {
      stdoutTail: stdout,
      stderrTail: stderr,
      stdoutBytes: this.sizeOf(paths.stdout),
      stderrBytes: this.sizeOf(paths.stderr),
      stdoutPath: paths.stdout,
      stderrPath: paths.stderr,
      stdoutFileTruncated: false,
      stderrFileTruncated: false,
    }
    this.inMemory.set(taskId, entry)
    return entry
  }

  private readFile(path: string): string {
    try {
      if (!this.isSafeRegularFile(path)) return ""
      return readFileSync(path, "utf8")
    } catch {
      return ""
    }
  }

  private readFileTail(path: string): string {
    const content = this.readFile(path)
    return content.length > OUTPUT_TAIL_LIMIT ? content.slice(-OUTPUT_TAIL_LIMIT) : content
  }

  private sizeOf(path: string): number {
    try {
      if (!this.isSafeRegularFile(path)) return 0
      return statSync(path).size
    } catch {
      return 0
    }
  }

  private limitReturnedText(text: string, maxBytes: number): { text: string; truncated: boolean } {
    const bytes = Buffer.byteLength(text)
    if (bytes <= maxBytes) return { text, truncated: false }
    const suffix = Buffer.from(text).subarray(bytes - maxBytes).toString("utf8")
    return { text: suffix, truncated: true }
  }

  private listOutputFiles(): OutputFileRecord[] {
    if (!existsSync(this.baseDir)) return []
    const records: OutputFileRecord[] = []
    for (const name of readdirSync(this.baseDir)) {
      const match = /^([A-Za-z0-9_-]+)\.(stdout|stderr)$/.exec(name)
      if (!match) continue
      const path = join(this.baseDir, name)
      try {
        const lst = lstatSync(path)
        if (!lst.isFile()) continue
        records.push({
          path,
          taskId: match[1],
          stream: match[2] as "stdout" | "stderr",
          size: lst.size,
          mtimeMs: lst.mtimeMs,
        })
      } catch {
        // ignore files that disappear while cleaning
      }
    }
    return records
  }

  private safeUnlink(path: string): boolean {
    try {
      if (!this.isSafeRegularFile(path)) return false
      unlinkSync(path)
      return true
    } catch {
      return false
    }
  }

  private isSafeRegularFile(path: string): boolean {
    const resolved = resolve(path)
    const rel = relative(this.baseDir, resolved)
    if (rel.startsWith("..") || rel === "" || resolve(rel) === rel) return false
    const lst = lstatSync(resolved)
    return lst.isFile()
  }
}

interface OutputFileRecord {
  path: string
  taskId: string
  stream: "stdout" | "stderr"
  size: number
  mtimeMs: number
}
