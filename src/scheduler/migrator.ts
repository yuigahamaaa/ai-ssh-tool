/**
 * P1-3 Stage 2 / Task 2.2: migrator for old `~/.ssh-tool/exec-tasks/`
 * JSON files into the new scheduler layout.
 *
 * The migrator runs once at daemon startup. It is idempotent: it
 * compares the mtime of each old file to the mtime of the corresponding
 * new task file and re-migrates only when the old file is newer (which
 * happens when an in-flight task wrote to the old store after the
 * daemon started but before this pass).
 *
 * Failures are non-fatal: a corrupt or unparseable file is left on disk
 * and counted in `result.failed`. The daemon still boots.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs"
import { join } from "path"

const OUTPUT_TAIL_LIMIT = 64 * 1024

export interface MigrateOptions {
  srcDir: string
  destTaskDir: string
  destOutputDir: string
}

export interface MigrateResult {
  migrated: number
  skipped: number
  failed: number
  errors: { file: string; reason: string }[]
}

/** Shape of the old on-disk format (subset — only what the migrator reads). */
interface OldExecTask {
  id: string
  type?: string
  command?: string
  status?: string
  exitCode?: number | null
  signal?: string | null
  stdout?: string
  stderr?: string
  startedAt?: number
  finishedAt?: number | null
  pid?: number | null
  hostname?: string
  createdAt?: number
  updatedAt?: number
  profileKey?: string
  sessionId?: string
  cwd?: string
}

/**
 * Truncate the head of a long output to the last OUTPUT_TAIL_LIMIT bytes
 * (UTF-8 byte boundary). OutputStore does the same thing on its in-memory
 * tail; this keeps the on-disk new task JSON in sync.
 */
function tailBuffer(s: string, limit: number): { tail: string; bytes: number } {
  if (s.length === 0) return { tail: "", bytes: 0 }
  const buf = Buffer.from(s, "utf8")
  if (buf.length <= limit) return { tail: s, bytes: buf.length }
  // subarray keeps bytes; toString re-decodes and may emit U+FFFD for
  // truncated code points, which is the same tolerance OutputStore offers.
  return { tail: buf.subarray(buf.length - limit).toString("utf8"), bytes: buf.length }
}

function safeTaskId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id)
}

export function migrateExecTasks(opts: MigrateOptions): MigrateResult {
  const result: MigrateResult = { migrated: 0, skipped: 0, failed: 0, errors: [] }

  if (!existsSync(opts.srcDir)) return result

  if (!existsSync(opts.destTaskDir)) {
    mkdirSync(opts.destTaskDir, { recursive: true, mode: 0o700 })
  }
  if (!existsSync(opts.destOutputDir)) {
    mkdirSync(opts.destOutputDir, { recursive: true, mode: 0o700 })
  }

  const files = readdirSync(opts.srcDir).filter((f) => f.endsWith(".json"))
  for (const file of files) {
    const oldPath = join(opts.srcDir, file)
    const taskId = file.replace(/\.json$/, "")

    if (!safeTaskId(taskId)) {
      result.failed += 1
      result.errors.push({ file, reason: "unsafe task id (must match /^[A-Za-z0-9_-]+$/)" })
      continue
    }

    const newTaskPath = join(opts.destTaskDir, file)
    const stdoutPath = join(opts.destOutputDir, `${taskId}.stdout`)
    const stderrPath = join(opts.destOutputDir, `${taskId}.stderr`)

    // Idempotency: if new file is newer than old, skip.
    try {
      if (existsSync(newTaskPath)) {
        const oldStat = statSync(oldPath)
        const newStat = statSync(newTaskPath)
        if (newStat.mtimeMs >= oldStat.mtimeMs) {
          result.skipped += 1
          continue
        }
      }
    } catch {
      // stat failure: proceed to full re-migration, will surface any read errors below
    }

    try {
      const raw = readFileSync(oldPath, "utf-8")
      const old = JSON.parse(raw) as OldExecTask
      const stdout = old.stdout ?? ""
      const stderr = old.stderr ?? ""
      const stdoutTail = tailBuffer(stdout, OUTPUT_TAIL_LIMIT)
      const stderrTail = tailBuffer(stderr, OUTPUT_TAIL_LIMIT)

      // Write full stdout/stderr to outputs dir. Atomic via temp+rename.
      const tmpStdout = `${stdoutPath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const tmpStderr = `${stderrPath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      try {
        writeFileSync(tmpStdout, stdout, { mode: 0o600 })
        renameSync(tmpStdout, stdoutPath)
        writeFileSync(tmpStderr, stderr, { mode: 0o600 })
        renameSync(tmpStderr, stderrPath)
      } catch (err) {
        try { unlinkSync(tmpStdout) } catch {}
        try { unlinkSync(tmpStderr) } catch {}
        throw err
      }

      // Build new task JSON (ScheduledTask-shaped) without embedded stdout/stderr
      const newTask = {
        id: old.id ?? taskId,
        agentId: "migrated",
        agentName: "migrated",
        hostId: old.hostname ?? "unknown",
        profileKey: old.profileKey,
        sessionId: old.sessionId,
        command: old.command ?? "",
        effectiveCwd: old.cwd,
        reason: "migrated from ~/.ssh-tool/exec-tasks/",
        classification: {
          cost: "small" as const,
          mutates: false,
          blocking: true,
          risky: false,
          script: false,
          intent: "exec" as const,
          confidence: 1.0,
          reason: "migrated",
        },
        scheduler: "bypass" as const,
        status: "completed" as const,
        updatedAt: old.updatedAt ?? old.finishedAt ?? Date.now(),
        startedAt: old.startedAt ?? Date.now(),
        finishedAt: old.finishedAt ?? Date.now(),
        exitCode: old.exitCode ?? 0,
        signal: old.signal ?? null,
        stdoutTail: stdoutTail.tail,
        stderrTail: stderrTail.tail,
        stdoutBytes: stdoutTail.bytes,
        stderrBytes: stderrTail.bytes,
      }

      const tmpTask = `${newTaskPath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      writeFileSync(tmpTask, JSON.stringify(newTask), { mode: 0o600 })
      renameSync(tmpTask, newTaskPath)

      result.migrated += 1
    } catch (err) {
      result.failed += 1
      result.errors.push({ file, reason: (err as Error).message })
    }
  }

  return result
}
