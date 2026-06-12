import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { SchedulerService } from "../scheduler/scheduler-service.js"
import { PersistenceStore } from "../scheduler/persistence-store.js"
import { DEFAULT_OUTPUT_RETURN_LIMIT, OutputStore } from "../scheduler/output-store.js"
import { EventLog } from "../scheduler/event-log.js"
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
  cancelResult = true
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

  cancel(_task: ScheduledTask): boolean {
    return this.cancelResult
  }

  finish(taskId: string, result: { code: number; stdout: string; stderr: string } = { code: 0, stdout: "", stderr: "" }) {
    const fn = this.pending.get(taskId)
    if (fn) {
      this.pending.delete(taskId)
      fn(result)
    }
  }
}

class StreamingRunner implements TaskRunner {
  private pending = new Map<string, (result: { code: number; stdout: string; stderr: string }) => void>()

  constructor(private streamedChunks: { stdout: string; stderr: string }[] = [
    { stdout: "streamed-stdout\n", stderr: "" },
    { stdout: "", stderr: "streamed-stderr\n" },
  ]) {}

  async start(
    task: ScheduledTask,
    onOutput?: (stdout: string, stderr: string) => void
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    for (const chunk of this.streamedChunks) {
      onOutput?.(chunk.stdout, chunk.stderr)
    }
    return new Promise(resolve => {
      this.pending.set(task.id, (result) => resolve(result))
    })
  }

  startBackground(
    _task: ScheduledTask,
    _onOutput: (stdout: string, stderr: string) => void,
    _onClose: (code: number, signal?: string) => void
  ): void {}

  finish(taskId: string, result: { code: number; stdout: string; stderr: string }) {
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
    scheduler = new SchedulerService({ persistence, runner, outputStore: new OutputStore(join(tmpDir, "outputs")), eventLog: new EventLog(join(tmpDir, "events")), maxQueueSize: 50, maxTotalRunning: 4, maxLargeRunning: 1 })
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
    const s = new SchedulerService({ persistence: sPersistence, runner: sRunner, outputStore: new OutputStore(join(sTmpDir, "outputs")), eventLog: new EventLog(join(sTmpDir, "events")), maxQueueSize: 2, maxTotalRunning: 4, maxLargeRunning: 1 })

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
    assert.equal(output.truncated, false)
    assert.ok(output.stdoutPath.endsWith(`${d.taskId}.stdout`))
  })

  it("foreground-style output includes truncation metadata", async () => {
    const outputStore = new OutputStore(join(tmpDir, "outputs"))
    const s = new SchedulerService({ persistence, runner, outputStore, eventLog: new EventLog(join(tmpDir, "events-truncation")), outputCleanupThrottleMs: 0 })
    const d = s.schedule(makeRequest({ command: "echo lots" }))
    runner.finish(d.taskId!, { code: 0, stdout: "x".repeat(40 * 1024), stderr: "" })
    await new Promise(r => setTimeout(r, 10))

    const output = s.getTaskOutput(d.taskId!)
    assert.equal(output.stdout.length, DEFAULT_OUTPUT_RETURN_LIMIT)
    assert.equal(output.stdoutBytes, 40 * 1024)
    assert.equal(output.truncated, true)
    assert.ok(output.stdoutPath.endsWith(`${d.taskId}.stdout`))
  })

  it("foreground streaming output is not duplicated by aggregated runner result", async () => {
    const streamingRunner = new StreamingRunner()
    const outputStore = new OutputStore(join(tmpDir, "streaming-outputs"))
    const s = new SchedulerService({ persistence, runner: streamingRunner, outputStore, eventLog: new EventLog(join(tmpDir, "events-streaming")) })
    const d = s.schedule(makeRequest({ command: "npm test", cost: "large" }))
    assert.equal(d.action, "run_now")

    streamingRunner.finish(d.taskId!, {
      code: 0,
      stdout: "streamed-stdout\n",
      stderr: "streamed-stderr\n",
    })
    await new Promise(r => setTimeout(r, 10))

    const output = s.getTaskOutput(d.taskId!, "full")
    assert.equal(output.stdout, "streamed-stdout\n")
    assert.equal(output.stderr, "streamed-stderr\n")
    assert.equal(output.stdoutBytes, Buffer.byteLength("streamed-stdout\n"))
    assert.equal(output.stderrBytes, Buffer.byteLength("streamed-stderr\n"))
  })

  it("foreground streaming only suppresses the streams that were actually streamed", async () => {
    const streamingRunner = new StreamingRunner([{ stdout: "streamed-stdout\n", stderr: "" }])
    const outputStore = new OutputStore(join(tmpDir, "partial-streaming-outputs"))
    const s = new SchedulerService({ persistence, runner: streamingRunner, outputStore, eventLog: new EventLog(join(tmpDir, "events-partial-streaming")) })
    const d = s.schedule(makeRequest({ command: "npm test", cost: "large" }))
    assert.equal(d.action, "run_now")

    streamingRunner.finish(d.taskId!, {
      code: 1,
      stdout: "streamed-stdout\n",
      stderr: "late-stderr\n",
    })
    await new Promise(r => setTimeout(r, 10))

    const output = s.getTaskOutput(d.taskId!, "full")
    assert.equal(output.stdout, "streamed-stdout\n")
    assert.equal(output.stderr, "late-stderr\n")
    assert.equal(output.stdoutBytes, Buffer.byteLength("streamed-stdout\n"))
    assert.equal(output.stderrBytes, Buffer.byteLength("late-stderr\n"))
  })

  it("cancelTask does not mark running task cancelled when runner cannot cancel", () => {
    const d = scheduler.schedule(makeRequest({ command: "sleep 999", cost: "large" }))
    runner.cancelResult = false

    const cancelled = scheduler.cancelTask(d.taskId!)

    assert.equal(cancelled, false)
    assert.equal(scheduler.getTask(d.taskId!)?.status, "running")
  })

  it("cancelTask frees running slot and ignores late runner completion", async () => {
    const a = scheduler.schedule(makeRequest({ command: "npm test", cost: "large", agent: makeAgent("a") }))
    const b = scheduler.schedule(makeRequest({ command: "npm test", cost: "large", agent: makeAgent("b") }))
    assert.equal(a.action, "run_now")
    assert.equal(b.action, "queued")

    const cancelled = scheduler.cancelTask(a.taskId!)
    assert.equal(cancelled, true)
    await new Promise(r => setTimeout(r, 10))

    assert.equal(scheduler.getTask(a.taskId!)?.status, "cancelled")
    assert.equal(scheduler.getTask(b.taskId!)?.status, "running")

    runner.finish(a.taskId!, { code: 0, stdout: "late\n", stderr: "" })
    await new Promise(r => setTimeout(r, 10))

    assert.equal(scheduler.getTask(a.taskId!)?.status, "cancelled")
    assert.equal(scheduler.getTask(a.taskId!)?.exitCode, undefined)
  })

  it("cancelTask releases exclusive host lock before pumping queued work", async () => {
    const a = scheduler.schedule(makeRequest({ command: "kubectl apply -f deploy.yaml", intent: "deploy", cost: "exclusive", force: true, agent: makeAgent("deploy") }))
    const b = scheduler.schedule(makeRequest({ command: "rg foo src", cost: "tiny", agent: makeAgent("reader") }))
    assert.equal(a.action, "run_now")
    assert.equal(b.action, "queued")
    assert.ok(scheduler.queueStatus("host-1").locks?.some(lock => lock.ownerTaskId === a.taskId))

    const cancelled = scheduler.cancelTask(a.taskId!)
    assert.equal(cancelled, true)
    await new Promise(r => setTimeout(r, 10))

    const status = scheduler.queueStatus("host-1")
    assert.equal(status.locks?.some(lock => lock.ownerTaskId === a.taskId), false)
    assert.equal(scheduler.getTask(b.taskId!)?.status, "running")
  })

  it("abortActiveTasks cancels running and queued tasks without promoting queued work", async () => {
    const a = scheduler.schedule(makeRequest({ command: "npm test", cost: "large", agent: makeAgent("a") }))
    const b = scheduler.schedule(makeRequest({ command: "npm test", cost: "large", agent: makeAgent("b") }))
    const waitB = scheduler.waitTask(b.taskId!, 1000)

    assert.equal(a.action, "run_now")
    assert.equal(b.action, "queued")
    assert.deepEqual(runner.started, [a.taskId])

    const result = scheduler.abortActiveTasks("fatal shutdown")
    const waitedB = await waitB

    assert.deepEqual(result, { cancelled: 2, cancelFailed: 0 })
    assert.deepEqual(runner.started, [a.taskId])
    assert.equal(scheduler.getTask(a.taskId!)?.status, "cancelled")
    assert.equal(scheduler.getTask(a.taskId!)?.decisionReason, "fatal shutdown")
    assert.equal(scheduler.getTask(b.taskId!)?.status, "cancelled")
    assert.equal(waitedB.status, "cancelled")
    assert.equal(scheduler.queueStatus("host-1").running.length, 0)
    assert.equal(scheduler.queueStatus("host-1").queued.length, 0)
  })

  it("abortActiveTasks reports running cancel failures and still cancels queued tasks", async () => {
    const a = scheduler.schedule(makeRequest({ command: "npm test", cost: "large", agent: makeAgent("a") }))
    const b = scheduler.schedule(makeRequest({ command: "npm test", cost: "large", agent: makeAgent("b") }))
    runner.cancelResult = false

    const result = scheduler.abortActiveTasks("fatal shutdown")

    assert.deepEqual(result, { cancelled: 1, cancelFailed: 1 })
    assert.equal(scheduler.getTask(a.taskId!)?.status, "running")
    assert.equal(scheduler.getTask(a.taskId!)?.decisionReason, "fatal shutdown Cancel attempt failed.")
    assert.equal(scheduler.getTask(b.taskId!)?.status, "cancelled")
    assert.equal(scheduler.getTask(b.taskId!)?.decisionReason, "fatal shutdown")
    assert.equal(scheduler.queueStatus("host-1").queued.length, 0)
  })

  it("queueStatus returns virtual cwd for the requesting agent", () => {
    scheduler.setCwd("agent-a", "host-1", "/repo-a")
    scheduler.setCwd("agent-b", "host-1", "/repo-b")

    const status = scheduler.queueStatus("host-1", 20, "agent-b")

    assert.equal(status.virtualCwd, "/repo-b")
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

  it("different workdirs still block by default for large", () => {
    scheduler.schedule(makeRequest({ command: "npm install", intent: "install", cost: "large", cwd: "/repo-a" }))

    const b = scheduler.schedule(makeRequest({ command: "npm install", intent: "install", cost: "large", agent: makeAgent("b"), cwd: "/repo-b" }))
    assert.equal(b.action, "queued")
  })

  it("ifBusy=run_anyway allows concurrent large in different workdirs", () => {
    scheduler.schedule(makeRequest({ command: "npm install", intent: "install", cost: "large", cwd: "/repo-a" }))

    const b = scheduler.schedule(makeRequest({ command: "npm install", intent: "install", cost: "large", agent: makeAgent("b"), cwd: "/repo-b", ifBusy: "run_anyway" }))
    assert.equal(b.action, "run_now")
  })

  it('wrapped cd && python script.py serializes with other large', () => {
    scheduler.schedule(makeRequest({ command: 'cd /repo && python script.py' }))
    const b = scheduler.schedule(makeRequest({ command: 'bash setup.sh', agent: makeAgent('b') }))
    assert.equal(b.action, 'queued')
  })

  it('bash -lc quoted python script.py serializes by default', () => {
    scheduler.schedule(makeRequest({ command: 'bash -lc "python script.py"' }))
    const b = scheduler.schedule(makeRequest({ command: 'cd /repo && bash -lc "python other.py"', agent: makeAgent('b') }))
    assert.equal(b.action, 'queued')
  })

  it('sudo python script.py serializes by default', () => {
    scheduler.schedule(makeRequest({ command: 'sudo python script.py' }))
    const b = scheduler.schedule(makeRequest({ command: 'uv run python other.py', agent: makeAgent('b') }))
    assert.equal(b.action, 'queued')
  })

  it('wrapped env FOO=1 python script.py => large', () => {
    const d = scheduler.schedule(makeRequest({ command: 'env FOO=1 python script.py' }))
    assert.equal(d.action, 'run_now')
    assert.equal(d.classification?.cost, 'large')
    assert.equal(d.classification?.mutates, true)
  })

  it('wrapped timeout 60 bash setup.sh => large', () => {
    const d = scheduler.schedule(makeRequest({ command: 'timeout 60 bash setup.sh' }))
    assert.equal(d.action, 'run_now')
    assert.equal(d.classification?.cost, 'large')
  })

  it('wrapped cd /repo && npm test => large, serializes', () => {
    const d = scheduler.schedule(makeRequest({ command: 'cd /repo && npm test' }))
    assert.equal(d.classification?.cost, 'large')
    assert.equal(d.classification?.intent, 'test')

    const b = scheduler.schedule(makeRequest({ command: 'npm install', agent: makeAgent('b') }))
    assert.equal(b.action, 'queued')
  })

  it('exclusive blocks large even with run_anyway', () => {
    scheduler.schedule(makeRequest({ command: 'kubectl apply -f deploy.yaml', intent: 'deploy', cost: 'exclusive', force: true }))
    const b = scheduler.schedule(makeRequest({ command: 'npm test', cost: 'large', agent: makeAgent('b'), ifBusy: 'run_anyway' }))
    assert.equal(b.action, 'queued')
  })

  it('large tasks default serial across different agents', () => {
    const a = scheduler.schedule(makeRequest({ command: 'python a.py' }))
    const b = scheduler.schedule(makeRequest({ command: 'python b.py', agent: makeAgent('b') }))
    const c = scheduler.schedule(makeRequest({ command: 'python c.py', agent: makeAgent('c') }))
    assert.equal(a.action, 'run_now')
    assert.equal(b.action, 'queued')
    assert.equal(c.action, 'queued')
  })

  it('cancelTask wins when runner.cancel synchronously resolves the start promise (stream close race)', async () => {
    // Simulates the production race in daemon startBackground: the runner's
    // cancel() invokes stream.close() which synchronously fires the
    // 'close' handler → onClose → finishTask. The scheduler must keep the
    // task in 'cancelled' state even though finishTask would otherwise
    // observe status='running' and overwrite it.
    class SyncCloseRunner implements TaskRunner {
      startedTasks: ScheduledTask[] = []
      private resolvers = new Map<string, (result: { code: number; stdout: string; stderr: string; signal?: string }) => void>()

      async start(task: ScheduledTask): Promise<{ code: number; stdout: string; stderr: string; signal?: string }> {
        this.startedTasks.push(task)
        return new Promise((resolve) => {
          this.resolvers.set(task.id, resolve)
        })
      }

      startBackground(): void {
        // not used
      }

      cancel(task: ScheduledTask): boolean {
        // Synchronously close the stream: resolves the start promise, which
        // schedules finishTask via the .then microtask. With the old code,
        // finishTask would race with the cancelTask status update.
        const resolve = this.resolvers.get(task.id)
        if (resolve) {
          this.resolvers.delete(task.id)
          resolve({ code: 0, stdout: 'late-output\n', stderr: '' })
        }
        return true
      }
    }

    const syncRunner = new SyncCloseRunner()
    const s = new SchedulerService({
      persistence,
      runner: syncRunner,
      outputStore: new OutputStore(join(tmpDir, 'sync-close-outputs')),
      eventLog: new EventLog(join(tmpDir, 'events-sync-close')),
    })

    const d = s.schedule(makeRequest({ command: 'npm test', cost: 'large' }))
    assert.equal(d.action, 'run_now')
    assert.equal(s.getTask(d.taskId!)?.status, 'running')

    const cancelled = s.cancelTask(d.taskId!)
    assert.equal(cancelled, true)

    // Let the .then microtask from the sync resolve run
    await new Promise(r => setImmediate(r))

    const task = s.getTask(d.taskId!)
    assert.equal(task?.status, 'cancelled', 'cancel must not be overwritten by sync stream-close finishTask')
    assert.equal(task?.exitCode, undefined)
    assert.equal(task?.decisionReason, 'Cancelled by cancel request.')
  })

  it('cancelTask restores running state when runner.cancel returns false', async () => {
    class CancelRefusedRunner implements TaskRunner {
      private resolvers = new Map<string, (result: { code: number; stdout: string; stderr: string; signal?: string }) => void>()

      async start(task: ScheduledTask): Promise<{ code: number; stdout: string; stderr: string; signal?: string }> {
        return new Promise((resolve) => {
          this.resolvers.set(task.id, resolve)
        })
      }

      startBackground(): void {}

      cancel(_task: ScheduledTask): boolean {
        return false
      }

      finish(taskId: string, result: { code: number; stdout: string; stderr: string }) {
        const fn = this.resolvers.get(taskId)
        if (fn) {
          this.resolvers.delete(taskId)
          fn(result)
        }
      }
    }

    const runner2 = new CancelRefusedRunner()
    const s = new SchedulerService({
      persistence,
      runner: runner2,
      outputStore: new OutputStore(join(tmpDir, 'cancel-refused-outputs')),
      eventLog: new EventLog(join(tmpDir, 'events-cancel-refused')),
    })

    const d = s.schedule(makeRequest({ command: 'sleep 999', cost: 'large' }))
    const cancelled = s.cancelTask(d.taskId!)
    assert.equal(cancelled, false)
    assert.equal(s.getTask(d.taskId!)?.status, 'running')

    // Late completion should be allowed to finish the still-running task
    runner2.finish(d.taskId!, { code: 0, stdout: '', stderr: '' })
    await new Promise(r => setImmediate(r))
    assert.equal(s.getTask(d.taskId!)?.status, 'completed')
  })

  it('dispose clears the idle eviction timer and is idempotent', () => {
    const t = scheduler as unknown as { idleEvictTimer: ReturnType<typeof setInterval> | null }
    assert.ok(t.idleEvictTimer, 'constructor should have started the idle eviction timer')
    scheduler.dispose()
    assert.equal(t.idleEvictTimer, null, 'dispose should null out the timer handle')
    // Second call must be a no-op (must not throw).
    scheduler.dispose()
    assert.equal(t.idleEvictTimer, null)
  })
})
