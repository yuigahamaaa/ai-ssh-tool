/**
 * P1-3 Stage 2 / Task 2.2: migrate old `~/.ssh-tool/exec-tasks/*.json`
 * into the new scheduler layout.
 *
 * The migration is one-shot at daemon startup. The old files are preserved
 * (read-only fallback) but the new layout becomes the source of truth.
 *
 *   ~/.ssh-tool/exec-tasks/<id>.json   (old, ExecTask with embedded stdout/stderr)
 *   ~/.ssh-tool/scheduler/tasks/<id>.json       (new, ScheduledTask-shaped, tail in memory)
 *   ~/.ssh-tool/scheduler/outputs/<id>.stdout   (new, full stdout)
 *   ~/.ssh-tool/scheduler/outputs/<id>.stderr   (new, full stderr)
 *
 * Idempotency: we re-migrate on every daemon start, but the cost is small
 * (one stat per old file) and we don't re-write the new files if the
 * old one is older than the corresponding new files.
 */

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, utimesSync, mkdirSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { migrateExecTasks } from "../scheduler/migrator.js"

function makeOldTaskJson(id: string, overrides?: Record<string, unknown>): string {
  return JSON.stringify({
    id,
    type: "exec",
    command: "echo hi",
    status: "completed",
    exitCode: 0,
    signal: null,
    stdout: "hello world\n",
    stderr: "",
    startedAt: 1700000000000,
    finishedAt: 1700000001000,
    pid: null,
    hostname: "test.example.com",
    createdAt: 1700000000000,
    updatedAt: 1700000001000,
    ...overrides,
  })
}

describe("migrateExecTasks", () => {
  let srcDir: string
  let destTaskDir: string
  let destOutputDir: string

  before(() => {
    srcDir = mkdtempSync(join(tmpdir(), "migrator-src-"))
    destTaskDir = mkdtempSync(join(tmpdir(), "migrator-dest-tasks-"))
    destOutputDir = mkdtempSync(join(tmpdir(), "migrator-dest-outputs-"))
  })

  after(() => {
    rmSync(srcDir, { recursive: true, force: true })
    rmSync(destTaskDir, { recursive: true, force: true })
    rmSync(destOutputDir, { recursive: true, force: true })
  })

  it("migrates a single old task to the new layout", () => {
    const oldPath = join(srcDir, "abc123.json")
    writeFileSync(oldPath, makeOldTaskJson("abc123"))

    const result = migrateExecTasks({
      srcDir,
      destTaskDir,
      destOutputDir,
    })

    assert.equal(result.migrated, 1)
    assert.equal(result.skipped, 0)
    assert.equal(result.failed, 0)

    // New task JSON exists, has tail fields, no embedded stdout
    const newTaskPath = join(destTaskDir, "abc123.json")
    assert.ok(existsSync(newTaskPath), "new task file written")
    const newTask = JSON.parse(readFileSync(newTaskPath, "utf-8"))
    assert.equal(newTask.id, "abc123")
    // Old `hostname` is mapped to the new scheduler's `hostId` field
    assert.equal(newTask.hostId, "test.example.com")
    assert.equal(newTask.command, "echo hi")
    // stdout/stderr are gone from the metadata; tail lives on disk
    assert.equal(newTask.stdout, undefined)
    assert.equal(newTask.stderr, undefined)
    assert.equal(newTask.stdoutTail, "hello world\n")
    assert.equal(newTask.stdoutBytes, "hello world\n".length)

    // Full stdout/stderr written to outputs/
    assert.ok(existsSync(join(destOutputDir, "abc123.stdout")), "stdout file written")
    assert.ok(existsSync(join(destOutputDir, "abc123.stderr")), "stderr file written")
    const stdout = readFileSync(join(destOutputDir, "abc123.stdout"), "utf-8")
    assert.equal(stdout, "hello world\n")
  })

  it("is idempotent: re-running does not re-write newer files", () => {
    // Use a fresh src dir so other tests' data doesn't pollute the count
    const freshSrc = mkdtempSync(join(tmpdir(), "migrator-idemp-"))
    try {
      const oldPath = join(freshSrc, "idemp.json")
      writeFileSync(oldPath, makeOldTaskJson("idemp"))
      migrateExecTasks({ srcDir: freshSrc, destTaskDir, destOutputDir })

      // Stale the old file (back-date it) so the comparison is meaningful
      const past = new Date(Date.now() - 10_000)
      utimesSync(oldPath, past, past)
      // Bump the new task forward so it's "newer" than the old one
      const newTaskPath = join(destTaskDir, "idemp.json")
      const future = new Date(Date.now() + 10_000)
      utimesSync(newTaskPath, future, future)

      const result = migrateExecTasks({ srcDir: freshSrc, destTaskDir, destOutputDir })
      assert.equal(result.migrated, 0, "no re-migration when new is newer")
      assert.equal(result.skipped, 1, "the already-migrated file is counted as skipped")
    } finally {
      rmSync(freshSrc, { recursive: true, force: true })
    }
  })

  it("re-migrates if the old file is newer than the new file", () => {
    // Seed a task in the new layout, then re-write the old file with new
    // content and bump the old mtime forward.
    const oldPath = join(srcDir, "rere.json")
    const newTaskPath = join(destTaskDir, "rere.json")
    writeFileSync(oldPath, makeOldTaskJson("rere"))
    const firstPass = migrateExecTasks({ srcDir, destTaskDir, destOutputDir })
    assert.equal(firstPass.migrated, 1)

    // Back-date the new file
    const past = new Date(Date.now() - 10_000)
    utimesSync(newTaskPath, past, past)

    // Re-write old file with mutated content + newer mtime
    writeFileSync(oldPath, makeOldTaskJson("rere", { command: "echo v2" }))
    const future = new Date(Date.now() + 10_000)
    utimesSync(oldPath, future, future)

    const secondPass = migrateExecTasks({ srcDir, destTaskDir, destOutputDir })
    assert.equal(secondPass.migrated, 1, "re-migrates when old is newer")
    const task = JSON.parse(readFileSync(newTaskPath, "utf-8"))
    assert.equal(task.command, "echo v2", "new content is on disk")
  })

  it("counts corrupted files as failures and leaves the source untouched", () => {
    const oldPath = join(srcDir, "bad.json")
    writeFileSync(oldPath, "{not valid json")
    const result = migrateExecTasks({ srcDir, destTaskDir, destOutputDir })
    assert.equal(result.failed, 1, "corrupt file is counted as failure")
    assert.ok(existsSync(oldPath), "corrupt source file is preserved")
  })

  it("returns zeros when the source directory does not exist", () => {
    const result = migrateExecTasks({
      srcDir: join(srcDir, "does-not-exist"),
      destTaskDir,
      destOutputDir,
    })
    assert.equal(result.migrated, 0)
    assert.equal(result.skipped, 0)
    assert.equal(result.failed, 0)
  })

  it("handles a batch of mixed tasks in one call", () => {
    // Reset dirs for a clean batch
    const batchSrc = mkdtempSync(join(tmpdir(), "migrator-batch-"))
    try {
      writeFileSync(join(batchSrc, "t1.json"), makeOldTaskJson("t1", { hostname: "h1" }))
      writeFileSync(join(batchSrc, "t2.json"), makeOldTaskJson("t2", { hostname: "h2" }))
      writeFileSync(join(batchSrc, "t3.json"), makeOldTaskJson("t3", { hostname: "h3" }))
      const result = migrateExecTasks({ srcDir: batchSrc, destTaskDir, destOutputDir })
      assert.equal(result.migrated, 3)
      for (const id of ["t1", "t2", "t3"]) {
        assert.ok(existsSync(join(destTaskDir, `${id}.json`)))
        assert.ok(existsSync(join(destOutputDir, `${id}.stdout`)))
      }
    } finally {
      rmSync(batchSrc, { recursive: true, force: true })
    }
  })
})
