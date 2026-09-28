#!/usr/bin/env node

/**
 * Run a test command against disposable ssh-tool state.
 *
 * Every test process gets its own data, cache and Unix socket roots before
 * Node imports any ssh-tool module. This prevents SchedulerService startup
 * cleanup from touching a developer's real task/output/event history.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawn } from "node:child_process"

const args = process.argv.slice(2)
if (args[0] === "--") args.shift()
if (args.length === 0) {
  console.error("Usage: run-tests-isolated.mjs <command> [args...]")
  process.exit(2)
}

const root = mkdtempSync(join(tmpdir(), "ssh-tool-test-"))
const env = {
  ...process.env,
  SSH_TOOL_DATA_DIR: resolve(root, "data"),
  SSH_TOOL_CACHE_DIR: resolve(root, "cache"),
  SSH_TOOL_SOCKET_DIR: resolve(root, "socket"),
}

const child = spawn(args[0], args.slice(1), { stdio: "inherit", env })
const forwardSignal = (signal) => {
  try { child.kill(signal) } catch {}
}
process.once("SIGINT", () => forwardSignal("SIGINT"))
process.once("SIGTERM", () => forwardSignal("SIGTERM"))

child.once("error", (error) => {
  console.error(`[isolated-tests] failed to start ${args[0]}: ${error.message}`)
  rmSync(root, { recursive: true, force: true })
  process.exit(1)
})
child.once("exit", (code, signal) => {
  rmSync(root, { recursive: true, force: true })
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})
