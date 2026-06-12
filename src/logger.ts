/**
 * Debug Logger - verbose logging for troubleshooting
 *
 * Each debug session gets its own log file: <skill-root>/logs/debug-<ip>-<timestamp>.log
 * On error, the log path is printed so you can share it with AI for troubleshooting.
 *
 * Performance: log() calls are buffered in memory and flushed in batches
 * via a 100ms debounce. This avoids a sync fs.appendFileSync() per call,
 * which is a measurable cost on hot paths (scheduler pump queue, IPC
 * parser, etc.). The buffer is also flushed on a `flushLogs()` signal
 * (called from process.on('beforeExit') / on daemon shutdown) and on
 * errors (so a crashed background task still leaves a complete log).
 */

import { appendFileSync, writeFileSync, existsSync, mkdirSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const LOGS_DIR = join(__dirname, "..", "logs")
let logPath = ""
let debugEnabled = false

/** In-memory write buffer; flushed every FLUSH_INTERVAL_MS. */
let buffer: string[] = []
/** 100ms debounce: many log() calls collapse into a single appendFileSync. */
const FLUSH_INTERVAL_MS = 100
let flushTimer: NodeJS.Timeout | null = null
/** Hard cap on buffer size — flush eagerly if we hit this. */
const MAX_BUFFER_LINES = 200

function timestamp(): string {
  const d = new Date()
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
    "-",
    String(d.getHours()).padStart(2, "0"),
    String(d.getMinutes()).padStart(2, "0"),
    String(d.getSeconds()).padStart(2, "0"),
  ].join("")
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 40)
}

function flushNow(): void {
  if (buffer.length === 0) return
  const chunk = buffer.join("")
  buffer = []
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  try {
    appendFileSync(logPath, chunk, "utf-8")
  } catch {
    // can't write log, ignore
  }
}

function scheduleFlush(): void {
  // Hard cap: flush eagerly so we don't lose the last 200 lines if the
  // process is killed before the debounce timer fires.
  if (buffer.length >= MAX_BUFFER_LINES) {
    flushNow()
    return
  }
  // A flush is already scheduled — let it run.
  if (flushTimer) return
  flushTimer = setTimeout(flushNow, FLUSH_INTERVAL_MS)
}

/**
 * Public hook so the daemon can force a flush on graceful shutdown
 * — otherwise the last 100ms of log lines would be lost.
 */
export function flushLogs(): void {
  flushNow()
}

/**
 * Enable debug logging.
 * @param context - { host, command, label } for filename context
 *   - CLI mode: pass host + command → debug-192.168.1.100-echo_hello-20260521-021557.log
 *   - Daemon mode: pass label="daemon" → debug-daemon-20260521-021557.log (all sessions share this file)
 */
export function enableDebug(context?: { host?: string; command?: string; label?: string }): void {
  debugEnabled = true
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true })

  const parts = ["debug"]
  if (context?.label) parts.push(sanitize(context.label))
  else if (context?.host) parts.push(sanitize(context.host))
  if (context?.command) parts.push(sanitize(context.command.slice(0, 30)))
  parts.push(timestamp())

  logPath = join(LOGS_DIR, `${parts.join("-")}.log`)
  writeFileSync(logPath, "", "utf-8")
  // These three bootstrap lines need to be visible immediately
  // (operators check the file right after enabling debug), so flush
  // synchronously here.
  log("init", `Session started at ${new Date().toISOString()}`)
  log("init", `Platform: ${process.platform} ${process.arch} Node ${process.version}`)
  log("init", `Log file: ${logPath}`)
  flushNow()
}

export function isDebug(): boolean {
  return debugEnabled
}

export function log(category: string, message: string, data?: unknown): void {
  if (!debugEnabled) return
  const ts = new Date().toISOString().slice(11, 23)
  let line = `[${ts}] [${category}] ${message}`
  if (data !== undefined) {
    try {
      line += ` ${JSON.stringify(data)}`
    } catch {
      line += ` [unserializable]`
    }
  }
  buffer.push(line + "\n")
  scheduleFlush()
}

export function logError(category: string, context: string, err: Error): void {
  log(category, `ERROR ${context}: ${err.message}`)
  if (err.stack) {
    log(category, `  Stack: ${err.stack.split("\n").slice(1, 4).join(" <- ")}`)
  }
}

export function printErrorAndLogPath(message: string): void {
  console.error(`[ssh-exec] 错误: ${message}`)
  if (debugEnabled) {
    flushLogs()
    console.error(`[ssh-exec] 日志已保存到: ${logPath}`)
    console.error(`[ssh-exec] 把日志内容发给 AI 可以帮你排查问题`)
  }
}

export function getLogPath(): string {
  return logPath
}
