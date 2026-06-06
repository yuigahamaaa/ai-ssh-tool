import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "child_process"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { DaemonClient } from "../daemon-client.js"

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitForPing(pipePath: string, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const client = new DaemonClient(pipePath)
    try {
      await client.connect()
      const resp = await client.ping()
      client.disconnect()
      if (resp.ok) return true
    } catch {
      client.disconnect()
    }
    await wait(100)
  }
  return false
}

describe("Daemon replacement recovery", () => {
  it("fatal daemon exits and replacement serves the same pipe", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "daemon-replacement-"))
    const pipePath = process.platform === "win32"
      ? `\\\\.\\pipe\\ssh-daemon-replacement-${Date.now()}`
      : join(tmpDir, "daemon.sock")

    const child = spawn(process.execPath, [
      "dist/daemon.js",
      "--pipe", pipePath,
      "--idle-timeout", "60",
      "--test-fatal-after-start", "200",
    ], {
      cwd: process.cwd(),
      env: { ...process.env, SSH_TOOL_DAEMON_RESTART_COUNT: "0", SSH_TOOL_ENABLE_TEST_HOOKS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", data => { stdout += data.toString() })
    child.stderr?.on("data", data => { stderr += data.toString() })

    try {
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`daemon did not exit after fatal trigger\nstdout=${stdout}\nstderr=${stderr}`)), 8000)
        child.once("exit", (code, signal) => {
          clearTimeout(timer)
          resolve({ code, signal })
        })
      })

      assert.equal(exit.code, 1)
      assert.equal(exit.signal, null)

      const replacementReady = await waitForPing(pipePath)
      assert.equal(replacementReady, true, `replacement did not respond on ${pipePath}\nstdout=${stdout}\nstderr=${stderr}`)

      const client = new DaemonClient(pipePath)
      await client.connect()
      const shutdown = await client.shutdown()
      assert.equal(shutdown.ok, true)
      client.disconnect()
    } finally {
      if (!child.killed) child.kill("SIGTERM")
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("does not spawn replacement after restart limit", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "daemon-no-replacement-"))
    const pipePath = process.platform === "win32"
      ? `\\\\.\\pipe\\ssh-daemon-no-replacement-${Date.now()}`
      : join(tmpDir, "daemon.sock")

    const child = spawn(process.execPath, [
      "dist/daemon.js",
      "--pipe", pipePath,
      "--idle-timeout", "60",
      "--test-fatal-after-start", "200",
    ], {
      cwd: process.cwd(),
      env: { ...process.env, SSH_TOOL_DAEMON_RESTART_COUNT: "3", SSH_TOOL_ENABLE_TEST_HOOKS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    })

    try {
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("daemon did not exit after restart-limit fatal trigger")), 8000)
        child.once("exit", (code, signal) => {
          clearTimeout(timer)
          resolve({ code, signal })
        })
      })

      assert.equal(exit.code, 1)
      const replacementReady = await waitForPing(pipePath, 1200)
      assert.equal(replacementReady, false)
    } finally {
      if (!child.killed) child.kill("SIGTERM")
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
