import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { SchedulerService } from "../scheduler/scheduler-service.js"
import { PersistenceStore } from "../scheduler/persistence-store.js"
import { OutputStore } from "../scheduler/output-store.js"
import { LockManager } from "../scheduler/lock-manager.js"
import { EventLog } from "../scheduler/event-log.js"
import type { ScheduleRequest, AgentIdentity, HostIdentity, ScheduledTask, TaskRunner } from "../scheduler/types.js"
import { mkdtempSync, rmSync, existsSync, readdirSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

function makeAgent(id = "agent-a"): AgentIdentity {
  return { id, name: `agent-${id}`, clientType: "mcp" }
}

function makeHost(id = "host-1"): HostIdentity {
  return { id, profileKey: `pk-${id}`, targetHost: "target.example.com", targetUser: "root", displayName: "target" }
}

function makeRequest(overrides: Partial<ScheduleRequest> & { agent?: AgentIdentity; host?: HostIdentity } = {}): ScheduleRequest {
  return {
    agent: overrides.agent ?? makeAgent(),
    host: overrides.host ?? makeHost(),
    sessionId: "sess-1",
    command: overrides.command ?? "echo ok",
    scheduler: overrides.scheduler ?? "auto",
    ...overrides,
  }
}

class FastRunner implements TaskRunner {
  started: string[] = []
  private pending = new Map<string, (result: { code: number; stdout: string; stderr: string }) => void>()

  async start(task: ScheduledTask): Promise<{ code: number; stdout: string; stderr: string }> {
    this.started.push(task.id)
    return new Promise(resolve => {
      this.pending.set(task.id, (result) => resolve(result))
    })
  }

  startBackground(task: ScheduledTask, onOutput: (stdout: string, stderr: string) => void, onClose: (code: number, signal?: string) => void): void {}

  cancel(_task: ScheduledTask): boolean { return true }

  finish(taskId: string, result: { code: number; stdout: string; stderr: string } = { code: 0, stdout: "", stderr: "" }) {
    const fn = this.pending.get(taskId)
    if (fn) {
      this.pending.delete(taskId)
      fn(result)
    }
  }

  finishAll(result: { code: number; stdout: string; stderr: string } = { code: 0, stdout: "", stderr: "" }) {
    for (const [id, fn] of this.pending) {
      fn(result)
    }
    this.pending.clear()
  }

  finishByPrefix(prefix: string, result: { code: number; stdout: string; stderr: string } = { code: 0, stdout: "", stderr: "" }) {
    for (const [id, fn] of Array.from(this.pending)) {
      if (this.started.find(s => s === id)) {
        fn(result)
        this.pending.delete(id)
      }
    }
  }
}

describe("Stress Tests", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "stress-test-"))
  })

  describe("high throughput scheduling", () => {
    it("schedules 500 tiny tasks without error", () => {
      const persistence = new PersistenceStore(join(tmpDir, "p"))
      const runner = new FastRunner()
      const s = new SchedulerService({ persistence, runner, outputStore: new OutputStore(join(tmpDir, "o")), eventLog: new EventLog(join(tmpDir, "events-o")), maxQueueSize: 200, maxTotalRunning: 50 })

      for (let i = 0; i < 500; i++) {
        const d = s.schedule(makeRequest({
          command: `rg ${i} src`,
          cost: "tiny",
          agent: makeAgent(`agent-${i % 10}`),
        }))
        assert.ok(d.action === "run_now" || d.action === "queued", `Task ${i} got unexpected action: ${d.action}`)
      }

      const status = s.queueStatus()
      assert.ok(status.running.length + status.queued.length <= 200 + 50, "Running + queued within limits")
    })

    it("schedules 100 large tasks and processes queue correctly", async () => {
      const persistence = new PersistenceStore(join(tmpDir, "p2"))
      const runner = new FastRunner()
      const s = new SchedulerService({ persistence, runner, outputStore: new OutputStore(join(tmpDir, "o2")), eventLog: new EventLog(join(tmpDir, "events-o2")), maxQueueSize: 100, maxTotalRunning: 4, maxLargeRunning: 1 })

      const decisions: { action: string; taskId?: string }[] = []
      for (let i = 0; i < 100; i++) {
        decisions.push(s.schedule(makeRequest({
          command: "npm test",
          intent: "test",
          cost: "large",
          agent: makeAgent(`agent-${i}`),
        })))
      }

      const runNow = decisions.filter(d => d.action === "run_now")
      const queued = decisions.filter(d => d.action === "queued")
      assert.ok(runNow.length >= 1, "At least one ran immediately")
      assert.equal(runNow.length + queued.length, 100, "All tasks either ran or queued")

      const finished = new Set<string>()
      for (let round = 0; round < 100; round++) {
        const toFinish = runner.started.filter(id => !finished.has(id))
        if (toFinish.length === 0) break
        for (const id of toFinish) {
          finished.add(id)
          runner.finish(id)
        }
        await new Promise(r => setTimeout(r, 10))
      }

      const finalStatus = s.queueStatus()
      assert.equal(finalStatus.queued.length, 0, "All tasks should be done")
    })
  })

  describe("queue saturation", () => {
    it("rejects tasks when queue is full, then accepts after drain", async () => {
      const persistence = new PersistenceStore(join(tmpDir, "p3"))
      const runner = new FastRunner()
      const s = new SchedulerService({ persistence, runner, outputStore: new OutputStore(join(tmpDir, "o3")), eventLog: new EventLog(join(tmpDir, "events-o3")), maxQueueSize: 3, maxTotalRunning: 2, maxLargeRunning: 1 })

      s.schedule(makeRequest({ command: "npm test", cost: "large", agent: makeAgent("a0") }))
      s.schedule(makeRequest({ command: "npm test", cost: "large", agent: makeAgent("a1") }))
      s.schedule(makeRequest({ command: "npm test", cost: "large", agent: makeAgent("a2") }))
      s.schedule(makeRequest({ command: "npm test", cost: "large", agent: makeAgent("a3") }))

      const d5 = s.schedule(makeRequest({ command: "npm test", cost: "large", agent: makeAgent("a4") }))
      assert.equal(d5.action, "rejected")
      assert.ok(d5.reason.includes("full") || d5.reason.includes("Queue"))

      const queued = runner.started.slice(0, 2)
      for (const id of queued) runner.finish(id)
      await new Promise(r => setTimeout(r, 20))

      const d6 = s.schedule(makeRequest({ command: "npm test", cost: "large", agent: makeAgent("a5") }))
      assert.ok(d6.action === "run_now" || d6.action === "queued")
    })
  })

  describe("output store under stress", () => {
    it("handles 1000 rapid append calls", () => {
      const store = new OutputStore(join(tmpDir, "os1"))
      store.create("task-stress")

      let expectedBytes = 0
      for (let i = 0; i < 1000; i++) {
        const line = `line-${i}\n`
        expectedBytes += Buffer.byteLength(line)
        store.appendStdout("task-stress", line)
      }

      const entry = store.get("task-stress")
      assert.ok(entry)
      assert.equal(entry.stdoutBytes, expectedBytes)
    })

    it("handles many concurrent task output files", () => {
      const store = new OutputStore(join(tmpDir, "os2"))

      for (let i = 0; i < 100; i++) {
        store.create(`task-${i}`)
        store.appendStdout(`task-${i}`, `output for task ${i}\n`)
      }

      for (let i = 0; i < 100; i++) {
        const entry = store.get(`task-${i}`)
        assert.ok(entry)
        assert.ok(entry.stdoutBytes > 0)
      }
    })

    it("cleanup under many files does not throw", () => {
      const store = new OutputStore(join(tmpDir, "os3"))

      for (let i = 0; i < 50; i++) {
        store.create(`old-${i}`)
        store.appendStdout(`old-${i}`, "data")
      }

      const result = store.cleanup({ retentionMs: 0, keepRecentTasks: 0 })
      assert.ok(result.deletedFiles >= 0)
    })
  })

  describe("persistence under stress", () => {
    it("writes and restores 200 tasks", () => {
      const pDir = join(tmpDir, "p-stress")
      const store = new PersistenceStore(pDir)

      for (let i = 0; i < 200; i++) {
        store.saveTask({
          id: `t-${i}`,
          agentId: `agent-${i % 5}`,
          hostId: "host-1",
          profileKey: "pk-1",
          sessionId: "s1",
          command: `echo ${i}`,
          classification: { intent: "inspect", cost: "tiny", blocking: false, mutates: false, risky: false, source: "auto", reason: "" },
          scheduler: "auto",
          status: i % 4 === 0 ? "running" : "queued",
          updatedAt: Date.now(),
          stdoutTail: "",
          stderrTail: "",
          stdoutBytes: 0,
          stderrBytes: 0,
        })
      }

      const store2 = new PersistenceStore(pDir)
      const { queued, stale } = store2.restore()
      assert.equal(queued.length + stale.length, 200)
      assert.equal(stale.length, 50)
      assert.equal(queued.length, 150)
    })

    it("rapid saveTask overwrites are consistent", () => {
      const pDir = join(tmpDir, "p-rapid")
      const store = new PersistenceStore(pDir)

      const task = {
        id: "rapid-task",
        agentId: "a1",
        hostId: "h1",
        profileKey: "pk1",
        sessionId: "s1",
        command: "echo rapid",
        classification: { intent: "inspect" as const, cost: "tiny" as const, blocking: false, mutates: false, risky: false, source: "auto" as const, reason: "" },
        scheduler: "auto" as const,
        status: "running" as ScheduledTask["status"],
        updatedAt: Date.now(),
        stdoutTail: "",
        stderrTail: "",
        stdoutBytes: 0,
        stderrBytes: 0,
      }

      for (let i = 0; i < 50; i++) {
        task.status = i % 2 === 0 ? "running" : "queued"
        task.updatedAt = Date.now()
        store.saveTask(task)
      }

      const store2 = new PersistenceStore(pDir)
      const allTasks = store2.loadAllTasks()
      assert.equal(allTasks.length, 1)
      assert.equal(allTasks[0].status, "queued")
    })
  })

  describe("lock manager under stress", () => {
    it("handles 500 rapid acquire and release cycles", () => {
      const lm = new LockManager()
      for (let i = 0; i < 500; i++) {
        const lock = lm.acquire("workdir", `/repo-${i % 10}`, "host-1", `agent-${i % 5}`, `task-${i}`)
        if (lock) lm.release(lock.id)
      }
      assert.equal(lm.getLocksForHost("host-1").length, 0)
    })

    it("handles high contention on single resource", () => {
      const lm = new LockManager()
      let acquired = 0
      let rejected = 0

      for (let i = 0; i < 100; i++) {
        const lock = lm.acquire("workdir", "/shared-repo", "host-1", `agent-${i}`, `task-${i}`)
        if (lock) {
          acquired++
          if (i % 3 === 0) lm.release(lock.id)
        } else {
          rejected++
        }
      }

      assert.ok(acquired > 0)
      assert.ok(rejected > 0)
    })
  })

  describe("event log under stress", () => {
    it("handles 1000 events and getRecent returns correct count", () => {
      const log = new EventLog(join(tmpDir, "events"))
      for (let i = 0; i < 1000; i++) {
        log.log("task_created", { taskId: `task-${i}`, hostId: `host-${i % 3}` })
      }

      const all = log.getRecent(1000)
      assert.equal(all.length, 1000)

      const filtered = log.getRecent(1000, "host-1")
      assert.ok(filtered.length > 0)
      assert.ok(filtered.every(e => e.hostId === "host-1"))

      const limited = log.getRecent(5)
      assert.equal(limited.length, 5)
    })
  })

  describe("memory stability under load", () => {
    it("schedule + finish cycle does not leak significantly", async () => {
      if (global.gc) global.gc()
      const before = process.memoryUsage().heapUsed / (1024 * 1024)

      const persistence = new PersistenceStore(join(tmpDir, "mem"))
      const runner = new FastRunner()
      const s = new SchedulerService({ persistence, runner, outputStore: new OutputStore(join(tmpDir, "mem-o")), eventLog: new EventLog(join(tmpDir, "events-mem")), maxQueueSize: 200, maxTotalRunning: 50 })

      for (let cycle = 0; cycle < 5; cycle++) {
        const ids: string[] = []
        for (let i = 0; i < 50; i++) {
          const d = s.schedule(makeRequest({
            command: `echo cycle-${cycle}-task-${i}`,
            agent: makeAgent(`agent-${i % 10}`),
          }))
          if (d.taskId) ids.push(d.taskId)
        }
        for (const id of ids) runner.finish(id)
        await new Promise(r => setTimeout(r, 10))
      }

      if (global.gc) global.gc()
      const after = process.memoryUsage().heapUsed / (1024 * 1024)
      const growth = after - before
      assert.ok(growth < 50, `Memory grew ${growth.toFixed(1)}MB after 250 task cycles, should be < 50MB`)
    })
  })
})
