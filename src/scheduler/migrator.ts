/**
 * Migrator: imports legacy exec-task files (~/.ssh-tool/exec-tasks/*.json)
 * into the new scheduler storage layout (~/.ssh-tool/scheduler/tasks/ + outputs/).
 *
 * Idempotent: if task metadata already exists in the scheduler store, missing
 * output files are backfilled, then the old file is removed. Failed files stay
 * on disk and are retried on the next daemon start.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, rmdirSync, renameSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { log } from "../logger.js"
import type { ScheduledTask, ScheduledTaskStatus } from "./types.js"

const OUTPUT_TAIL_LIMIT = 64 * 1024
const SAFE_TASK_ID = /^[A-Za-z0-9_-]+$/

function getUserDataDir(): string {
  if (process.platform === "win32") {
    const userProfile = process.env.USERPROFILE || process.env.HOMEPATH
    if (userProfile) return userProfile
  }
  return homedir()
}

/** Legacy exec-task shape (from exec-task-manager.ts) */
interface LegacyExecTask {
  id: string
  type: string
  command: string
  status: string
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  startedAt: number
  finishedAt: number | null
  pid: number | null
  hostname: string
  createdAt: number
  updatedAt: number
  profileKey?: string
  sessionId?: string
  cwd?: string
}

export interface MigrateResult {
  migrated: number
  skipped: number
  failed: number
}

function mapStatus(legacy: string): ScheduledTaskStatus {
  switch (legacy) {
    case "running": return "stale" // orphaned running tasks become stale
    case "completed": return "completed"
    case "failed": return "failed"
    case "cancelled": return "cancelled"
    case "timeout": return "failed"
    default: return "completed"
  }
}

function atomicWrite(filePath: string, data: string): void {
  const tempPath = `${filePath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  writeFileSync(tempPath, data, { mode: 0o600 })
  renameSync(tempPath, filePath)
}

function outputStats(text: string): { bytes: number; tail: string } {
  const buf = Buffer.from(text, "utf8")
  return {
    bytes: buf.length,
    tail: buf.length > OUTPUT_TAIL_LIMIT
      ? buf.subarray(buf.length - OUTPUT_TAIL_LIMIT).toString("utf8")
      : text,
  }
}

function writeOutputIfMissing(path: string, data: string): { wrote: boolean; bytes: number; tail: string } {
  const stats = outputStats(data)
  if (!data || existsSync(path)) return { wrote: false, ...stats }
  atomicWrite(path, data)
  return { wrote: true, ...stats }
}

function buildScheduledTask(id: string, legacy: LegacyExecTask): ScheduledTask {
  const status = mapStatus(legacy.status)
  return {
    id,
    agentId: "exec-task-manager",
    hostId: legacy.hostname,
    profileKey: legacy.profileKey ?? "",
    sessionId: legacy.sessionId ?? id,
    command: legacy.command,
    effectiveCwd: legacy.cwd,
    classification: {
      intent: "custom",
      cost: "small",
      blocking: false,
      mutates: false,
      risky: false,
      source: "default",
      reason: "migrated from legacy exec-task",
    },
    scheduler: "bypass",
    status,
    startedAt: legacy.startedAt,
    finishedAt: legacy.finishedAt ?? undefined,
    updatedAt: legacy.updatedAt,
    pid: legacy.pid,
    exitCode: legacy.exitCode,
    signal: legacy.signal,
    stdoutTail: "",
    stderrTail: "",
    stdoutBytes: 0,
    stderrBytes: 0,
    decisionReason: "Migrated from legacy exec-task-manager",
  }
}

function backfillOutputMetadata(destPath: string, legacy: LegacyExecTask, stdout: ReturnType<typeof writeOutputIfMissing>, stderr: ReturnType<typeof writeOutputIfMissing>): void {
  if (!stdout.wrote && !stderr.wrote) return
  try {
    const task = JSON.parse(readFileSync(destPath, "utf8")) as Partial<ScheduledTask>
    if (stdout.wrote) {
      task.stdoutBytes = stdout.bytes
      task.stdoutTail = stdout.tail
    }
    if (stderr.wrote) {
      task.stderrBytes = stderr.bytes
      task.stderrTail = stderr.tail
    }
    task.updatedAt = legacy.updatedAt ?? task.updatedAt ?? Date.now()
    atomicWrite(destPath, JSON.stringify(task))
  } catch (err) {
    log("migrator", `Backfilled outputs but failed to refresh metadata for ${legacy.id}: ${(err as Error).message}`)
  }
}

/**
 * Migrate legacy exec-task files to the scheduler storage layout.
 *
 * @param opts - Configuration object or positional srcDir string
 */
export function migrateExecTasks(
  opts?: { srcDir?: string; destTaskDir?: string; destOutputDir?: string } | string,
  destTasksDir?: string,
  destOutputDir?: string,
): MigrateResult {
  // Support both object and positional argument styles
  let srcDir: string | undefined
  if (typeof opts === "string") {
    srcDir = opts
  } else {
    srcDir = opts?.srcDir
    destTasksDir = opts?.destTaskDir ?? destTasksDir
    destOutputDir = opts?.destOutputDir ?? destOutputDir
  }

  const src = srcDir ?? join(getUserDataDir(), ".ssh-tool", "exec-tasks")
  const destTasks = destTasksDir ?? join(getUserDataDir(), ".ssh-tool", "scheduler", "tasks")
  const destOutputs = destOutputDir ?? join(getUserDataDir(), ".ssh-tool", "scheduler", "outputs")

  const result: MigrateResult = { migrated: 0, skipped: 0, failed: 0 }

  if (!existsSync(src)) return result

  // Ensure destination dirs exist
  if (!existsSync(destTasks)) mkdirSync(destTasks, { recursive: true, mode: 0o700 })
  if (!existsSync(destOutputs)) mkdirSync(destOutputs, { recursive: true, mode: 0o700 })

  const files = readdirSync(src).filter((f) => f.endsWith(".json"))

  for (const file of files) {
    const srcPath = join(src, file)
    try {
      const content = readFileSync(srcPath, "utf8")
      const legacy = JSON.parse(content) as LegacyExecTask
      const taskId = file.replace(/\.json$/, "")

      if (!SAFE_TASK_ID.test(taskId) || legacy.id !== taskId) {
        throw new Error("unsafe or mismatched task id")
      }

      // Skip if already migrated (same id exists in dest)
      const destPath = join(destTasks, `${taskId}.json`)
      const stdoutPath = join(destOutputs, `${taskId}.stdout`)
      const stderrPath = join(destOutputs, `${taskId}.stderr`)
      if (existsSync(destPath)) {
        const stdout = writeOutputIfMissing(stdoutPath, legacy.stdout ?? "")
        const stderr = writeOutputIfMissing(stderrPath, legacy.stderr ?? "")
        backfillOutputMetadata(destPath, legacy, stdout, stderr)
        result.skipped++
        // Still clean up the source file since dest already has it
        try { unlinkSync(srcPath) } catch {}
        continue
      }

      // Convert to ScheduledTask
      const status = mapStatus(legacy.status)
      const scheduledTask = buildScheduledTask(taskId, legacy)

      // Write task file
      atomicWrite(destPath, JSON.stringify(scheduledTask))

      // Write output files if there's content
      if (legacy.stdout) {
        const stdout = writeOutputIfMissing(stdoutPath, legacy.stdout)
        scheduledTask.stdoutBytes = stdout.bytes
        scheduledTask.stdoutTail = stdout.tail
      }
      if (legacy.stderr) {
        const stderr = writeOutputIfMissing(stderrPath, legacy.stderr)
        scheduledTask.stderrBytes = stderr.bytes
        scheduledTask.stderrTail = stderr.tail
      }

      // Re-write task with updated byte counts
      if (legacy.stdout || legacy.stderr) {
        atomicWrite(destPath, JSON.stringify(scheduledTask))
      }

      // Delete source file
      try { unlinkSync(srcPath) } catch {}

      result.migrated++
      log("migrator", `Migrated legacy task ${taskId} (${legacy.status} → ${status})`)
    } catch (err) {
      result.failed++
      log("migrator", `Failed to migrate ${file}: ${(err as Error).message}`)
    }
  }

  // Clean up empty source directory
  try {
    const remaining = readdirSync(src)
    if (remaining.length === 0) {
      rmdirSync(src)
    }
  } catch {}

  if (result.migrated > 0 || result.failed > 0) {
    log("migrator", `Migration complete: ${result.migrated} migrated, ${result.skipped} skipped, ${result.failed} failed`)
  }

  return result
}
