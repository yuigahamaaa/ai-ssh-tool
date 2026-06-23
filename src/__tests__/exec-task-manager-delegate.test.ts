/**
 * P1-3 Stage 2 / Task 2.1: ExecTaskManager.start() publishes the task
 * to the scheduler for unified state. The actual exec still happens
 * on the raw ssh2 Client (preserving the existing test surface) but
 * the scheduler's tasks Map now reflects the same task with the same
 * id, command, hostname, and final exit code.
 */

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "events"
import { existsSync, mkdtempSync, readdirSync, rmSync, mkdirSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { SchedulerService } from "../scheduler/scheduler-service.js"
import { PersistenceStore } from "../scheduler/persistence-store.js"
import { OutputStore } from "../scheduler/output-store.js"
import { EventLog } from "../scheduler/event-log.js"

// Override SSH_TOOL_DATA_DIR before importing exec-task-manager so its
// module-level getTaskStorageDir() picks up a temp dir.
const testDataDir = mkdtempSync(join(tmpdir(), "etm-delegate-"))
const origDataDir = process.env.SSH_TOOL_DATA_DIR
process.env.SSH_TOOL_DATA_DIR = testDataDir

function legacyTaskFiles(): string[] {
  const dir = join(testDataDir, "exec-tasks")
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : []
}

function instantRunner() {
  return {
    start: async () => ({ code: 0, stdout: "", stderr: "" }),
    startBackground: () => {},
  }
}

function makeSchedulerBridge(tmpDir: string): SchedulerService {
  return new SchedulerService({
    persistence: new PersistenceStore(tmpDir),
    runner: instantRunner(),
    outputStore: new OutputStore(join(tmpDir, "outputs")),
    eventLog: new EventLog(join(tmpDir, "events")),
  })
}

class FakeChannel extends EventEmitter {
  stderr = new EventEmitter()
  close(): void { this.emit("close", 0) }
}

class FakeClient {
  channel = new FakeChannel()
  exec(_cmd: string, cb: (err: Error | undefined, stream: FakeChannel) => void): void {
    setImmediate(() => cb(undefined, this.channel))
  }
}

class ThrowingClient {
  exec(): void {
    throw new Error("exec boom")
  }
}

describe("ExecTaskManager.start() publishes to scheduler", () => {
  let tmpDir: string
  let ExecTaskManager: typeof import("../exec-task-manager.js").ExecTaskManager
  const schedulers: SchedulerService[] = []

  function makeTrackedScheduler(): SchedulerService {
    const s = new SchedulerService({
      persistence: new PersistenceStore(tmpDir),
      runner: instantRunner(),
      outputStore: new OutputStore(join(tmpDir, "outputs")),
      eventLog: new EventLog(join(tmpDir, "events")),
    })
    schedulers.push(s)
    return s
  }

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "etm-delegate-"))
    mkdirSync(join(tmpDir, "outputs"), { recursive: true })
    const mod = await import(`../exec-task-manager.js?t=${Date.now()}`)
    ExecTaskManager = mod.ExecTaskManager
  })

  afterEach(() => {
    // Dispose all schedulers created in this test so the process can exit.
    for (const s of schedulers.splice(0)) s.dispose()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("registerExternal adds the task to the scheduler immediately", () => {
    const scheduler = makeTrackedScheduler()
    const mgr = new ExecTaskManager({ scheduler })
    // Use the public API: build a fake register call by routing through
    // the underlying scheduler (this is what start() does internally).
    scheduler.registerExternal({
      agent: { id: "etm", name: "etm", clientType: "internal" as const },
      host: { id: "h1", profileKey: "k", targetHost: "h1", targetUser: "u", displayName: "h1" },
      sessionId: "s1",
      command: "echo test",
      scheduler: "bypass",
    } as unknown as any)
    const listed = scheduler.listTasks("h1")
    assert.equal(listed.length, 1)
    assert.equal(listed[0].command, "echo test")
    assert.equal(listed[0].hostId, "h1")
  })

  it("ExecTaskManager.start publishes the same task id and output to scheduler", async () => {
    const scheduler = makeTrackedScheduler()
    const mgr = new ExecTaskManager({ scheduler })
    const client = new FakeClient() as any
    const { id, promise } = mgr.start(client, "echo bridged", { host: "h1", timeout: 5000 })

    const running = scheduler.getTask(id)
    assert.ok(running, "scheduler should expose the same task id returned by ExecTaskManager.start")
    assert.equal(running!.id, id)
    assert.equal(running!.status, "running")

    await new Promise(r => setImmediate(r))
    client.channel.emit("data", Buffer.from("bridged\n"))
    client.channel.emit("close", 0)
    await promise

    const finished = scheduler.getTask(id)
    assert.ok(finished, "scheduler task should still exist after finish")
    assert.equal(finished!.status, "completed")
    assert.equal(finished!.exitCode, 0)
    const output = scheduler.getTaskOutput(id, "full")
    assert.equal(output.stdout, "bridged\n")
  })

  it("ExecTaskManager.start streams running stdout to scheduler OutputStore", async () => {
    const scheduler = makeTrackedScheduler()
    const mgr = new ExecTaskManager({ scheduler })
    const client = new FakeClient() as any
    const { id } = mgr.start(client, "printf live", { host: "h1", timeout: 5000 })

    await new Promise(r => setImmediate(r))
    client.channel.emit("data", Buffer.from("live chunk\n"))

    const output = scheduler.getTaskOutput(id, "full")
    assert.equal(output.stdout, "live chunk\n")
    assert.equal(scheduler.getTask(id)?.stdoutBytes, Buffer.byteLength("live chunk\n"))
  })

  it("ExecTaskManager.start rejects the returned promise when client.exec throws synchronously", async () => {
    const scheduler = makeTrackedScheduler()
    const mgr = new ExecTaskManager({ scheduler })
    const client = new ThrowingClient() as any
    const { id, promise } = mgr.start(client, "echo throws", { host: "h1", timeout: 5000 })

    await assert.rejects(promise, /exec boom/)
    assert.equal(scheduler.getTask(id)?.status, "failed")
  })

  it("ExecTaskManager.start does not write new tasks to legacy exec-tasks JSON", async () => {
    const scheduler = makeTrackedScheduler()
    const mgr = new ExecTaskManager({ scheduler })
    const client = new FakeClient() as any
    const { promise } = mgr.start(client, "echo no-legacy", { host: "h1", timeout: 5000 })

    await new Promise(r => setImmediate(r))
    client.channel.emit("data", Buffer.from("no legacy\n"))
    client.channel.emit("close", 0)
    await promise

    assert.deepEqual(legacyTaskFiles(), [])
  })

  it("finished ExecTaskManager tasks remain readable from scheduler without legacy disk files", async () => {
    const scheduler = makeTrackedScheduler()
    const mgr = new ExecTaskManager({ scheduler })
    const client = new FakeClient() as any
    const { id, promise } = mgr.start(client, "echo sched-only", { host: "h1", timeout: 5000 })

    await new Promise(r => setImmediate(r))
    client.channel.emit("data", Buffer.from("sched only\n"))
    client.channel.emit("close", 0)
    await promise

    assert.deepEqual(legacyTaskFiles(), [])
    assert.equal(mgr.getStatus(id)?.status, "completed")
    assert.equal(mgr.getOutput(id)?.stdout, "sched only\n")
  })

  it("background-type ExecTaskManager tasks still execute through the scheduler facade", async () => {
    const scheduler = makeTrackedScheduler()
    const mgr = new ExecTaskManager({ scheduler })
    const client = new FakeClient() as any
    const { id, promise } = mgr.start(client, "echo background-compat", { host: "h1", type: "background", timeout: 5000 })

    await new Promise(r => setImmediate(r))
    client.channel.emit("data", Buffer.from("background compat\n"))
    client.channel.emit("close", 0)
    await promise

    assert.equal(scheduler.getTask(id)?.status, "completed")
    assert.equal(mgr.getStatus(id)?.type, "background")
    assert.equal(scheduler.getTaskOutput(id, "full").stdout, "background compat\n")
    assert.deepEqual(legacyTaskFiles(), [])
  })

  it("ExecTaskManager.cancel keeps scheduler output single-written", async () => {
    const scheduler = makeTrackedScheduler()
    const mgr = new ExecTaskManager({ scheduler })
    const client = new FakeClient() as any
    const { id } = mgr.start(client, "sleep 999", { host: "h1", timeout: 5000 })

    await new Promise(r => setImmediate(r))
    client.channel.emit("data", Buffer.from("before cancel\n"))
    assert.equal(mgr.cancel(id, client), true)

    const task = scheduler.getTask(id)
    assert.ok(task, "scheduler task should exist after cancel")
    assert.equal(task!.status, "cancelled")
    const output = scheduler.getTaskOutput(id, "full")
    assert.equal(output.stdout, "before cancel\n")
  })

  it("finishExternalTask updates the task's exit code and status", () => {
    const scheduler = makeTrackedScheduler()
    const t = scheduler.registerExternal({
      agent: { id: "etm", name: "etm", clientType: "internal" as const },
      host: { id: "h1", profileKey: "k", targetHost: "h1", targetUser: "u", displayName: "h1" },
      sessionId: "s1",
      command: "echo done",
      scheduler: "bypass",
    } as unknown as any)
    scheduler.finishExternalTask(t.id, { code: 0, stdout: "done", stderr: "" })
    const after = scheduler.getTask(t.id)
    assert.ok(after, "task still exists after finish")
    assert.equal(after!.status, "completed")
    assert.equal(after!.exitCode, 0)
    const out = scheduler.getTaskOutput(t.id, "full")
    assert.equal(out.stdout, "done")
  })

  it("finishExternalTask is a no-op for unknown task ids", () => {
    const scheduler = makeTrackedScheduler()
    // Should not throw
    scheduler.finishExternalTask("does-not-exist", { code: 0, stdout: "", stderr: "" })
  })

  it("registerExternal acquires workdir lock for mutating command", () => {
    const scheduler = makeTrackedScheduler()
    const t = scheduler.registerExternal({
      agent: { id: "etm", name: "etm", clientType: "internal" },
      host: { id: "h1", profileKey: "k", targetHost: "h1", targetUser: "u", displayName: "h1" },
      sessionId: "s1",
      command: "npm install express",
      cwd: "/tmp/my-project",
      scheduler: "bypass",
    } as any)
    const locks = scheduler["lockManager"].getLocksForHost("h1")
    assert.ok(locks.length > 0, "at least one lock acquired")
    assert.equal(locks[0].scope, "workdir")
    assert.equal(locks[0].key, "/tmp/my-project")
    scheduler.dispose()
  })

  it("registerExternal acquires host lock for exclusive command", () => {
    const scheduler = makeTrackedScheduler()
    const t = scheduler.registerExternal({
      agent: { id: "etm", name: "etm", clientType: "internal" },
      host: { id: "h1", profileKey: "k", targetHost: "h1", targetUser: "u", displayName: "h1" },
      sessionId: "s1",
      command: "dd if=/dev/zero of=/dev/null",
      cost: "exclusive",
      scheduler: "bypass",
    } as any)
    const locks = scheduler["lockManager"].getLocksForHost("h1")
    assert.ok(locks.length > 0, "at least one lock acquired")
    assert.equal(locks[0].scope, "host")
    assert.equal(locks[0].key, "h1")
    scheduler.dispose()
  })

  it("finishExternalTask releases locks and resolves waiters", async () => {
    const scheduler = makeTrackedScheduler()
    const t = scheduler.registerExternal({
      agent: { id: "etm", name: "etm", clientType: "internal" },
      host: { id: "h1", profileKey: "k", targetHost: "h1", targetUser: "u", displayName: "h1" },
      sessionId: "s1",
      command: "echo done",
      scheduler: "bypass",
    } as any)

    const waitPromise = scheduler.waitTask(t.id, 500)
    scheduler.finishExternalTask(t.id, { code: 0, stdout: "ok", stderr: "" })
    const resolvedTask = await waitPromise
    assert.equal(resolvedTask.exitCode, 0)
    const locks = scheduler["lockManager"].getLocksForHost("h1")
    assert.equal(locks.length, 0, "locks released after finish")
    scheduler.dispose()
  })

  it("finishExternalTask marks failed tasks correctly", () => {
    const scheduler = makeTrackedScheduler()
    const t = scheduler.registerExternal({
      agent: { id: "etm", name: "etm", clientType: "internal" },
      host: { id: "h1", profileKey: "k", targetHost: "h1", targetUser: "u", displayName: "h1" },
      sessionId: "s1",
      command: "exit 1",
      scheduler: "bypass",
    } as any)
    scheduler.finishExternalTask(t.id, { code: 1, stdout: "", stderr: "error" })
    const after = scheduler.getTask(t.id)!
    assert.equal(after.status, "failed")
    assert.equal(after.exitCode, 1)
    scheduler.dispose()
  })

  it("finishExternalTask marks cancelled tasks correctly", () => {
    const scheduler = makeTrackedScheduler()
    const t = scheduler.registerExternal({
      agent: { id: "etm", name: "etm", clientType: "internal" },
      host: { id: "h1", profileKey: "k", targetHost: "h1", targetUser: "u", displayName: "h1" },
      sessionId: "s1",
      command: "echo test",
      scheduler: "bypass",
    } as any)
    scheduler.finishExternalTask(t.id, { code: 130, stdout: "", stderr: "", signal: "TERM", status: "cancelled" })
    const after = scheduler.getTask(t.id)!
    assert.equal(after.status, "cancelled")
    assert.equal(after.exitCode, 130)
    assert.equal(after.signal, "TERM")
    scheduler.dispose()
  })

  it("finishExternalTask is idempotent", () => {
    const scheduler = makeTrackedScheduler()
    const t = scheduler.registerExternal({
      agent: { id: "etm", name: "etm", clientType: "internal" },
      host: { id: "h1", profileKey: "k", targetHost: "h1", targetUser: "u", displayName: "h1" },
      sessionId: "s1",
      command: "echo test",
      scheduler: "bypass",
    } as any)
    scheduler.finishExternalTask(t.id, { code: 0, stdout: "first", stderr: "" })
    scheduler.finishExternalTask(t.id, { code: 1, stdout: "second", stderr: "" })
    const after = scheduler.getTask(t.id)!
    // second call is no-op because task is no longer running
    assert.equal(after.exitCode, 0)
    scheduler.dispose()
  })
})
