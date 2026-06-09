import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { SchedulerService } from "../scheduler/scheduler-service.js"
import { PersistenceStore } from "../scheduler/persistence-store.js"
import { OutputStore } from "../scheduler/output-store.js"
import { EventLog } from "../scheduler/event-log.js"
import { LockManager } from "../scheduler/lock-manager.js"
import type { ScheduleRequest, AgentIdentity, HostIdentity, ScheduledTask, TaskRunner } from "../scheduler/types.js"
import { mkdtempSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

function makeAgent(id: string): AgentIdentity {
  return { id, name: `agent-${id}`, clientType: "mcp" }
}

function makeHost(id = "host-1"): HostIdentity {
  return { id, profileKey: `pk-${id}`, targetHost: "target.example.com", targetUser: "root", displayName: "target" }
}

function makeRequest(overrides: Partial<ScheduleRequest> & { agent?: AgentIdentity; host?: HostIdentity } = {}): ScheduleRequest {
  return {
    agent: overrides.agent ?? makeAgent("a1"),
    host: overrides.host ?? makeHost(),
    sessionId: "sess-1",
    command: overrides.command ?? "echo ok",
    scheduler: overrides.scheduler ?? "auto",
    ...overrides,
  }
}

class TrackRunner implements TaskRunner {
  started: string[] = []
  finishOrder: string[] = []
  private pending = new Map<string, (result: { code: number; stdout: string; stderr: string; signal?: string }) => void>()
  private startBarrier?: Promise<void>
  private resolveStartBarrier?: () => void

  setStartBarrier(count: number) {
    let arrived = 0
    this.startBarrier = new Promise(resolve => {
      this.resolveStartBarrier = () => {
        arrived++
        if (arrived >= count) resolve()
      }
    })
  }

  async start(task: ScheduledTask): Promise<{ code: number; stdout: string; stderr: string; signal?: string }> {
    this.started.push(task.id)
    if (this.resolveStartBarrier) this.resolveStartBarrier()
    return new Promise(resolve => {
      this.pending.set(task.id, (result) => resolve(result))
    })
  }

  startBackground(task: ScheduledTask, onOutput: (stdout: string, stderr: string) => void, onClose: (code: number, signal?: string) => void): void {}

  cancel(_task: ScheduledTask): boolean { return true }

  finish(taskId: string, result: { code: number; stdout: string; stderr: string; signal?: string } = { code: 0, stdout: "", stderr: "" }) {
    const fn = this.pending.get(taskId)
    if (fn) {
      this.pending.delete(taskId)
      this.finishOrder.push(taskId)
      fn(result)
    }
  }
}

describe("Concurrency Tests", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "concurrency-test-"))
  })

  describe("concurrent schedule calls from same host", () => {
    it("multiple tiny tasks from different agents all run_now concurrently", () => {
      const persistence = new PersistenceStore(join(tmpDir, "p1"))
      const runner = new TrackRunner()
      const s = new SchedulerService({ persistence, runner, outputStore: new OutputStore(join(tmpDir, "o1")), eventLog: new EventLog(join(tmpDir, "events-o1")) })

      const results: { action: string }[] = []
      for (let i = 0; i < 20; i++) {
        results.push(s.schedule(makeRequest({
          command: `rg pattern${i} src`,
          cost: "tiny",
          agent: makeAgent(`agent-${i}`),
        })))
      }

      assert.ok(results.every(r => r.action === "run_now"), "All tiny tasks should run immediately")
      assert.equal(runner.started.length, 20)
    })

    it("multiple large tasks serialize correctly with concurrent calls", () => {
      const persistence = new PersistenceStore(join(tmpDir, "p2"))
      const runner = new TrackRunner()
      const s = new SchedulerService({ persistence, runner, outputStore: new OutputStore(join(tmpDir, "o2")), eventLog: new EventLog(join(tmpDir, "events-o2")), maxLargeRunning: 1, maxTotalRunning: 4 })

      const results: { action: string; taskId?: string }[] = []
      for (let i = 0; i < 10; i++) {
        results.push(s.schedule(makeRequest({
          command: "npm test",
          intent: "test",
          cost: "large",
          agent: makeAgent(`agent-${i}`),
        })))
      }

      const runNow = results.filter(r => r.action === "run_now")
      const queued = results.filter(r => r.action === "queued")
      assert.equal(runNow.length, 1, "Only 1 large should run at a time")
      assert.equal(queued.length, 9, "Rest should be queued")

      assert.equal(runner.started.length, 1)
    })

    it("mixed cost tasks from multiple agents maintain correct admission", () => {
      const persistence = new PersistenceStore(join(tmpDir, "p3"))
      const runner = new TrackRunner()
      const s = new SchedulerService({ persistence, runner, outputStore: new OutputStore(join(tmpDir, "o3")), maxLargeRunning: 1, maxTotalRunning: 4 })

      s.schedule(makeRequest({ command: "npm test", cost: "large", agent: makeAgent("a1") }))
      s.schedule(makeRequest({ command: "rg foo", cost: "tiny", agent: makeAgent("a2") }))
      s.schedule(makeRequest({ command: "cat file", cost: "tiny", agent: makeAgent("a3") }))
      s.schedule(makeRequest({ command: "npm build", cost: "large", agent: makeAgent("a4") }))

      assert.equal(runner.started.length, 3, "Large + 2 tiny should run")
      assert.ok(runner.started.includes("t_" + s.getTask(runner.started[0])?.id?.slice(2)))
    })
  })

  describe("lock contention", () => {
    it("concurrent workdir lock acquisition by different agents is mutually exclusive", () => {
      const lm = new LockManager()
      const results: (string | null)[] = []

      for (let i = 0; i < 10; i++) {
        const lock = lm.acquire("workdir", "/repo", "host-1", `agent-${i}`, `task-${i}`)
        results.push(lock ? lock.id : null)
      }

      const acquired = results.filter(r => r !== null)
      assert.equal(acquired.length, 1, "Only first agent should acquire workdir lock")
    })

    it("host lock blocks exclusive tasks from different agents", () => {
      const lm = new LockManager()
      const lock1 = lm.acquire("host", "host-1", "host-1", "agent-1", "task-1")
      assert.ok(lock1)

      const lock2 = lm.acquire("host", "host-1", "host-1", "agent-2", "task-2")
      assert.equal(lock2, null, "Second agent cannot acquire host lock")
    })

    it("same agent can renew its own lock", () => {
      const lm = new LockManager()
      const lock1 = lm.acquire("workdir", "/repo", "host-1", "agent-1", "task-1")
      assert.ok(lock1)

      const lock2 = lm.acquire("workdir", "/repo", "host-1", "agent-1", "task-1")
      assert.ok(lock2)
      assert.equal(lock1!.id, lock2!.id, "Same lock ID on renewal")
    })

    it("lock release frees resource for waiting agent", () => {
      const lm = new LockManager()
      const lock1 = lm.acquire("workdir", "/repo", "host-1", "agent-1", "task-1")
      assert.ok(lock1)

      const lock2 = lm.acquire("workdir", "/repo", "host-1", "agent-2", "task-2")
      assert.equal(lock2, null)

      lm.release(lock1!.id)
      const lock3 = lm.acquire("workdir", "/repo", "host-1", "agent-2", "task-2")
      assert.ok(lock3)
    })

    it("releaseForTask cleans up all locks for a task", () => {
      const lm = new LockManager()
      lm.acquire("host", "host-1", "host-1", "agent-1", "task-1")
      lm.acquire("workdir", "/repo-a", "host-1", "agent-1", "task-1")
      lm.acquire("workdir", "/repo-b", "host-1", "agent-1", "task-1")

      assert.equal(lm.getLocksForHost("host-1").length, 3)
      lm.releaseForTask("task-1")
      assert.equal(lm.getLocksForHost("host-1").length, 0)
    })

    it("concurrent mixed scope locks on same host do not interfere", () => {
      const lm = new LockManager()
      const hostLock = lm.acquire("host", "host-1", "host-1", "agent-1", "task-1")
      const workdirLock = lm.acquire("workdir", "/repo", "host-1", "agent-2", "task-2")

      assert.ok(hostLock)
      assert.ok(workdirLock)
      assert.notEqual(hostLock!.id, workdirLock!.id)
    })
  })

  describe("waitTask concurrent resolution", () => {
    it("multiple waiters on same task all resolve when task finishes", async () => {
      const persistence = new PersistenceStore(join(tmpDir, "w1"))
      const runner = new TrackRunner()
      const s = new SchedulerService({ persistence, runner, outputStore: new OutputStore(join(tmpDir, "wo1")) })

      const d = s.schedule(makeRequest({ command: "echo done" }))
      assert.equal(d.action, "run_now")

      const waitResults: string[] = []
      const promises: Promise<void>[] = []
      for (let i = 0; i < 5; i++) {
        promises.push(
          s.waitTask(d.taskId!, 5000).then(task => {
            waitResults.push(task.status)
          })
        )
      }

      await new Promise(r => setTimeout(r, 20))
      runner.finish(d.taskId!, { code: 0, stdout: "done\n", stderr: "" })
      await Promise.all(promises)

      assert.equal(waitResults.length, 5)
      assert.ok(waitResults.every(s => s === "completed"))
    })

    it("waitTask timeout returns current task state", async () => {
      const persistence = new PersistenceStore(join(tmpDir, "w2"))
      const runner = new TrackRunner()
      const s = new SchedulerService({ persistence, runner, outputStore: new OutputStore(join(tmpDir, "wo2")) })

      const d = s.schedule(makeRequest({ command: "sleep 999" }))
      assert.equal(d.action, "run_now")

      const task = await s.waitTask(d.taskId!, 50)
      assert.equal(task.status, "running")

      runner.finish(d.taskId!, { code: 0, stdout: "", stderr: "" })
    })

    it("waitTask on queued task returns running state on timeout after promotion", async () => {
      const persistence = new PersistenceStore(join(tmpDir, "w3"))
      const runner = new TrackRunner()
      const s = new SchedulerService({ persistence, runner, outputStore: new OutputStore(join(tmpDir, "wo3")), maxLargeRunning: 1 })

      const a = s.schedule(makeRequest({ command: "npm test", cost: "large", agent: makeAgent("a1") }))
      const b = s.schedule(makeRequest({ command: "npm test", cost: "large", agent: makeAgent("a2") }))
      assert.equal(a.action, "run_now")
      assert.equal(b.action, "queued")

      const waitPromise = s.waitTask(b.taskId!, 1000)
      runner.finish(a.taskId!, { code: 0, stdout: "", stderr: "" })

      const waited = await waitPromise
      assert.equal(waited.status, "running")
    })

    it("cancelTask resolves all waiters", async () => {
      const persistence = new PersistenceStore(join(tmpDir, "w4"))
      const runner = new TrackRunner()
      const s = new SchedulerService({ persistence, runner, outputStore: new OutputStore(join(tmpDir, "wo4")), maxLargeRunning: 1 })

      s.schedule(makeRequest({ command: "npm test", cost: "large", agent: makeAgent("a1") }))
      const b = s.schedule(makeRequest({ command: "npm test", cost: "large", agent: makeAgent("a2") }))
      assert.equal(b.action, "queued")

      const waitResults: string[] = []
      const promises: Promise<void>[] = []
      for (let i = 0; i < 3; i++) {
        promises.push(
          s.waitTask(b.taskId!, 1000).then(task => {
            waitResults.push(task.status)
          })
        )
      }

      await new Promise(r => setTimeout(r, 10))
      s.dequeueTask(b.taskId!)
      await Promise.all(promises)

      assert.equal(waitResults.length, 3)
      assert.ok(waitResults.every(st => st === "cancelled"))
    })

    it("dequeueTask resolves queued task waiters immediately", async () => {
      const persistence = new PersistenceStore(join(tmpDir, "w5"))
      const runner = new TrackRunner()
      const s = new SchedulerService({ persistence, runner, outputStore: new OutputStore(join(tmpDir, "wo5")), maxLargeRunning: 1 })

      s.schedule(makeRequest({ command: "npm test", cost: "large", agent: makeAgent("a1") }))
      const b = s.schedule(makeRequest({ command: "npm test", cost: "large", agent: makeAgent("a2") }))
      assert.equal(b.action, "queued")

      const waited = s.waitTask(b.taskId!, 1000)
      await new Promise(r => setTimeout(r, 10))
      assert.ok(s.dequeueTask(b.taskId!))

      const task = await waited
      assert.equal(task.status, "cancelled")
    })
  })

  describe("queue operations under concurrent conditions", () => {
    it("dequeue while another task finishes promotes correctly", async () => {
      const persistence = new PersistenceStore(join(tmpDir, "q1"))
      const runner = new TrackRunner()
      const s = new SchedulerService({ persistence, runner, outputStore: new OutputStore(join(tmpDir, "qo1")), maxLargeRunning: 1 })

      const a = s.schedule(makeRequest({ command: "npm test", cost: "large", agent: makeAgent("a1") }))
      const b = s.schedule(makeRequest({ command: "npm test", cost: "large", agent: makeAgent("a2") }))
      const c = s.schedule(makeRequest({ command: "npm test", cost: "large", agent: makeAgent("a3") }))
      assert.equal(b.action, "queued")
      assert.equal(c.action, "queued")

      s.dequeueTask(b.taskId!)
      runner.finish(a.taskId!, { code: 0, stdout: "", stderr: "" })
      await new Promise(r => setTimeout(r, 20))

      const taskC = s.getTask(c.taskId!)
      assert.equal(taskC?.status, "running", "C should be promoted after A finishes and B is dequeued")
    })

    it("cancelTask on running task frees slot for queued", async () => {
      const persistence = new PersistenceStore(join(tmpDir, "q2"))
      const runner = new TrackRunner()
      const s = new SchedulerService({ persistence, runner, outputStore: new OutputStore(join(tmpDir, "qo2")), maxLargeRunning: 1 })

      const a = s.schedule(makeRequest({ command: "npm test", cost: "large", agent: makeAgent("a1") }))
      const b = s.schedule(makeRequest({ command: "npm test", cost: "large", agent: makeAgent("a2") }))
      assert.equal(b.action, "queued")

      const cancelled = s.cancelTask(a.taskId!)
      assert.ok(cancelled)
      await new Promise(r => setTimeout(r, 20))

      assert.equal(s.getTask(a.taskId!)?.status, "cancelled")
      assert.equal(s.getTask(b.taskId!)?.status, "running")
      assert.ok(runner.started.includes(b.taskId!), "Queued task should be started after cancelling running task")
    })

    it("late runner completion does not overwrite cancelled running task", async () => {
      const persistence = new PersistenceStore(join(tmpDir, "q2-late"))
      const runner = new TrackRunner()
      const s = new SchedulerService({ persistence, runner, outputStore: new OutputStore(join(tmpDir, "qo2-late")), maxLargeRunning: 1 })

      const a = s.schedule(makeRequest({ command: "npm test", cost: "large", agent: makeAgent("a1") }))
      const b = s.schedule(makeRequest({ command: "npm test", cost: "large", agent: makeAgent("a2") }))
      assert.equal(b.action, "queued")

      assert.ok(s.cancelTask(a.taskId!))
      await new Promise(r => setTimeout(r, 20))
      assert.equal(s.getTask(a.taskId!)?.status, "cancelled")
      assert.equal(s.getTask(b.taskId!)?.status, "running")

      runner.finish(a.taskId!, { code: 0, stdout: "late success\n", stderr: "" })
      await new Promise(r => setTimeout(r, 20))

      assert.equal(s.getTask(a.taskId!)?.status, "cancelled")
      assert.equal(s.getTask(a.taskId!)?.exitCode, undefined)
    })

    it("queueStatus reflects concurrent state correctly", () => {
      const persistence = new PersistenceStore(join(tmpDir, "q3"))
      const runner = new TrackRunner()
      const s = new SchedulerService({ persistence, runner, outputStore: new OutputStore(join(tmpDir, "qo3")), maxLargeRunning: 1 })

      s.schedule(makeRequest({ command: "npm test", cost: "large", agent: makeAgent("a1") }))
      s.schedule(makeRequest({ command: "npm test", cost: "large", agent: makeAgent("a2") }))
      s.schedule(makeRequest({ command: "npm test", cost: "large", agent: makeAgent("a3") }))

      const status = s.queueStatus()
      assert.equal(status.running.length, 1)
      assert.equal(status.queued.length, 2)
      assert.ok(status.limits.maxLargeRunning === 1)
    })
  })

  describe("output store concurrent append", () => {
    it("interleaved appends from multiple tasks do not corrupt", () => {
      const store = new OutputStore(join(tmpDir, "out-conc"))
      const taskCount = 10
      const linesPerTask = 100

      for (let t = 0; t < taskCount; t++) {
        store.create(`task-${t}`)
      }

      let expectedBytes = 0
      for (let line = 0; line < linesPerTask; line++) {
        for (let t = 0; t < taskCount; t++) {
          const data = `line-${String(line).padStart(4, "0")}\n`
          store.appendStdout(`task-${t}`, data)
          if (t === 0) expectedBytes += Buffer.byteLength(data)
        }
      }

      for (let t = 0; t < taskCount; t++) {
        const entry = store.get(`task-${t}`)
        assert.ok(entry)
        assert.equal(entry.stdoutBytes, expectedBytes)
      }
    })

    it("concurrent stdout and stderr append to same task", () => {
      const store = new OutputStore(join(tmpDir, "out-std"))
      store.create("shared-task")

      for (let i = 0; i < 100; i++) {
        store.appendStdout("shared-task", `out-${i}\n`)
        store.appendStderr("shared-task", `err-${i}\n`)
      }

      const entry = store.get("shared-task")
      assert.ok(entry)
      assert.ok(entry.stdoutBytes > 0)
      assert.ok(entry.stderrBytes > 0)
    })
  })

  describe("scheduler with exclusive task blocking", () => {
    it("exclusive task blocks all subsequent tiny tasks", () => {
      const persistence = new PersistenceStore(join(tmpDir, "ex1"))
      const runner = new TrackRunner()
      const s = new SchedulerService({ persistence, runner, outputStore: new OutputStore(join(tmpDir, "exo1")) })

      s.schedule(makeRequest({
        command: "kubectl apply -f deploy.yaml",
        intent: "deploy",
        cost: "exclusive",
        force: true,
        agent: makeAgent("deployer"),
      }))

      const results: { action: string }[] = []
      for (let i = 0; i < 5; i++) {
        results.push(s.schedule(makeRequest({
          command: "rg foo src",
          cost: "tiny",
          agent: makeAgent(`reader-${i}`),
        })))
      }

      assert.ok(results.every(r => r.action === "queued"), "All tiny tasks should be queued behind exclusive")
    })

    it("after exclusive finishes, queued tasks are pumped", async () => {
      const persistence = new PersistenceStore(join(tmpDir, "ex2"))
      const runner = new TrackRunner()
      const s = new SchedulerService({ persistence, runner, outputStore: new OutputStore(join(tmpDir, "exo2")) })

      const d = s.schedule(makeRequest({
        command: "kubectl apply -f deploy.yaml",
        intent: "deploy",
        cost: "exclusive",
        force: true,
        agent: makeAgent("deployer"),
      }))

      const d2 = s.schedule(makeRequest({
        command: "rg foo src",
        cost: "tiny",
        agent: makeAgent("reader"),
      }))
      assert.equal(d2.action, "queued")

      runner.finish(d.taskId!, { code: 0, stdout: "", stderr: "" })
      await new Promise(r => setTimeout(r, 20))

      const task2 = s.getTask(d2.taskId!)
      assert.equal(task2?.status, "running")
    })

    it("cancelling exclusive task releases host lock and pumps queued tiny task", async () => {
      const persistence = new PersistenceStore(join(tmpDir, "ex-cancel"))
      const runner = new TrackRunner()
      const s = new SchedulerService({ persistence, runner, outputStore: new OutputStore(join(tmpDir, "exo-cancel")) })

      const exclusive = s.schedule(makeRequest({
        command: "kubectl apply -f deploy.yaml",
        intent: "deploy",
        cost: "exclusive",
        force: true,
        agent: makeAgent("deployer"),
      }))

      const reader = s.schedule(makeRequest({
        command: "rg foo src",
        cost: "tiny",
        agent: makeAgent("reader"),
      }))
      assert.equal(reader.action, "queued")
      assert.ok(s.queueStatus("host-1").locks?.some(lock => lock.ownerTaskId === exclusive.taskId))

      assert.ok(s.cancelTask(exclusive.taskId!))
      await new Promise(r => setTimeout(r, 20))

      const status = s.queueStatus("host-1")
      assert.equal(status.locks?.some(lock => lock.ownerTaskId === exclusive.taskId), false)
      assert.equal(s.getTask(reader.taskId!)?.status, "running")
    })
  })

  describe("scheduler pumpQueue edge cases", () => {
    it("multiple queued tasks promoted in FIFO order", async () => {
      const persistence = new PersistenceStore(join(tmpDir, "fifo"))
      const runner = new TrackRunner()
      const s = new SchedulerService({ persistence, runner, outputStore: new OutputStore(join(tmpDir, "fifo-o")), maxLargeRunning: 1 })

      const a = s.schedule(makeRequest({ command: "npm test", cost: "large", agent: makeAgent("a1") }))
      const b = s.schedule(makeRequest({ command: "npm test", cost: "large", agent: makeAgent("b") }))
      const c = s.schedule(makeRequest({ command: "npm test", cost: "large", agent: makeAgent("c") }))
      const d = s.schedule(makeRequest({ command: "npm test", cost: "large", agent: makeAgent("d") }))

      assert.equal(b.queuePosition, 1)
      assert.equal(c.queuePosition, 2)
      assert.equal(d.queuePosition, 3)

      runner.finish(a.taskId!, { code: 0, stdout: "", stderr: "" })
      await new Promise(r => setTimeout(r, 20))

      const taskB = s.getTask(b.taskId!)
      assert.equal(taskB?.status, "running")
      assert.equal(taskB?.queuePosition, undefined)

      const taskC = s.getTask(c.taskId!)
      assert.equal(taskC?.status, "queued")
      assert.equal(taskC?.queuePosition, 1)

      const taskD = s.getTask(d.taskId!)
      assert.equal(taskD?.status, "queued")
      assert.equal(taskD?.queuePosition, 2)
    })

    it("failed task does not block queue pump", async () => {
      const persistence = new PersistenceStore(join(tmpDir, "fail"))
      const runner = new TrackRunner()
      const s = new SchedulerService({ persistence, runner, outputStore: new OutputStore(join(tmpDir, "fail-o")), maxLargeRunning: 1 })

      const a = s.schedule(makeRequest({ command: "npm test", cost: "large", agent: makeAgent("a1") }))
      const b = s.schedule(makeRequest({ command: "npm test", cost: "large", agent: makeAgent("b") }))
      assert.equal(b.action, "queued")

      runner.finish(a.taskId!, { code: 1, stdout: "", stderr: "error" })
      await new Promise(r => setTimeout(r, 20))

      const taskA = s.getTask(a.taskId!)
      assert.equal(taskA?.status, "failed")

      const taskB = s.getTask(b.taskId!)
      assert.equal(taskB?.status, "running", "Queue should still pump after failed task")
    })
  })
})
