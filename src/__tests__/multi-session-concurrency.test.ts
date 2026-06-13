import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { SchedulerService } from "../scheduler/scheduler-service.js"
import { PersistenceStore, BatchedPersistenceStore } from "../scheduler/persistence-store.js"
import { OutputStore } from "../scheduler/output-store.js"
import { EventLog } from "../scheduler/event-log.js"
import { SSHDaemon } from "../daemon.js"
import { DaemonClient } from "../daemon-client.js"
import type { ScheduleRequest, AgentIdentity, HostIdentity, ScheduledTask, TaskRunner } from "../scheduler/types.js"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

function makeAgent(id: string, clientType: "mcp" | "cli" = "mcp"): AgentIdentity {
  return { id, name: `agent-${id}`, clientType }
}

function makeHost(id: string): HostIdentity {
  return { id, profileKey: `pk-${id}`, targetHost: `${id}.example.com`, targetUser: "root", displayName: id }
}

function makeRequest(
  agentId: string,
  hostId: string,
  overrides: Partial<ScheduleRequest> = {}
): ScheduleRequest {
  return {
    agent: makeAgent(agentId),
    host: makeHost(hostId),
    sessionId: `sess-${agentId}-${hostId}`,
    command: "echo ok",
    scheduler: "auto",
    ...overrides,
  }
}

class MultiRunner implements TaskRunner {
  started: { taskId: string; agentId: string; hostId: string }[] = []
  private pending = new Map<string, (result: { code: number; stdout: string; stderr: string }) => void>()

  async start(task: ScheduledTask): Promise<{ code: number; stdout: string; stderr: string }> {
    this.started.push({ taskId: task.id, agentId: task.agentId, hostId: task.hostId })
    return new Promise(resolve => {
      this.pending.set(task.id, (result) => resolve(result))
    })
  }

  startBackground(task: ScheduledTask, onOutput: (stdout: string, stderr: string) => void, onClose: (code: number, signal?: string) => void): void {}

  cancel(_task: ScheduledTask): boolean { return true }

  finish(taskId: string, result: { code: number; stdout: string; stderr: string } = { code: 0, stdout: "", stderr: "" }) {
    const fn = this.pending.get(taskId)
    if (fn) { this.pending.delete(taskId); fn(result) }
  }
}

describe("Multi-Session Concurrency Tests", () => {
  let tmpDir: string
  let schedulers: SchedulerService[]

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "multi-session-"))
    schedulers = []
  })

  afterEach(() => {
    for (const scheduler of schedulers) {
      scheduler.dispose()
    }
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function trackScheduler(scheduler: SchedulerService): SchedulerService {
    schedulers.push(scheduler)
    return scheduler
  }

  describe("multi-agent scheduling on same host", () => {
    it("10 agents schedule tiny tasks on same host, all run concurrently", () => {
      const persistence = new PersistenceStore(join(tmpDir, "p1"))
      const runner = new MultiRunner()
      const s = trackScheduler(new SchedulerService({ persistence, runner, outputStore: new OutputStore(join(tmpDir, "o1")), eventLog: new EventLog(join(tmpDir, "events-o1")) }))

      const decisions: { action: string; taskId?: string }[] = []
      for (let i = 0; i < 10; i++) {
        decisions.push(s.schedule(makeRequest(`agent-${i}`, "shared-host", {
          command: `rg pattern${i} src`,
          cost: "tiny",
        })))
      }

      assert.ok(decisions.every(d => d.action === "run_now"), "All tiny tasks run immediately")
      assert.equal(runner.started.length, 10)
      const hostIds = runner.started.map(s => s.hostId)
      assert.ok(hostIds.every(h => h === "shared-host"))
    })

    it("5 agents schedule large tasks on same host, only 1 runs", () => {
      const persistence = new PersistenceStore(join(tmpDir, "p2"))
      const runner = new MultiRunner()
      const s = trackScheduler(new SchedulerService({
        persistence, runner, outputStore: new OutputStore(join(tmpDir, "o2")), eventLog: new EventLog(join(tmpDir, "events-o2")),
        maxLargeRunning: 1, maxTotalRunning: 4,
      }))

      const decisions: { action: string }[] = []
      for (let i = 0; i < 5; i++) {
        decisions.push(s.schedule(makeRequest(`agent-${i}`, "shared-host", {
          command: "npm test", intent: "test", cost: "large",
        })))
      }

      const runNow = decisions.filter(d => d.action === "run_now")
      const queued = decisions.filter(d => d.action === "queued")
      assert.equal(runNow.length, 1)
      assert.equal(queued.length, 4)
      assert.equal(runner.started.length, 1)
    })

    it("agent heartbeat concurrent updates do not throw", () => {
      const persistence = new PersistenceStore(join(tmpDir, "p3"))
      const runner = new MultiRunner()
      const s = trackScheduler(new SchedulerService({ persistence, runner, outputStore: new OutputStore(join(tmpDir, "o3")), eventLog: new EventLog(join(tmpDir, "events-o3")) }))

      for (let i = 0; i < 20; i++) {
        s.registerAgent(makeAgent(`agent-${i}`))
      }
      for (let i = 0; i < 100; i++) {
        s.heartbeat(`agent-${i % 20}`)
      }
      assert.ok(true)
    })
  })

  describe("cross-host scheduling", () => {
    it("tasks on different hosts are independent", () => {
      const persistence = new PersistenceStore(join(tmpDir, "ch1"))
      const runner = new MultiRunner()
      const s = trackScheduler(new SchedulerService({
        persistence, runner, outputStore: new OutputStore(join(tmpDir, "cho1")), eventLog: new EventLog(join(tmpDir, "events-cho1")),
        maxLargeRunning: 1, maxTotalRunning: 4,
      }))

      const a = s.schedule(makeRequest("agent-1", "host-alpha", {
        command: "npm test", intent: "test", cost: "large",
      }))
      const b = s.schedule(makeRequest("agent-2", "host-beta", {
        command: "npm test", intent: "test", cost: "large",
      }))

      assert.equal(a.action, "run_now")
      assert.equal(b.action, "run_now")
      assert.equal(runner.started.length, 2)
      assert.equal(runner.started[0].hostId, "host-alpha")
      assert.equal(runner.started[1].hostId, "host-beta")
    })

    it("queueStatus per host shows only host-specific tasks", () => {
      const persistence = new PersistenceStore(join(tmpDir, "ch2"))
      const runner = new MultiRunner()
      const s = trackScheduler(new SchedulerService({
        persistence, runner, outputStore: new OutputStore(join(tmpDir, "cho2")), eventLog: new EventLog(join(tmpDir, "events-cho2")),
        maxLargeRunning: 1,
      }))

      s.schedule(makeRequest("a1", "host-alpha", { command: "npm test", cost: "large" }))
      s.schedule(makeRequest("a2", "host-alpha", { command: "npm test", cost: "large" }))
      s.schedule(makeRequest("a3", "host-beta", { command: "npm test", cost: "large" }))

      const alpha = s.queueStatus("host-alpha")
      assert.equal(alpha.running.length, 1)
      assert.equal(alpha.queued.length, 1)

      const beta = s.queueStatus("host-beta")
      assert.equal(beta.running.length, 1)
      assert.equal(beta.queued.length, 0)
    })

    it("exclusive task on host-alpha does not block host-beta", () => {
      const persistence = new PersistenceStore(join(tmpDir, "ch3"))
      const runner = new MultiRunner()
      const s = trackScheduler(new SchedulerService({ persistence, runner, outputStore: new OutputStore(join(tmpDir, "cho3")), eventLog: new EventLog(join(tmpDir, "events-cho3")) }))

      s.schedule(makeRequest("deployer", "host-alpha", {
        command: "kubectl apply -f deploy.yaml", intent: "deploy", cost: "exclusive", force: true,
      }))

      const b = s.schedule(makeRequest("reader", "host-beta", {
        command: "rg foo src", cost: "tiny",
      }))
      assert.equal(b.action, "run_now")
    })

    it("10 hosts with 5 agents each, all scheduling concurrently", () => {
      const persistence = new PersistenceStore(join(tmpDir, "ch4"))
      const runner = new MultiRunner()
      const s = trackScheduler(new SchedulerService({
        persistence, runner, outputStore: new OutputStore(join(tmpDir, "cho4")), eventLog: new EventLog(join(tmpDir, "events-cho4")),
        maxLargeRunning: 2, maxTotalRunning: 20,
      }))

      const decisions: { action: string; hostId?: string }[] = []
      for (let h = 0; h < 10; h++) {
        for (let a = 0; a < 5; a++) {
          const d = s.schedule(makeRequest(`agent-${a}`, `host-${h}`, {
            command: "echo ok",
          }))
          decisions.push(d)
        }
      }

      assert.ok(decisions.every(d => d.action === "run_now"), "All tiny tasks across hosts run immediately")
      assert.equal(runner.started.length, 50)
    })
  })

  describe("virtual CWD concurrent isolation", () => {
    it("10 agents set different CWDs on same host, all isolated", () => {
      const persistence = new PersistenceStore(join(tmpDir, "cwd1"))
      const runner = new MultiRunner()
      const s = trackScheduler(new SchedulerService({ persistence, runner, outputStore: new OutputStore(join(tmpDir, "cwdo1")), eventLog: new EventLog(join(tmpDir, "events-cwdo1")) }))

      for (let i = 0; i < 10; i++) {
        s.setCwd(`agent-${i}`, "shared-host", `/project-${i}`)
      }

      for (let i = 0; i < 10; i++) {
        assert.equal(s.resolveCwd(`agent-${i}`, "shared-host"), `/project-${i}`)
      }
    })

    it("agent CWD on different hosts are independent", () => {
      const persistence = new PersistenceStore(join(tmpDir, "cwd2"))
      const runner = new MultiRunner()
      const s = trackScheduler(new SchedulerService({ persistence, runner, outputStore: new OutputStore(join(tmpDir, "cwdo2")), eventLog: new EventLog(join(tmpDir, "events-cwdo2")) }))

      s.setCwd("agent-1", "host-a", "/repo-a")
      s.setCwd("agent-1", "host-b", "/repo-b")
      s.setCwd("agent-1", "host-c", "/repo-c")

      assert.equal(s.resolveCwd("agent-1", "host-a"), "/repo-a")
      assert.equal(s.resolveCwd("agent-1", "host-b"), "/repo-b")
      assert.equal(s.resolveCwd("agent-1", "host-c"), "/repo-c")
    })

    it("virtual CWD appears in scheduled task decision", () => {
      const persistence = new PersistenceStore(join(tmpDir, "cwd3"))
      const runner = new MultiRunner()
      const s = trackScheduler(new SchedulerService({ persistence, runner, outputStore: new OutputStore(join(tmpDir, "cwdo3")), eventLog: new EventLog(join(tmpDir, "events-cwdo3")) }))

      s.setCwd("agent-1", "host-1", "/workspace")
      const d = s.schedule(makeRequest("agent-1", "host-1"))
      assert.equal(d.effectiveCwd, "/workspace")
    })

    it("explicit cwd overrides virtual cwd for specific task", () => {
      const persistence = new PersistenceStore(join(tmpDir, "cwd4"))
      const runner = new MultiRunner()
      const s = trackScheduler(new SchedulerService({ persistence, runner, outputStore: new OutputStore(join(tmpDir, "cwdo4")), eventLog: new EventLog(join(tmpDir, "events-cwdo4")) }))

      s.setCwd("agent-1", "host-1", "/workspace")
      const d = s.schedule(makeRequest("agent-1", "host-1", { cwd: "/tmp" }))
      assert.equal(d.effectiveCwd, "/tmp")
    })

    it("rapid CWD switching does not corrupt state", () => {
      const persistence = new PersistenceStore(join(tmpDir, "cwd5"))
      const runner = new MultiRunner()
      const s = trackScheduler(new SchedulerService({ persistence, runner, outputStore: new OutputStore(join(tmpDir, "cwdo5")), eventLog: new EventLog(join(tmpDir, "events-cwdo5")) }))

      for (let i = 0; i < 100; i++) {
        s.setCwd("agent-1", "host-1", `/dir-${i}`)
      }
      assert.equal(s.resolveCwd("agent-1", "host-1"), "/dir-99")

      for (let i = 0; i < 100; i++) {
        s.setCwd("agent-2", "host-1", `/other-${i}`)
      }
      assert.equal(s.resolveCwd("agent-1", "host-1"), "/dir-99")
      assert.equal(s.resolveCwd("agent-2", "host-1"), "/other-99")
    })

    it("queueStatus returns correct virtualCwd per requesting agent", () => {
      const persistence = new PersistenceStore(join(tmpDir, "cwd6"))
      const runner = new MultiRunner()
      const s = trackScheduler(new SchedulerService({ persistence, runner, outputStore: new OutputStore(join(tmpDir, "cwdo6")), eventLog: new EventLog(join(tmpDir, "events-cwdo6")) }))

      s.setCwd("alice", "host-1", "/alice-project")
      s.setCwd("bob", "host-1", "/bob-project")

      const aliceStatus = s.queueStatus("host-1", 20, "alice")
      assert.equal(aliceStatus.virtualCwd, "/alice-project")

      const bobStatus = s.queueStatus("host-1", 20, "bob")
      assert.equal(bobStatus.virtualCwd, "/bob-project")
    })
  })

  describe("daemon IPC concurrent requests", () => {
    let daemon: SSHDaemon
    let tmpPipeDir: string
    let tmpDataDir: string
    let pipePath: string

    beforeEach(() => {
      tmpPipeDir = mkdtempSync(join(tmpDir, "daemon-ipc-"))
      tmpDataDir = mkdtempSync(join(tmpDir, "daemon-data-"))
      pipePath = process.platform === "win32"
        ? `\\\\.\\pipe\\ssh-daemon-multi-${Date.now()}`
        : join(tmpPipeDir, "daemon.sock")
    })

    function makeTempScheduler(): SchedulerService {
      return new SchedulerService({
        persistence: new BatchedPersistenceStore(new PersistenceStore(join(tmpDataDir, "scheduler"))),
        outputStore: new OutputStore(join(tmpDataDir, "scheduler", "outputs")),
        eventLog: new EventLog(join(tmpDataDir, "scheduler", "events")),
      })
    }

    afterEach(async () => {
      if (daemon) {
        await daemon.shutdown().catch(() => {})
      }
    })

    it("multiple clients send ping concurrently", async () => {
      daemon = new SSHDaemon({ pipePath, idleTimeoutMs: 60000, scheduler: makeTempScheduler() })
      await daemon.start()

      const clients = Array.from({ length: 5 }, () => new DaemonClient(pipePath))
      await Promise.all(clients.map(c => c.connect()))

      const results = await Promise.all(clients.map(c => c.ping()))

      assert.ok(results.every(r => r.ok), "All pings should succeed")
      clients.forEach(c => c.disconnect())
    })

    it("multiple clients send schedule concurrently", async () => {
      daemon = new SSHDaemon({ pipePath, idleTimeoutMs: 60000, scheduler: makeTempScheduler() })
      await daemon.start()

      const clients = Array.from({ length: 3 }, () => new DaemonClient(pipePath))
      await Promise.all(clients.map(c => c.connect()))

      const results = await Promise.all(clients.map((c, i) =>
        c.schedule({
          agent: { id: `agent-${i}`, name: `agent-${i}`, clientType: "mcp" },
          host: { id: "h1", profileKey: "pk1", targetHost: "host", targetUser: "user", displayName: "host" },
          sessionId: `sess-${i}`,
          command: `echo agent-${i}`,
          scheduler: "auto",
        })
      ))

      assert.ok(results.every(r => r.ok), "All schedules should succeed")
      clients.forEach(c => c.disconnect())
    })

    it("concurrent setCwd from different agents via IPC", async () => {
      daemon = new SSHDaemon({ pipePath, idleTimeoutMs: 60000, scheduler: makeTempScheduler() })
      await daemon.start()

      const clients = Array.from({ length: 3 }, () => new DaemonClient(pipePath))
      await Promise.all(clients.map(c => c.connect()))

      const host: HostIdentity = { id: "h1", profileKey: "pk1", targetHost: "host", targetUser: "user", displayName: "host" }
      await Promise.all(clients.map((c, i) =>
        c.setCwd(makeAgent(`agent-${i}`), host, `/project-${i}`)
      ))

      clients.forEach(c => c.disconnect())
    })

    it("concurrent list sessions from multiple clients", async () => {
      daemon = new SSHDaemon({ pipePath, idleTimeoutMs: 60000, scheduler: makeTempScheduler() })
      await daemon.start()

      const clients = Array.from({ length: 5 }, () => new DaemonClient(pipePath))
      await Promise.all(clients.map(c => c.connect()))

      const results = await Promise.all(clients.map(c => c.list()))
      assert.ok(results.every(r => r.ok))

      clients.forEach(c => c.disconnect())
    })

    it("rapid connect-disconnect cycles from same client", async () => {
      daemon = new SSHDaemon({ pipePath, idleTimeoutMs: 60000, scheduler: makeTempScheduler() })
      await daemon.start()

      const client = new DaemonClient(pipePath)
      for (let i = 0; i < 10; i++) {
        await client.connect()
        const resp = await client.ping()
        assert.ok(resp.ok)
        client.disconnect()
      }
    })
  })

  describe("multi-agent task lifecycle concurrency", () => {
    it("agent A finishes task, queue pumps tasks from agents B and C in order", async () => {
      const persistence = new PersistenceStore(join(tmpDir, "lc1"))
      const runner = new MultiRunner()
      const s = trackScheduler(new SchedulerService({
        persistence, runner, outputStore: new OutputStore(join(tmpDir, "lco1")), eventLog: new EventLog(join(tmpDir, "events-lco1")),
        maxLargeRunning: 1,
      }))

      const a = s.schedule(makeRequest("agent-a", "host-1", { command: "npm test", cost: "large" }))
      const b = s.schedule(makeRequest("agent-b", "host-1", { command: "npm test", cost: "large" }))
      const c = s.schedule(makeRequest("agent-c", "host-1", { command: "npm test", cost: "large" }))

      assert.equal(a.action, "run_now")
      assert.equal(b.action, "queued")
      assert.equal(c.action, "queued")

      runner.finish(a.taskId!)
      await new Promise(r => setTimeout(r, 20))

      const taskB = s.getTask(b.taskId!)
      const taskC = s.getTask(c.taskId!)
      assert.equal(taskB?.status, "running", "B promoted after A finishes")
      assert.equal(taskC?.status, "queued", "C still queued")

      runner.finish(b.taskId!)
      await new Promise(r => setTimeout(r, 20))

      assert.equal(s.getTask(c.taskId!)?.status, "running", "C promoted after B finishes")
    })

    it("multiple agents dequeue their own queued tasks independently", () => {
      const persistence = new PersistenceStore(join(tmpDir, "lc2"))
      const runner = new MultiRunner()
      const s = trackScheduler(new SchedulerService({
        persistence, runner, outputStore: new OutputStore(join(tmpDir, "lco2")), eventLog: new EventLog(join(tmpDir, "events-lco2")),
        maxLargeRunning: 1,
      }))

      s.schedule(makeRequest("blocker", "host-1", { command: "npm test", cost: "large" }))
      const b = s.schedule(makeRequest("agent-b", "host-1", { command: "npm test", cost: "large" }))
      const c = s.schedule(makeRequest("agent-c", "host-1", { command: "npm test", cost: "large" }))

      assert.ok(s.dequeueTask(b.taskId!))
      assert.equal(s.getTask(b.taskId!)?.status, "cancelled")

      assert.ok(s.dequeueTask(c.taskId!))
      assert.equal(s.getTask(c.taskId!)?.status, "cancelled")

      const status = s.queueStatus("host-1")
      assert.equal(status.queued.length, 0)
    })

    it("agent cancels running task, next queued agent's task starts", async () => {
      const persistence = new PersistenceStore(join(tmpDir, "lc3"))
      const runner = new MultiRunner()
      const s = trackScheduler(new SchedulerService({
        persistence, runner, outputStore: new OutputStore(join(tmpDir, "lco3")), eventLog: new EventLog(join(tmpDir, "events-lco3")),
        maxLargeRunning: 1,
      }))

      const a = s.schedule(makeRequest("agent-a", "host-1", { command: "npm test", cost: "large" }))
      const b = s.schedule(makeRequest("agent-b", "host-1", { command: "npm test", cost: "large" }))
      assert.equal(b.action, "queued")

      s.cancelTask(a.taskId!)
      await new Promise(r => setTimeout(r, 20))

      assert.equal(s.getTask(a.taskId!)?.status, "cancelled")
      assert.equal(s.getTask(b.taskId!)?.status, "running")
    })

    it("getRecentEvents shows events from multiple agents", () => {
      const persistence = new PersistenceStore(join(tmpDir, "lc4"))
      const runner = new MultiRunner()
      const s = trackScheduler(new SchedulerService({ persistence, runner, outputStore: new OutputStore(join(tmpDir, "lco4")), eventLog: new EventLog(join(tmpDir, "events-lco4")) }))

      for (let i = 0; i < 10; i++) {
        s.schedule(makeRequest(`agent-${i}`, "host-1", { command: `echo ${i}` }))
      }

      const events = s.getRecentEvents(100, "host-1")
      const agentIds = new Set(events.map(e => e.agentId))
      assert.ok(agentIds.size >= 2, "Events from multiple agents")
      assert.ok(events.some(e => e.type === "task_created"))
    })
  })

  describe("concurrent task output isolation", () => {
    it("output from different agents' tasks are isolated", async () => {
      const persistence = new PersistenceStore(join(tmpDir, "oi1"))
      const runner = new MultiRunner()
      const s = trackScheduler(new SchedulerService({ persistence, runner, outputStore: new OutputStore(join(tmpDir, "oio1")), eventLog: new EventLog(join(tmpDir, "events-oio1")) }))

      const tasks: { taskId: string; agentId: string }[] = []
      for (let i = 0; i < 5; i++) {
        const d = s.schedule(makeRequest(`agent-${i}`, "host-1", { command: `echo agent-${i}-output` }))
        tasks.push({ taskId: d.taskId!, agentId: `agent-${i}` })
      }

      for (const t of tasks) {
        runner.finish(t.taskId, { code: 0, stdout: `output from ${t.agentId}\n`, stderr: "" })
      }
      await new Promise(r => setTimeout(r, 20))

      for (const t of tasks) {
        const output = s.getTaskOutput(t.taskId)
        assert.ok(output.stdout.includes(t.agentId), `Output for ${t.agentId} should be isolated`)
      }
    })

    it("concurrent getTaskOutput calls on different tasks do not interfere", async () => {
      const persistence = new PersistenceStore(join(tmpDir, "oi2"))
      const runner = new MultiRunner()
      const s = trackScheduler(new SchedulerService({ persistence, runner, outputStore: new OutputStore(join(tmpDir, "oio2")), eventLog: new EventLog(join(tmpDir, "events-oio2")) }))

      const ids: string[] = []
      for (let i = 0; i < 10; i++) {
        const d = s.schedule(makeRequest(`agent-${i}`, "host-1"))
        ids.push(d.taskId!)
      }
      for (let i = 0; i < 10; i++) {
        runner.finish(ids[i], { code: 0, stdout: `result-${i}\n`, stderr: "" })
      }
      await new Promise(r => setTimeout(r, 20))

      const outputs = ids.map(id => s.getTaskOutput(id))
      for (let i = 0; i < 10; i++) {
        assert.ok(outputs[i].stdout.includes(`result-${i}`))
      }
    })
  })
})
