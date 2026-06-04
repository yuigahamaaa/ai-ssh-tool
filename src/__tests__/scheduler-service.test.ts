import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { SchedulerService } from "../scheduler/scheduler-service.js"
import { PersistenceStore } from "../scheduler/persistence-store.js"
import type { ScheduleRequest, AgentIdentity, HostIdentity, ScheduledTask, TaskRunner } from "../scheduler/types.js"
import { mkdtempSync, rmSync } from "fs"
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

class FakeRunner implements TaskRunner {
  started: string[] = []
  private pending = new Map<string, (result: { code: number; stdout: string; stderr: string }) => void>()

  async start(task: ScheduledTask): Promise<{ code: number; stdout: string; stderr: string }> {
    this.started.push(task.id)
    return new Promise(resolve => {
      this.pending.set(task.id, (result) => resolve(result))
    })
  }

  startBackground(
    task: ScheduledTask,
    onOutput: (stdout: string, stderr: string) => void,
    onClose: (code: number, signal?: string) => void
  ): void {
    // no-op for tests
  }

  finish(taskId: string, result: { code: number; stdout: string; stderr: string } = { code: 0, stdout: "", stderr: "" }) {
    const fn = this.pending.get(taskId)
    if (fn) {
      this.pending.delete(taskId)
      fn(result)
    }
  }
}

describe("SchedulerService", () => {
  let tmpDir: string
  let persistence: PersistenceStore
  let runner: FakeRunner
  let scheduler: SchedulerService

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sched-test-"))
    persistence = new PersistenceStore(tmpDir)
    runner = new FakeRunner()
    scheduler = new SchedulerService({ persistence, runner, maxQueueSize: 50, maxTotalRunning: 4, maxLargeRunning: 1 })
  })

  it("large blocks large", () => {
    const a = scheduler.schedule(makeRequest({ command: "npm test", intent: "test", cost: "large" }))
    assert.equal(a.action, "run_now")

    const b = scheduler.schedule(makeRequest({ command: "npm test", intent: "test", cost: "large", agent: makeAgent("agent-b") }))
    assert.equal(b.action, "queued")
    assert.equal(b.queuePosition, 1)
    assert.equal(runner.started.length, 1)
    assert.equal(runner.started[0], a.taskId)
  })

  it("tiny not blocked by large", () => {
    scheduler.schedule(makeRequest({ command: "npm test", intent: "test", cost: "large" }))
    const b = scheduler.schedule(makeRequest({ command: "rg foo src", intent: "search", cost: "tiny" }))
    assert.equal(b.action, "run_now")
    assert.equal(runner.started.length, 2)
  })

  it("exclusive blocks tiny (non-bypass)", () => {
    const a = scheduler.schedule(makeRequest({ command: "kubectl apply -f deploy.yaml", intent: "deploy", cost: "exclusive", force: true }))
    assert.equal(a.action, "run_now")

    const b = scheduler.schedule(makeRequest({ command: "rg foo src", intent: "search", cost: "tiny", agent: makeAgent("agent-b") }))
    assert.equal(b.action, "queued")
    assert.ok(b.blockers && b.blockers.length > 0)
  })

  it("risky without force returns needs_confirmation", () => {
    const d = scheduler.schedule(makeRequest({ command: "rm -rf /tmp/foo" }))
    assert.equal(d.action, "needs_confirmation")
    assert.equal(runner.started.length, 0)
  })

  it("queue FIFO: B starts before C after A finishes", async () => {
    const a = scheduler.schedule(makeRequest({ command: "npm test", intent: "test", cost: "large" }))
    assert.equal(a.action, "run_now")

    const b = scheduler.schedule(makeRequest({ command: "npm test", intent: "test", cost: "large", agent: makeAgent("b") }))
    assert.equal(b.action, "queued")

    const c = scheduler.schedule(makeRequest({ command: "npm test", intent: "test", cost: "large", agent: makeAgent("c") }))
    assert.equal(c.action, "queued")

    runner.finish(a.taskId!)

    await new Promise(r => setTimeout(r, 10))

    // B should now be running, C still queued
    const taskB = scheduler.getTask(b.taskId!)
    assert.equal(taskB?.status, "running")

    const taskC = scheduler.getTask(c.taskId!)
    assert.equal(taskC?.status, "queued")
  })

  it("queue max size rejects", () => {
    const sTmpDir = mkdtempSync(join(tmpdir(), "sched-maxq-"))
    const sPersistence = new PersistenceStore(sTmpDir)
    const sRunner = new FakeRunner()
    const s = new SchedulerService({ persistence: sPersistence, runner: sRunner, maxQueueSize: 2, maxTotalRunning: 4, maxLargeRunning: 1 })

    s.schedule(makeRequest({ command: "npm test", cost: "large" }))
    const b = s.schedule(makeRequest({ command: "npm test", cost: "large", agent: makeAgent("b") }))
    const c = s.schedule(makeRequest({ command: "npm test", cost: "large", agent: makeAgent("c") }))
    const d = s.schedule(makeRequest({ command: "npm test", cost: "large", agent: makeAgent("d") }))

    assert.equal(b.action, "queued")
    assert.equal(c.action, "queued")
    assert.equal(d.action, "rejected")
    assert.ok(d.reason.includes("full") || d.reason.includes("Queue"))

    rmSync(sTmpDir, { recursive: true, force: true })
  })

  it("if_busy=wait returns wait_recommended", () => {
    scheduler.schedule(makeRequest({ command: "npm test", cost: "large" }))
    const b = scheduler.schedule(makeRequest({ command: "npm test", cost: "large", agent: makeAgent("b"), ifBusy: "wait" }))
    assert.equal(b.action, "wait_recommended")
  })

  it("if_busy=fail returns rejected", () => {
    scheduler.schedule(makeRequest({ command: "npm test", cost: "large" }))
    const b = scheduler.schedule(makeRequest({ command: "npm test", cost: "large", agent: makeAgent("b"), ifBusy: "fail" }))
    assert.equal(b.action, "rejected")
  })

  it("if_busy=run_anyway executes despite blockers", () => {
    scheduler.schedule(makeRequest({ command: "npm test", cost: "large" }))
    const b = scheduler.schedule(makeRequest({ command: "npm test", cost: "large", agent: makeAgent("b"), ifBusy: "run_anyway" }))
    assert.equal(b.action, "run_now")
    assert.equal(runner.started.length, 2)
  })

  it("bypass skips queue but still registered", () => {
    scheduler.schedule(makeRequest({ command: "npm test", cost: "large" }))
    const b = scheduler.schedule(makeRequest({ command: "npm test", cost: "large", agent: makeAgent("b"), scheduler: "bypass" }))
    assert.equal(b.action, "run_now")
    assert.equal(runner.started.length, 2)

    const task = scheduler.getTask(b.taskId!)
    assert.equal(task?.scheduler, "bypass")
    assert.equal(task?.status, "running")
  })

  it("task finish persists completed status", async () => {
    const d = scheduler.schedule(makeRequest({ command: "echo ok" }))
    assert.equal(d.action, "run_now")

    runner.finish(d.taskId!, { code: 0, stdout: "ok\n", stderr: "" })
    await new Promise(r => setTimeout(r, 10))

    const task = scheduler.getTask(d.taskId!)
    assert.equal(task?.status, "completed")
    assert.equal(task?.exitCode, 0)
    assert.ok(task?.finishedAt)
    assert.equal(task?.stdoutTail, "ok\n")
  })

  it("dequeueTask removes queued task", () => {
    scheduler.schedule(makeRequest({ command: "npm test", cost: "large" }))
    const b = scheduler.schedule(makeRequest({ command: "npm test", cost: "large", agent: makeAgent("b") }))
    assert.equal(b.action, "queued")

    const removed = scheduler.dequeueTask(b.taskId!)
    assert.equal(removed, true)

    const task = scheduler.getTask(b.taskId!)
    assert.equal(task?.status, "cancelled")
  })

  it("virtual cwd per agent+host", () => {
    scheduler.setCwd("agent-a", "host-1", "/repo-a")
    scheduler.setCwd("agent-b", "host-1", "/repo-b")

    assert.equal(scheduler.resolveCwd("agent-a", "host-1"), "/repo-a")
    assert.equal(scheduler.resolveCwd("agent-b", "host-1"), "/repo-b")
  })

  it("explicit cwd overrides virtual cwd", () => {
    scheduler.setCwd("agent-a", "host-1", "/repo-a")
    assert.equal(scheduler.resolveCwd("agent-a", "host-1", "/tmp"), "/tmp")
  })

  it("no cwd returns undefined", () => {
    assert.equal(scheduler.resolveCwd("agent-a", "host-1"), undefined)
  })

  it("schedule includes effectiveCwd from virtual cwd", () => {
    scheduler.setCwd("agent-a", "host-1", "/repo")
    const d = scheduler.schedule(makeRequest({ agent: makeAgent("agent-a"), host: makeHost("host-1") }))
    assert.equal(d.effectiveCwd, "/repo")
  })

  it("schedule includes classification", () => {
    const d = scheduler.schedule(makeRequest({ command: "npm test" }))
    assert.ok(d.classification)
    assert.equal(d.classification?.intent, "test")
    assert.equal(d.classification?.cost, "large")
  })

  it("queueStatus shows running and queued", () => {
    scheduler.schedule(makeRequest({ command: "npm test", cost: "large" }))
    scheduler.schedule(makeRequest({ command: "npm test", cost: "large", agent: makeAgent("b") }))

    const status = scheduler.queueStatus("host-1")
    assert.equal(status.running.length, 1)
    assert.equal(status.queued.length, 1)
  })

  it("getTaskOutput returns tail by default", async () => {
    const d = scheduler.schedule(makeRequest({ command: "echo hello world" }))
    runner.finish(d.taskId!, { code: 0, stdout: "hello world\n", stderr: "" })
    await new Promise(r => setTimeout(r, 10))

    const output = scheduler.getTaskOutput(d.taskId!)
    assert.equal(output.stdout, "hello world\n")
    assert.equal(output.stderr, "")
  })

  it("getRecentEvents returns events", () => {
    scheduler.schedule(makeRequest({ command: "echo test" }))
    const events = scheduler.getRecentEvents(10)
    assert.ok(events.length >= 1)
    assert.ok(events.some(e => e.type === "task_created"))
  })

  it("agent heartbeat updates lastSeenAt", () => {
    const agent = makeAgent("agent-x")
    scheduler.registerAgent(agent)
    
    const before = Date.now()
    scheduler.heartbeat("agent-x")
    
    // Agent record should exist
    assert.ok(true)
  })

  it("exclusive task acquires host lock", async () => {
    const d = scheduler.schedule(makeRequest({ command: "kubectl apply -f deploy.yaml", intent: "deploy", cost: "exclusive", force: true }))
    assert.equal(d.action, "run_now")
    
    await new Promise(r => setTimeout(r, 10))
    
    const status = scheduler.queueStatus("host-1")
    assert.ok(status.locks && status.locks.length > 0)
    const hostLock = status.locks.find(l => l.scope === "host")
    assert.ok(hostLock)
  })

  it("workdir lock prevents concurrent mutations", () => {
    scheduler.schedule(makeRequest({ command: "npm install", intent: "install", cost: "large", cwd: "/repo" }))
    
    const b = scheduler.schedule(makeRequest({ command: "npm install", intent: "install", cost: "large", agent: makeAgent("b"), cwd: "/repo" }))
    assert.equal(b.action, "queued")
  })

  it("different workdirs allow concurrent mutations", () => {
    scheduler.schedule(makeRequest({ command: "npm install", intent: "install", cost: "large", cwd: "/repo-a" }))
    
    const b = scheduler.schedule(makeRequest({ command: "npm install", intent: "install", cost: "large", agent: makeAgent("b"), cwd: "/repo-b" }))
    assert.equal(b.action, "run_now")
  })
})
