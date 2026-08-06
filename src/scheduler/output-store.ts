import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  lstatSync,
  mkdirSync,
  readSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "fs"
import { join, relative, resolve } from "path"
import type { TaskOutputFiles, TaskOutputResult } from "./types.js"
import { getSchedulerOutputsDir } from "../paths.js"
import { log } from "../logger.js"

export const OUTPUT_TAIL_LIMIT = 64 * 1024
export const DEFAULT_OUTPUT_RETURN_LIMIT = 16 * 1024
const DEFAULT_MAX_OUTPUT_FILE_SIZE = 50 * 1024 * 1024
const DEFAULT_RETENTION_DAYS = 7
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024
const DEFAULT_KEEP_RECENT_TASKS = 200

export interface OutputEntry {
  /** Last OUTPUT_TAIL_LIMIT bytes of stdout, used for fast tail queries. */
  stdoutTail: Buffer
  /** Last OUTPUT_TAIL_LIMIT bytes of stderr. */
  stderrTail: Buffer
  /** True logical byte count of stdout (file = tail after truncation). */
  stdoutBytes: number
  /** True logical byte count of stderr. */
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

/**
 * Per-task queued output awaiting a coalesced disk flush. The flush timer
 * batches all appends within `flushIntervalMs` into a single write so a
 * chatty task does not burn one syscall per chunk.
 */
interface PendingWrites {
  stdoutQueue: string[]
  stderrQueue: string[]
  flushTimer: NodeJS.Timeout | null
}

function safeTaskId(taskId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(taskId)) {
    throw new Error(`Invalid task id for output path: ${taskId}`)
  }
  return taskId
}

function appendTail(current: Buffer, data: string | Buffer): Buffer {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data
  if (buf.length === 0) return current
  const next = current.length === 0 ? buf : Buffer.concat([current, buf])
  if (next.length <= OUTPUT_TAIL_LIMIT) return next
  return next.subarray(next.length - OUTPUT_TAIL_LIMIT)
}

/**
 * Decode a Buffer to UTF-8 string. The tail is sliced at a byte boundary,
 * so the last few bytes may be an incomplete UTF-8 sequence when the
 * producing process emitted a partial code point; Buffer.toString replaces
 * these with U+FFFD rather than throwing, which is the same behaviour
 * callers used to get from the old string-based path.
 */
function bufferToString(buf: Buffer): string {
  return buf.toString("utf8")
}

export class OutputStore {
  private baseDir: string
  private maxOutputFileSize: number
  private flushIntervalMs: number
  private inMemory = new Map<string, OutputEntry>()
  private pending = new Map<string, PendingWrites>()

  constructor(baseDir?: string, opts?: { maxOutputFileSize?: number; flushIntervalMs?: number }) {
    this.baseDir = resolve(baseDir ?? getSchedulerOutputsDir())
    this.maxOutputFileSize = opts?.maxOutputFileSize ?? DEFAULT_MAX_OUTPUT_FILE_SIZE
    this.flushIntervalMs = opts?.flushIntervalMs ?? 100
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
    // Register the in-memory entry only. The actual on-disk stdout/stderr
    // files are created lazily on the first append*() call. Tasks that
    // produce no output (common for `--command` that just exits cleanly
    // with code 0) used to create two empty files for nothing; lazy
    // creation skips that work and shrinks cleanup/retention churn.
    const paths = this.getPaths(taskId)
    this.inMemory.set(taskId, {
      stdoutTail: Buffer.alloc(0),
      stderrTail: Buffer.alloc(0),
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutPath: paths.stdout,
      stderrPath: paths.stderr,
      stdoutFileTruncated: false,
      stderrFileTruncated: false,
    })
  }

  appendStdout(taskId: string, data: string): void {
    const entry = this.ensureEntry(taskId)
    entry.stdoutTail = appendTail(entry.stdoutTail, data)
    entry.stdoutBytes += Buffer.byteLength(data)
    this.enqueue(taskId, "stdout", data)
  }

  appendStderr(taskId: string, data: string): void {
    const entry = this.ensureEntry(taskId)
    entry.stderrTail = appendTail(entry.stderrTail, data)
    entry.stderrBytes += Buffer.byteLength(data)
    this.enqueue(taskId, "stderr", data)
  }

  /** Immediately persist pending output for one task. Idempotent. */
  flush(taskId: string): void {
    const p = this.pending.get(taskId)
    if (!p) return
    this.pending.delete(taskId)
    if (p.flushTimer) { clearTimeout(p.flushTimer); p.flushTimer = null }
    const paths = this.getPaths(taskId)
    this.flushQueue(paths.stdout, p.stdoutQueue)
    this.flushQueue(paths.stderr, p.stderrQueue)
  }

  /** Persist all pending output (call from shutdown/cleanup paths). */
  flushAll(): void {
    for (const taskId of Array.from(this.pending.keys())) {
      this.flush(taskId)
    }
  }

  /**
   * Write one queued buffer to disk, respecting maxOutputFileSize. Appends in
   * 'a' mode so the first write also creates the file (matching the previous
   * lazy-create behaviour); a full file silently drops further bytes.
   */
  private flushQueue(path: string, queue: string[]): void {
    if (queue.length === 0) return
    const buf = Buffer.concat(queue.map((d) => Buffer.from(d, "utf8")))
    const cap = this.maxOutputFileSize
    const existing = existsSync(path) ? statSync(path).size : 0
    const remaining = cap - existing
    if (remaining <= 0) return
    try {
      appendFileSync(path, buf.subarray(0, remaining), { mode: 0o600 })
    } catch (err) {
      log("scheduler", `Output flush failed for ${path}: ${(err as Error).message}`)
    }
  }

  /** Queue data and arm the coalescing timer for this task. */
  private enqueue(taskId: string, stream: "stdout" | "stderr", data: string): void {
    let p = this.pending.get(taskId)
    if (!p) {
      p = { stdoutQueue: [], stderrQueue: [], flushTimer: null }
      this.pending.set(taskId, p)
    }
    const queue = stream === "stdout" ? p.stdoutQueue : p.stderrQueue
    queue.push(data)
    if (!p.flushTimer) {
      p.flushTimer = setTimeout(() => {
        p.flushTimer = null
        this.flush(taskId)
      }, this.flushIntervalMs)
      if (typeof (p.flushTimer as any).unref === "function") (p.flushTimer as any).unref()
    }
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
    // Use the in-memory entry's byte counters when available to avoid
    // redundant statSync() calls. Fall back to disk only if the entry is
    // missing (e.g. daemon restart with no in-memory state).
    const stdoutBytes = entry?.stdoutBytes ?? this.sizeOf(paths.stdout)
    const stderrBytes = entry?.stderrBytes ?? this.sizeOf(paths.stderr)
    const stdoutFileTruncated = (entry?.stdoutFileTruncated ?? false) || (stdoutBytes > this.maxOutputFileSize)
    const stderrFileTruncated = (entry?.stderrFileTruncated ?? false) || (stderrBytes > this.maxOutputFileSize)

    if (mode === "full") {
      // A full read must include bytes still sitting in the coalescing queue.
      this.flush(taskId)
    }
    let stdout = mode === "full"
      ? this.getFullStdout(taskId)
      : (entry ? bufferToString(entry.stdoutTail) : this.readFileTail(paths.stdout, returnLimit))
    let stderr = mode === "full"
      ? this.getFullStderr(taskId)
      : (entry ? bufferToString(entry.stderrTail) : this.readFileTail(paths.stderr, returnLimit))
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
    this.flush(taskId)
    this.inMemory.delete(taskId)
    const paths = this.getPaths(taskId)
    this.safeUnlink(paths.stdout)
    this.safeUnlink(paths.stderr)
  }

  cleanup(policy: OutputCleanupPolicy = {}, protectedTaskIds: Iterable<string> = []): OutputCleanupResult {
    // Persist everything first so retention decisions see the real file sizes
    // and so unflushed output is not stranded after files are deleted.
    this.flushAll()
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

    const deleted = new Set<string>()

    const deleteFile = (file: OutputFileRecord): void => {
      if (!this.safeUnlink(file.path)) return
      deleted.add(file.path)
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
      const remaining = files.filter((f) => !deleted.has(f.path))
      remaining.sort((a, b) => a.mtimeMs - b.mtimeMs)
      for (const file of remaining) {
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

  private loadEntryFromDisk(taskId: string): OutputEntry | undefined {
    let paths: TaskOutputFiles
    try {
      paths = this.getPaths(taskId)
    } catch {
      return undefined
    }
    if (!existsSync(paths.stdout) && !existsSync(paths.stderr)) return undefined
    const stdout = this.readFileTailBuffer(paths.stdout)
    const stderr = this.readFileTailBuffer(paths.stderr)
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

  private readFileTail(path: string, maxBytes = OUTPUT_TAIL_LIMIT): string {
    return this.readFileTailBuffer(path, maxBytes).toString("utf8")
  }

  private readFileTailBuffer(path: string, maxBytes = OUTPUT_TAIL_LIMIT): Buffer {
    try {
      if (!this.isSafeRegularFile(path)) return Buffer.alloc(0)
      const size = statSync(path).size
      if (size === 0) return Buffer.alloc(0)
      const bytesToRead = Math.min(size, maxBytes)
      const buffer = Buffer.allocUnsafe(bytesToRead)
      const fd = openSync(path, "r")
      try {
        readSync(fd, buffer, 0, bytesToRead, size - bytesToRead)
      } finally {
        closeSync(fd)
      }
      return buffer
    } catch {
      return Buffer.alloc(0)
    }
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
