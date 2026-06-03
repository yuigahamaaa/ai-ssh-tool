import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { PersistenceStore } from "../scheduler/persistence-store.js"
import type { ScheduledTask } from "../scheduler/types.js"
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "t_test1",
    agentId: "agent-a",
    hostId: "host-1",
    profileKey: "pk-1",
    sessionId: "sess-1",
    command: "echo ok",
    classification: { intent: "inspect", cost: "tiny", blocking: false, mutates: false, risky: false, source: "auto", reason: "test" },
    scheduler: "auto",
    status: "queued",
    updatedAt: Date.now(),
    stdoutTail: "",
    stderrTail: "",
    stdoutBytes: 0,
    stderrBytes: 0,
    ...overrides,
  }
}

describe("PersistenceStore", () => {
  let tmpDir: string
  let store: PersistenceStore

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "persist-test-"))
    store = new PersistenceStore(tmpDir)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("saves and loads a task atomically", () => {
    const task = makeTask()
    store.saveTask(task)

    const loaded = store.loadTask(task.id)
    assert.ok(loaded)
    assert.equal(loaded!.id, task.id)
    assert.equal(loaded!.command, "echo ok")

    const taskPath = join(tmpDir, "tasks", `${task.id}.json`)
    assert.ok(existsSync(taskPath))
    assert.ok(!existsSync(taskPath + ".tmp"))
  })

  it("restores queued tasks", () => {
    store.saveTask(makeTask({ id: "t_q1", status: "queued" }))
    store.saveTask(makeTask({ id: "t_q2", status: "queued" }))

    const fresh = new PersistenceStore(tmpDir)
    const { queued, stale } = fresh.restore()

    assert.equal(queued.length, 2)
    assert.equal(stale.length, 0)
    assert.ok(queued.some(t => t.id === "t_q1"))
    assert.ok(queued.some(t => t.id === "t_q2"))
  })

  it("restores running tasks as stale", () => {
    store.saveTask(makeTask({ id: "t_r1", status: "running" }))

    const fresh = new PersistenceStore(tmpDir)
    const { queued, stale } = fresh.restore()

    assert.equal(queued.length, 0)
    assert.equal(stale.length, 1)
    assert.equal(stale[0].status, "stale")
    assert.ok(stale[0].decisionReason?.includes("daemon restart"))
  })

  it("handles corrupted file gracefully", () => {
    const tasksDir = join(tmpDir, "tasks")
    mkdirSync(tasksDir, { recursive: true })
    writeFileSync(join(tasksDir, "bad.json"), "not json!!!")

    const fresh = new PersistenceStore(tmpDir)
    const all = fresh.loadAllTasks()
    assert.equal(all.length, 0)
  })

  it("virtual cwd persistence", () => {
    store.saveVirtualCwdMap({
      "agent-a:host-1": { key: "agent-a:host-1", agentId: "agent-a", hostId: "host-1", cwd: "/repo-a", updatedAt: Date.now() },
    })

    const fresh = new PersistenceStore(tmpDir)
    const map = fresh.loadVirtualCwdMap()
    assert.equal(map["agent-a:host-1"]?.cwd, "/repo-a")
  })
})
