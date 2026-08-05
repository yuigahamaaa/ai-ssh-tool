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
import { SchedulerService } from "../scheduler/scheduler-service.js"
import { PersistenceStore } from "../scheduler/persistence-store.js"
import { OutputStore } from "../scheduler/output-store.js"
import { EventLog } from "../scheduler/event-log.js"
import type { ScheduledTask, TaskRunner } from "../scheduler/types.js"

class FakeSchedulerRunner implements TaskRunner {
  started: string[] = []
  cancelResult = true
  private pending = new Map<string, (result: { code: number; stdout: string; stderr: string }) => void>()

  async start(task: ScheduledTask): Promise<{ code: number; stdout: string; stderr: string }> {
    this.started.push(task.id)
    return new Promise(resolve => {
      this.pending.set(task.id, (result) => resolve(result))
    })
  }

  startBackground(task: ScheduledTask, _onOutput: (stdout: string, stderr: string) => void, _onClose: (code: number, signal?: string) => void): void {
    this.started.push(task.id)
  }

  cancel(_task: ScheduledTask): boolean {
    return this.cancelResult
  }
}

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

  describe("concurrent connectJson dedup", () => {
    it("deduplicates concurrent connectHostJson requests for the same config", async () => {
      daemon = new SSHDaemon({ pipePath, idleTimeoutMs: 60000 })
      await daemon.start()

      let connectCalls = 0
      ;(daemon as any).gateway.connectSimple = async () => {
        connectCalls++
        await new Promise(r => setTimeout(r, 30))
        return { id: "sess-1", status: "connected" }
      }

      const configJson = JSON.stringify({ target: { host: "10.0.0.1", username: "root" } })
      const client = new DaemonClient(pipePath)
      await client.connect()
      const results = await Promise.all([0, 1, 2].map(() => client.connectHostJson(configJson)))

      assert.equal(connectCalls, 1, "only one underlying connection should be attempted")
      for (const r of results) {
        assert.equal(r.ok, true)
        assert.equal((r.data as any).sessionId, "sess-1")
      }
      client.disconnect()
    })

    it("shares a failed connection result across concurrent requests", async () => {
      daemon = new SSHDaemon({ pipePath, idleTimeoutMs: 60000 })
      await daemon.start()

      let connectCalls = 0
      ;(daemon as any).gateway.connectSimple = async () => {
        connectCalls++
        await new Promise(r => setTimeout(r, 10))
        throw new Error("auth failed")
      }

      const configJson = JSON.stringify({ target: { host: "10.0.0.2", username: "root" } })
      const client = new DaemonClient(pipePath)
      await client.connect()
      const results = await Promise.all([0, 1, 2].map(() => client.connectHostJson(configJson)))

      assert.equal(connectCalls, 1, "failed connect should also be deduplicated")
      for (const r of results) {
        assert.equal(r.ok, false)
        assert.ok((r as any).error.includes("auth failed"))
      }
      client.disconnect()
    })
  })

  describe("scheduled task session rebinding", () => {
    it("rebinds a queued task to the current healthy session when its original session is gone", async () => {
      daemon = new SSHDaemon({ pipePath, idleTimeoutMs: 60000 })
      await daemon.start()

      const { EventEmitter } = await import("events")
      let receivedCmd = ""
      const stream = new EventEmitter() as any
      stream.stderr = new EventEmitter()
      stream.close = () => {}
      const fakeClient = {
        exec: (cmd: string, cb: Function) => {
          receivedCmd = cmd
          cb(null, stream)
          process.nextTick(() => stream.emit("close", 0))
        },
      }
      const fakeConn = { isConnected: () => true, getFinalClient: () => fakeClient }
      ;(daemon as any).gateway.sessions = {
        getConnection: (sid: string) => (sid === "new-session" ? fakeConn : undefined),
      }
      // The sessionMap entry is keyed by CONFIG hash (which includes
      // credentials) while the task's hostId is the TARGET identity hash
      // (host/port/user only) — two different namespaces. Rebinding must match
      // the entry's targetHash; a naive sessionMap.get(hostId) must NOT hit.
      // The notEqual assertion below guarantees the test isn't passing by
      // coincidence of equal keys.
      const { targetIdentityHash } = await import("../mcp-scheduler-contract.js")
      const targetHash = targetIdentityHash({ host: "10.0.0.1", port: 22, username: "root" })
      assert.notEqual(targetHash, "cfg-hash-123")
      ;(daemon as any).sessionMap.set("cfg-hash-123", {
        sessionId: "new-session",
        configHash: "cfg-hash-123",
        targetHash,
      })

      const task: any = {
        id: "t1",
        sessionId: "old-session",
        hostId: targetHash,
        effectiveCwd: undefined,
        command: "echo hi",
        timeoutMs: 5000,
      }
      const runner = (daemon as any).scheduler.getRunner()
      const result = await runner.start(task, () => {})

      assert.equal(result.code, 0)
      assert.ok(receivedCmd.includes("echo hi"), `expected command on rebound client, got: ${receivedCmd}`)
      assert.equal(task.sessionId, "new-session", "task should be rebound to the healthy session")
    })

    it("fails the task when no healthy session exists for the host", async () => {
      daemon = new SSHDaemon({ pipePath, idleTimeoutMs: 60000 })
      await daemon.start()

      ;(daemon as any).gateway.sessions = { getConnection: () => undefined }
      ;(daemon as any).sessionMap.clear()

      const task: any = {
        id: "t2",
        sessionId: "old-session",
        hostId: "target-hash-xyz",
        effectiveCwd: undefined,
        command: "echo hi",
        timeoutMs: 5000,
      }
      const runner = (daemon as any).scheduler.getRunner()
      await assert.rejects(
        () => runner.start(task, () => {}),
        /Session .* not found/,
      )
    })
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

    it("rejects new connects once stopping has begun", async () => {
      daemon = new SSHDaemon({ pipePath, idleTimeoutMs: 60000 })
      await daemon.start()
      ;(daemon as any).stopping = true

      const client = new DaemonClient(pipePath)
      await client.connect()

      const resp = await client.connectHostJson(
        JSON.stringify({ target: { host: "10.0.0.9", username: "root" } }),
      )
      assert.equal(resp.ok, false)
      assert.ok((resp as any).error.includes("shutting down"))
      client.disconnect()
    })

    it("waits for in-flight connects to settle during stop()", async () => {
      daemon = new SSHDaemon({ pipePath, idleTimeoutMs: 60000 })
      await daemon.start()

      let connectCalls = 0
      ;(daemon as any).gateway.connectSimple = async () => {
        connectCalls++
        await new Promise(r => setTimeout(r, 50))
        return { id: "sess-slow", status: "connected" }
      }

      // Start an in-flight connect through the handler directly (no IPC round
      // trip), then stop while it is still pending. stop() must wait for the
      // connect to settle so the session it creates is torn down by
      // disconnectAll instead of leaking past shutdown.
      const pending = (daemon as any).handleConnectJson({
        id: "c1",
        params: { configJson: JSON.stringify({ target: { host: "10.0.0.8", username: "root" } }) },
      })

      // Give the connect time to start before shutting down.
      await new Promise(r => setTimeout(r, 10))

      const stopPromise = daemon.stop()
      const resp = await pending
      assert.equal(resp.ok, true, "in-flight connect should complete, not be rejected")

      await stopPromise
      assert.equal(connectCalls, 1)
      daemon = null as any // prevent afterEach double-shutdown
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

  describe("scheduler abort", () => {
    it("should abort active scheduler tasks through IPC without starting queued work", async () => {
      const runner = new FakeSchedulerRunner()
      const scheduler = new SchedulerService({
        persistence: new PersistenceStore(join(tmpDir, "scheduler")),
        runner,
        outputStore: new OutputStore(join(tmpDir, "outputs")),
        eventLog: new EventLog(join(tmpDir, "events")),
        maxLargeRunning: 1,
      })
      daemon = new SSHDaemon({ pipePath, idleTimeoutMs: 60000, scheduler })
      await daemon.start()

      const client = new DaemonClient(pipePath)
      await client.connect()

      const base = {
        host: { id: "host-1", profileKey: "host-1", targetHost: "target.example.com", targetUser: "root", displayName: "target" },
        sessionId: "sess-1",
        command: "npm test",
        cost: "large",
        background: true,
      }
      const first = await client.schedule({ ...base, agent: { id: "agent-a", clientType: "cli" } })
      const second = await client.schedule({ ...base, agent: { id: "agent-b", clientType: "mcp" } })

      assert.equal(first.ok, true)
      assert.equal((first.data as any).action, "run_now")
      assert.equal(second.ok, true)
      assert.equal((second.data as any).action, "queued")
      assert.deepEqual(runner.started, [(first.data as any).taskId])

      const aborted = await client.abortActiveTasks("fatal test")

      assert.equal(aborted.ok, true)
      assert.deepEqual(aborted.data, { cancelled: 2, cancelFailed: 0 })
      assert.deepEqual(runner.started, [(first.data as any).taskId])
      assert.equal(scheduler.queueStatus("host-1").running.length, 0)
      assert.equal(scheduler.queueStatus("host-1").queued.length, 0)

      client.disconnect()
    })
  })

  describe("session bookkeeping cleanup", () => {
    it("cleanupSession removes the sessionMap entry and the forwardManager for that session", async () => {
      daemon = new SSHDaemon({ pipePath, idleTimeoutMs: 60000 })
      await daemon.start()

      const d = daemon as unknown as {
        sessionMap: Map<string, { sessionId: string; configHash: string }>
        forwardManagers: Map<string, unknown>
        cleanupSession: (sessionId: string) => void
      }

      // Pre-populate bookkeeping for two sessions.
      d.sessionMap.set("hash-a", { sessionId: "sess-a", configHash: "hash-a" })
      d.sessionMap.set("hash-b", { sessionId: "sess-b", configHash: "hash-b" })
      d.forwardManagers.set("sess-a", { marker: true })
      d.forwardManagers.set("sess-b", { marker: true })
      // Unrelated session with a manager but no sessionMap entry (e.g. created
      // before being recorded) — its forwardManager must be cleared too.
      d.forwardManagers.set("sess-c", { marker: true })

      assert.equal(d.sessionMap.size, 2)
      assert.equal(d.forwardManagers.size, 3)

      d.cleanupSession("sess-a")

      assert.equal(d.sessionMap.size, 1)
      assert.ok(!d.sessionMap.has("hash-a"))
      assert.ok(d.sessionMap.has("hash-b"))
      assert.ok(!d.forwardManagers.has("sess-a"))
      assert.ok(d.forwardManagers.has("sess-b"))
      assert.ok(d.forwardManagers.has("sess-c"))

      // cleanupSession on a session with no sessionMap entry should still drop
      // its forwardManager (covers the "freshly created then disconnected"
      // path in handleConnect error blocks).
      d.cleanupSession("sess-c")
      assert.equal(d.forwardManagers.size, 1)
      assert.ok(d.forwardManagers.has("sess-b"))
    })

    it("shutdown clears all forwardManagers and disposes the scheduler", async () => {
      const scheduler = new SchedulerService({
        persistence: new PersistenceStore(join(tmpDir, "shutdown-scheduler")),
        runner: new FakeSchedulerRunner(),
        outputStore: new OutputStore(join(tmpDir, "shutdown-outputs")),
        eventLog: new EventLog(join(tmpDir, "shutdown-events")),
        maxLargeRunning: 1,
      })
      daemon = new SSHDaemon({ pipePath, idleTimeoutMs: 60000, scheduler })
      await daemon.start()

      const d = daemon as unknown as {
        forwardManagers: Map<string, unknown>
        scheduler: { idleEvictTimer: ReturnType<typeof setInterval> | null }
      }
      d.forwardManagers.set("sess-x", { marker: true })
      assert.equal(d.forwardManagers.size, 1)
      assert.ok(d.scheduler.idleEvictTimer, "scheduler must have started its timer")

      await daemon.shutdown()

      assert.equal(d.forwardManagers.size, 0)
      assert.equal(d.scheduler.idleEvictTimer, null, "scheduler.dispose() should clear the timer")
    })
  })
})
