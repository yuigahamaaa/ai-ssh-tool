import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "events"
import { rmSync, mkdirSync, existsSync, readdirSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

// We need to override the task storage dir before importing ExecTaskManager.
// The module uses paths.ts to derive storage path. We set SSH_TOOL_DATA_DIR
// so it picks up our temp dir.

const testDataDir = join(tmpdir(), `etm-test-${Date.now()}-${process.pid}`)
const origDataDir = process.env.SSH_TOOL_DATA_DIR

function setup() {
  mkdirSync(testDataDir, { recursive: true })
  process.env.SSH_TOOL_DATA_DIR = testDataDir
}

function teardown() {
  if (origDataDir === undefined) {
    delete process.env.SSH_TOOL_DATA_DIR
  } else {
    process.env.SSH_TOOL_DATA_DIR = origDataDir
  }
  try { rmSync(testDataDir, { recursive: true, force: true }) } catch {}
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

describe("ExecTaskManager memory management", () => {
  let ExecTaskManager: typeof import("../exec-task-manager.js").ExecTaskManager

  beforeEach(async () => {
    setup()
    // Fresh import so it picks up new HOME
    const mod = await import(`../exec-task-manager.js?t=${Date.now()}`)
    ExecTaskManager = mod.ExecTaskManager
  })

  afterEach(() => {
    teardown()
  })

  it("releases finished task from memory after exec completes", async () => {
    const mgr = new ExecTaskManager()
    const client = new FakeClient() as any
    const { id, promise } = mgr.start(client, "echo hi", { timeout: 5000 })

    // Emit data then close
    await new Promise(r => setImmediate(r))
    client.channel.emit("data", Buffer.from("hi\n"))
    client.channel.emit("close", 0)

    await promise

    // After finish, task should be evicted from in-memory Map
    // We expose this via a cast to access private tasks Map size
    const tasksMap = (mgr as any).tasks as Map<string, unknown>
    assert.equal(tasksMap.size, 0, "finished task should be evicted from memory")

    // But status should still be readable from the scheduler store.
    const status = mgr.getStatus(id)
    assert.ok(status, "task status should be readable from scheduler after eviction")
    assert.equal(status!.status, "completed")
  })

  it("releases failed task from memory", async () => {
    const mgr = new ExecTaskManager()
    const client = new FakeClient() as any
    const { id, promise } = mgr.start(client, "fail-cmd", { timeout: 5000 })

    await new Promise(r => setImmediate(r))
    client.channel.emit("data", Buffer.from("output"))
    client.channel.emit("close", 1)

    await promise

    const tasksMap = (mgr as any).tasks as Map<string, unknown>
    assert.equal(tasksMap.size, 0, "failed task should be evicted from memory")

    const status = mgr.getStatus(id)
    assert.ok(status)
    assert.equal(status!.status, "failed")
  })

  it("releases cancelled task from memory", async () => {
    const mgr = new ExecTaskManager()
    const client = new FakeClient() as any
    const { id } = mgr.start(client, "sleep 999", { timeout: 5000 })

    await new Promise(r => setImmediate(r))

    const cancelled = mgr.cancel(id, client)
    assert.equal(cancelled, true)

    const tasksMap = (mgr as any).tasks as Map<string, unknown>
    assert.equal(tasksMap.size, 0, "cancelled task should be evicted from memory")

    const status = mgr.getStatus(id)
    assert.ok(status)
    assert.equal(status!.status, "cancelled")
  })

  it("getOutput works from scheduler after eviction", async () => {
    const mgr = new ExecTaskManager()
    const client = new FakeClient() as any
    const { id, promise } = mgr.start(client, "echo hello", { timeout: 5000 })

    await new Promise(r => setImmediate(r))
    client.channel.emit("data", Buffer.from("hello\n"))
    client.channel.emit("close", 0)

    await promise

    const output = mgr.getOutput(id)
    assert.ok(output, "output should be readable from scheduler")
    assert.ok(output!.stdout.includes("hello"))
  })

  it("memory does not grow after many completed tasks", async () => {
    const mgr = new ExecTaskManager()

    for (let i = 0; i < 10; i++) {
      const client = new FakeClient() as any
      const { promise } = mgr.start(client, `echo ${i}`, { timeout: 5000 })
      await new Promise(r => setImmediate(r))
      client.channel.emit("data", Buffer.from(`output-${i}\n`))
      client.channel.emit("close", 0)
      await promise
    }

    const tasksMap = (mgr as any).tasks as Map<string, unknown>
    assert.equal(tasksMap.size, 0, "all tasks should be evicted after completion")
  })
})
