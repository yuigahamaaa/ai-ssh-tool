/**
 * Cross-platform path management for ssh-tool.
 *
 * Follows platform conventions:
 *   Windows  - %LOCALAPPDATA%\ssh-tool  (fallback: ~/AppData/Local/ssh-tool)
 *   macOS    - ~/Library/Application Support/ssh-tool
 *   Linux    - $XDG_DATA_HOME/ssh-tool  (fallback: ~/.local/share/ssh-tool)
 *
 * Every path can be overridden via SSH_TOOL_DATA_DIR (or SSH_TOOL_SOCKET_DIR
 * for the daemon socket/pid).  Legacy ~/.ssh-tool paths are kept as fallback
 * candidates for backward-compatible reads.
 */

import { existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

const APP_NAME = "ssh-tool"

function platformDataDir(): string {
  const home = homedir()
  switch (process.platform) {
    case "win32": {
      const localAppData = process.env.LOCALAPPDATA || process.env.APPDATA
      if (localAppData) return join(localAppData, APP_NAME)
      return join(home, "AppData", "Local", APP_NAME)
    }
    case "darwin":
      return join(home, "Library", "Application Support", APP_NAME)
    default: {
      const xdgData = process.env.XDG_DATA_HOME
      if (xdgData) return join(xdgData, APP_NAME)
      return join(home, ".local", "share", APP_NAME)
    }
  }
}

function platformCacheDir(): string {
  const home = homedir()
  switch (process.platform) {
    case "win32": {
      const localAppData = process.env.LOCALAPPDATA || process.env.APPDATA
      if (localAppData) return join(localAppData, APP_NAME)
      return join(home, "AppData", "Local", APP_NAME)
    }
    case "darwin":
      return join(home, "Library", "Caches", APP_NAME)
    default: {
      const xdgCache = process.env.XDG_CACHE_HOME
      if (xdgCache) return join(xdgCache, APP_NAME)
      return join(home, ".cache", APP_NAME)
    }
  }
}

let _dataDir: string | undefined
let _cacheDir: string | undefined

export function getDataDir(): string {
  if (!_dataDir) {
    const override = process.env.SSH_TOOL_DATA_DIR
    _dataDir = override ? resolve(override) : platformDataDir()
  }
  return _dataDir
}

export function getCacheDir(): string {
  if (!_cacheDir) {
    const override = process.env.SSH_TOOL_DATA_DIR
    _cacheDir = override ? resolve(override) : platformCacheDir()
  }
  return _cacheDir
}

export function getProfilesDir(): string {
  return join(getDataDir(), "profiles")
}

export function getSchedulerDir(): string {
  return join(getDataDir(), "scheduler")
}

export function getExecTasksDir(): string {
  return join(getDataDir(), "exec-tasks")
}

export function getSchedulerTasksDir(): string {
  return join(getSchedulerDir(), "tasks")
}

export function getSchedulerOutputsDir(): string {
  return join(getSchedulerDir(), "outputs")
}

export function getSchedulerEventsDir(): string {
  return join(getSchedulerDir(), "events")
}

export function getSchedulerStateDir(): string {
  return join(getSchedulerDir(), "state")
}

export function getDaemonSocketPath(): string {
  if (process.platform === "win32") return "\\\\.\\pipe\\ssh-exec-daemon"
  const override = process.env.SSH_TOOL_SOCKET_DIR
  const dir = override ? resolve(override) : getCacheDir()
  return join(dir, "daemon.sock")
}

export function getDaemonPidPath(): string {
  if (process.platform === "win32") return join(getCacheDir(), "daemon.pid")
  const override = process.env.SSH_TOOL_SOCKET_DIR
  const dir = override ? resolve(override) : getCacheDir()
  return join(dir, "daemon.pid")
}

export function getLegacyDataDir(): string {
  return join(homedir(), ".ssh-tool")
}

export function getLegacyProfilesDir(): string {
  return join(homedir(), ".opencode", "ssh")
}

export function getLegacyExecTasksDir(): string {
  return join(getLegacyDataDir(), "exec-tasks")
}

export function getLegacySchedulerDir(): string {
  return join(getLegacyDataDir(), "scheduler")
}

export function ensureDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true, mode: 0o700 })
  }
}

export function resolveOrCreate(
  primary: string,
  ...legacyCandidates: string[]
): string {
  if (existsSync(primary)) return primary
  for (const candidate of legacyCandidates) {
    if (existsSync(candidate)) return candidate
  }
  ensureDir(primary)
  return primary
}

export function _resetPathsForTest(): void {
  _dataDir = undefined
  _cacheDir = undefined
}
