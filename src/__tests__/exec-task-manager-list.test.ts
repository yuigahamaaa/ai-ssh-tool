/**
 * ExecTaskManager.list() merge tests
 *
 * Verifies the O(n+m) merge of disk-loaded tasks with in-memory tasks,
 * in particular that:
 *  - in-memory entries win over disk snapshots of the same id
 *  - hostname filtering applies to both sources
 *  - output is sorted newest-first
 */

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { rmSync, mkdirSync, existsSync, readdirSync, writeFileSync, unlinkSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

// Override SSH_TOOL_DATA_DIR before importing the module so the storage dir is temp-scoped.
const testDataDir = join(tmpdir(), `etm-list-test-${Date.now()}-${process.pid}`)
const origDataDir = process.env.SSH_TOOL_DATA_DIR

function setup() {
  mkdirSync(testDataDir, { recursive: true })
  process.env.SSH_TOOL_DATA_DIR = testDataDir
}

function teardown() {
  if (origDataDir === undefined) delete process.env.SSH_TOOL_DATA_DIR
  else process.env.SSH_TOOL_DATA_DIR = origDataDir
  try { rmSync(testDataDir, { recursive: true, force: true }) } catch {}
}

function writeDiskTask(task: { id: string; hostname: string; startedAt: number; status: string; command: string; stdout?: string; stderr?: string }): void {
  const dir = join(testDataDir, "exec-tasks")
  mkdirSync(dir, { recursive: true })
  // Use real-time timestamps so the manager's retention sweep (24h after
  // finishedAt) does not delete freshly-written fixtures.
  const now = Date.now()
  const startedAt = task.startedAt > 1_000_000_000_000 ? task.startedAt : now - 1000
  const fullTask = {
    type: "exec",
    exitCode: 0,
    signal: null,
    stdout: task.stdout ?? "",
    stderr: task.stderr ?? "",
    finishedAt: startedAt + 100,
    pid: null,
    createdAt: startedAt,
    updatedAt: startedAt + 100,
    ...task,
    startedAt,
  }
  writeFileSync(join(dir, `${task.id}.json`), JSON.stringify(fullTask))
}

describe("ExecTaskManager.list() merge", () => {
  let ExecTaskManager: typeof import("../exec-task-manager.js").ExecTaskManager

  beforeEach(async () => {
    setup()
    // Fresh import so the module-level getTaskStorageDir() picks up the new HOME.
    const mod = await import(`../exec-task-manager.js?t=${Date.now()}`)
    ExecTaskManager = mod.ExecTaskManager
  })

  afterEach(() => {
    teardown()
  })

  it("returns disk-loaded tasks with no in-memory state", () => {
    writeDiskTask({ id: "d1", hostname: "host-A", startedAt: 1000, status: "completed", command: "echo a" })
    writeDiskTask({ id: "d2", hostname: "host-B", startedAt: 2000, status: "completed", command: "echo b" })

    const mgr = new ExecTaskManager()
    const all = mgr.list()
    const ids = all.map((t) => t.id).sort()
    assert.deepEqual(ids, ["d1", "d2"])
  })

  it("filters by hostname across disk + memory", () => {
    writeDiskTask({ id: "d1", hostname: "host-A", startedAt: 1000, status: "completed", command: "echo a" })
    writeDiskTask({ id: "d2", hostname: "host-B", startedAt: 2000, status: "completed", command: "echo b" })

    const mgr = new ExecTaskManager()
    const onlyA = mgr.list("host-A")
    assert.equal(onlyA.length, 1)
    assert.equal(onlyA[0].id, "d1")
    const onlyB = mgr.list("host-B")
    assert.equal(onlyB.length, 1)
    assert.equal(onlyB[0].id, "d2")
  })

  it("sorts results newest-started first", () => {
    writeDiskTask({ id: "older", hostname: "host-A", startedAt: 1000, status: "completed", command: "x" })
    writeDiskTask({ id: "newer", hostname: "host-A", startedAt: 2000, status: "completed", command: "y" })

    const mgr = new ExecTaskManager()
    const all = mgr.list()
    assert.equal(all[0].id, "newer")
    assert.equal(all[1].id, "older")
  })

  it("deduplicates: in-memory entry wins over disk snapshot with same id", () => {
    writeDiskTask({ id: "shared", hostname: "host-A", startedAt: 1000, status: "completed", command: "from-disk" })

    const mgr = new ExecTaskManager()
    // Inject an in-memory task entry with the same id but a different command.
    const fakeChannel: any = {}
    const fakeClient: any = {}
    const memEntry: any = {
      stream: fakeChannel,
      client: fakeClient,
      persistImmediate: true,
      task: {
        id: "shared",
        type: "exec",
        command: "from-memory",
        status: "running",
        exitCode: null,
        signal: null,
        stdout: "live-stdout",
        stderr: "",
        startedAt: 5000,
        finishedAt: null,
        pid: null,
        hostname: "host-A",
        createdAt: 5000,
        updatedAt: 5000,
      },
    }
    ;(mgr as any).tasks.set("shared", {
      ...memEntry,
      stdoutChunks: [],
      stderrChunks: [],
      chunksFlushed: true,
    })

    const all = mgr.list()
    const shared = all.find((t) => t.id === "shared")
    assert.ok(shared, "shared task should be present")
    assert.equal(shared!.command, "from-memory", "in-memory version must win over disk")
    assert.equal(shared!.startedAt, 5000)
    // And only one copy should exist (no duplicate from disk).
    const dupes = all.filter((t) => t.id === "shared")
    assert.equal(dupes.length, 1, "must deduplicate by id")
  })
})
