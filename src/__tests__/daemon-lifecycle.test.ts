/**
 * Daemon Lifecycle Tests
 * Tests daemon IPC server, ping, session listing, and shutdown
 * Uses a custom pipe path to avoid conflicts with running daemons
 */

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { SSHDaemon } from "../daemon.js"
import { DaemonClient } from "../daemon-client.js"

describe("SSHDaemon", () => {
  let tmpDir: string
  let pipePath: string
  let daemon: SSHDaemon

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "daemon-test-"))
    pipePath = process.platform === "win32"
      ? `\\\\.\\pipe\\ssh-daemon-test-${Date.now()}`
      : join(tmpDir, "daemon.sock")
  })

  afterEach(async () => {
    if (daemon) {
      await daemon.shutdown().catch(() => {})
    }
    rmSync(tmpDir, { recursive: true, force: true })
  })

  describe("ping", () => {
    it("should respond to ping with uptime and session count", async () => {
      daemon = new SSHDaemon({ pipePath, idleTimeoutMs: 60000 })
      await daemon.start()

      const client = new DaemonClient(pipePath)
      await client.connect()

      const resp = await client.ping()
      assert.equal(resp.ok, true)
      const data = resp.data as any
      assert.ok(typeof data.uptime === "number")
      assert.equal(data.sessionCount, 0)

      client.disconnect()
    })
  })

  describe("list sessions", () => {
    it("should return empty list initially", async () => {
      daemon = new SSHDaemon({ pipePath, idleTimeoutMs: 60000 })
      await daemon.start()

      const client = new DaemonClient(pipePath)
      await client.connect()

      const resp = await client.list()
      assert.equal(resp.ok, true)
      assert.deepEqual(resp.data, [])

      client.disconnect()
    })
  })

  describe("connect", () => {
    it("should fail with invalid config path", async () => {
      daemon = new SSHDaemon({ pipePath, idleTimeoutMs: 60000 })
      await daemon.start()

      const client = new DaemonClient(pipePath)
      await client.connect()

      const resp = await client.connectHost("/nonexistent/config.json")
      assert.equal(resp.ok, false)
      assert.ok((resp as any).error.includes("ENOENT"))

      client.disconnect()
    })

    it("should fail with invalid config content", async () => {
      const { writeFileSync } = await import("fs")
      const configPath = join(tmpDir, "bad-config.json")
      writeFileSync(configPath, JSON.stringify({ not: "valid" }), "utf-8")

      daemon = new SSHDaemon({ pipePath, idleTimeoutMs: 60000 })
      await daemon.start()

      const client = new DaemonClient(pipePath)
      await client.connect()

      const resp = await client.connectHost(configPath)
      assert.equal(resp.ok, false)
      assert.ok((resp as any).error.includes("target.host"))

      client.disconnect()
    })
  })

  describe("exec without session", () => {
    it("should fail when session does not exist", async () => {
      daemon = new SSHDaemon({ pipePath, idleTimeoutMs: 60000 })
      await daemon.start()

      const client = new DaemonClient(pipePath)
      await client.connect()

      const resp = await client.exec("nonexistent-session", "echo hi")
      assert.equal(resp.ok, false)
      assert.ok((resp as any).error.includes("not found"))

      client.disconnect()
    })
  })

  describe("disconnect nonexistent session", () => {
    it("should fail gracefully", async () => {
      daemon = new SSHDaemon({ pipePath, idleTimeoutMs: 60000 })
      await daemon.start()

      const client = new DaemonClient(pipePath)
      await client.connect()

      const resp = await client.disconnectSession("nonexistent")
      assert.equal(resp.ok, false)
      assert.ok((resp as any).error.includes("not found"))

      client.disconnect()
    })
  })

  describe("shutdown", () => {
    it("should respond to shutdown request", async () => {
      daemon = new SSHDaemon({ pipePath, idleTimeoutMs: 60000 })
      await daemon.start()

      const client = new DaemonClient(pipePath)
      await client.connect()

      const resp = await client.shutdown()
      assert.equal(resp.ok, true)

      // Daemon should be stopped now
      // Give it a moment to fully shut down
      await new Promise((r) => setTimeout(r, 200))
      daemon = null as any // prevent afterEach from trying to shut it down again
    })
  })

  describe("concurrent clients", () => {
    it("should handle multiple simultaneous connections", async () => {
      daemon = new SSHDaemon({ pipePath, idleTimeoutMs: 60000 })
      await daemon.start()

      const client1 = new DaemonClient(pipePath)
      const client2 = new DaemonClient(pipePath)

      await Promise.all([client1.connect(), client2.connect()])

      const [resp1, resp2] = await Promise.all([client1.ping(), client2.ping()])

      assert.equal(resp1.ok, true)
      assert.equal(resp2.ok, true)

      client1.disconnect()
      client2.disconnect()
    })
  })
})
