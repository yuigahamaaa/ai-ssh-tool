import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import {
  _resetPathsForTest,
  getDaemonPidPathCandidates,
  getDaemonSocketPath,
  getDaemonSocketPathCandidates,
  getLegacyDaemonPidPath,
  getLegacyDaemonSocketPath,
  getSchedulerDir,
} from "../paths.js"

describe("cross-platform path management", () => {
  it("keeps platform data paths overridable and uses the data dir as legacy cache fallback", () => {
    const originalDataDir = process.env.SSH_TOOL_DATA_DIR
    const originalCacheDir = process.env.SSH_TOOL_CACHE_DIR
    const originalSocketDir = process.env.SSH_TOOL_SOCKET_DIR
    try {
      process.env.SSH_TOOL_DATA_DIR = "relative-data"
      delete process.env.SSH_TOOL_CACHE_DIR
      delete process.env.SSH_TOOL_SOCKET_DIR
      _resetPathsForTest()

      assert.equal(getSchedulerDir(), join(resolve("relative-data"), "scheduler"))
      assert.equal(getDaemonSocketPath(), join(resolve("relative-data"), "daemon.sock"))

      process.env.SSH_TOOL_CACHE_DIR = "relative-cache"
      _resetPathsForTest()
      assert.equal(getDaemonSocketPath(), join(resolve("relative-cache"), "daemon.sock"))
    } finally {
      if (originalDataDir === undefined) delete process.env.SSH_TOOL_DATA_DIR
      else process.env.SSH_TOOL_DATA_DIR = originalDataDir
      if (originalCacheDir === undefined) delete process.env.SSH_TOOL_CACHE_DIR
      else process.env.SSH_TOOL_CACHE_DIR = originalCacheDir
      if (originalSocketDir === undefined) delete process.env.SSH_TOOL_SOCKET_DIR
      else process.env.SSH_TOOL_SOCKET_DIR = originalSocketDir
      _resetPathsForTest()
    }
  })

  it("exposes legacy daemon IPC candidates after the platform-preferred path", () => {
    const originalSocketDir = process.env.SSH_TOOL_SOCKET_DIR
    try {
      process.env.SSH_TOOL_SOCKET_DIR = "relative-socket"
      _resetPathsForTest()

      const socketCandidates = getDaemonSocketPathCandidates()
      const pidCandidates = getDaemonPidPathCandidates()

      assert.equal(socketCandidates[0], join(resolve("relative-socket"), "daemon.sock"))
      assert.equal(pidCandidates[0], join(resolve("relative-socket"), "daemon.pid"))
      assert.equal(socketCandidates.at(-1), getLegacyDaemonSocketPath())
      assert.equal(pidCandidates.at(-1), getLegacyDaemonPidPath())
      assert.equal(getLegacyDaemonSocketPath(), join(homedir(), ".ssh-exec-daemon.sock"))
      assert.equal(getLegacyDaemonPidPath(), join(homedir(), ".ssh-exec-daemon.pid"))
      assert.deepEqual(new Set(socketCandidates).size, socketCandidates.length)
      assert.deepEqual(new Set(pidCandidates).size, pidCandidates.length)
    } finally {
      if (originalSocketDir === undefined) delete process.env.SSH_TOOL_SOCKET_DIR
      else process.env.SSH_TOOL_SOCKET_DIR = originalSocketDir
      _resetPathsForTest()
    }
  })

  it("uses a per-data-dir Windows pipe while retaining the old global pipe candidate", () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")
    const originalDataDir = process.env.SSH_TOOL_DATA_DIR
    const originalSocketDir = process.env.SSH_TOOL_SOCKET_DIR
    try {
      Object.defineProperty(process, "platform", { value: "win32" })
      process.env.SSH_TOOL_DATA_DIR = "C:\\Users\\alice\\AppData\\Local\\ssh-tool"
      delete process.env.SSH_TOOL_SOCKET_DIR
      _resetPathsForTest()

      const first = getDaemonSocketPath()
      process.env.SSH_TOOL_DATA_DIR = "C:\\Users\\bob\\AppData\\Local\\ssh-tool"
      _resetPathsForTest()
      const second = getDaemonSocketPath()

      assert.match(first, /^\\\\\.\\pipe\\ssh-exec-daemon-[a-f0-9]{12}$/)
      assert.match(second, /^\\\\\.\\pipe\\ssh-exec-daemon-[a-f0-9]{12}$/)
      assert.notEqual(first, second)
      assert.equal(getDaemonSocketPathCandidates().at(-1), "\\\\.\\pipe\\ssh-exec-daemon")
    } finally {
      if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform)
      if (originalDataDir === undefined) delete process.env.SSH_TOOL_DATA_DIR
      else process.env.SSH_TOOL_DATA_DIR = originalDataDir
      if (originalSocketDir === undefined) delete process.env.SSH_TOOL_SOCKET_DIR
      else process.env.SSH_TOOL_SOCKET_DIR = originalSocketDir
      _resetPathsForTest()
    }
  })
})
