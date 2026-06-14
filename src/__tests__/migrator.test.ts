import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from "fs"
import { join, resolve } from "path"
import { tmpdir } from "os"
import { migrateExecTasks } from "../scheduler/migrator.js"

describe("Migrator", () => {
  let tmpDir: string
  let srcDir: string
  let destTasksDir: string
  let destOutputDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "migrator-test-"))
    srcDir = join(tmpDir, "exec-tasks")
    destTasksDir = join(tmpDir, "scheduler", "tasks")
    destOutputDir = join(tmpDir, "scheduler", "outputs")
    mkdirSync(srcDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("migrates legacy task files to scheduler format", () => {
    const legacyTask = {
      id: "task-123",
      type: "exec",
      command: "echo hello",
      status: "completed",
      exitCode: 0,
      signal: null,
      stdout: "hello\n",
      stderr: "",
      startedAt: Date.now() - 1000,
      finishedAt: Date.now(),
      pid: 12345,
      hostname: "test-host",
      createdAt: Date.now() - 1000,
      updatedAt: Date.now(),
      profileKey: "test-profile",
      sessionId: "session-1",
      cwd: "/tmp",
    }
    writeFileSync(join(srcDir, "task-123.json"), JSON.stringify(legacyTask))

    const result = migrateExecTasks(srcDir, destTasksDir, destOutputDir)

    assert.strictEqual(result.migrated, 1)
    assert.strictEqual(result.skipped, 0)
    assert.strictEqual(result.failed, 0)

    // Verify task file was created
    const destTaskPath = join(destTasksDir, "task-123.json")
    assert.ok(existsSync(destTaskPath))
    const migrated = JSON.parse(readFileSync(destTaskPath, "utf8"))
    assert.strictEqual(migrated.id, "task-123")
    assert.strictEqual(migrated.command, "echo hello")
    assert.strictEqual(migrated.status, "completed")
    assert.strictEqual(migrated.agentId, "exec-task-manager")
    assert.strictEqual(migrated.hostId, "test-host")

    // Verify output files were created
    assert.ok(existsSync(join(destOutputDir, "task-123.stdout")))
    assert.strictEqual(readFileSync(join(destOutputDir, "task-123.stdout"), "utf8"), "hello\n")

    // Verify source file was deleted
    assert.ok(!existsSync(join(srcDir, "task-123.json")))
  })

  it("skips tasks that already exist in destination", () => {
    const legacyTask = {
      id: "task-456",
      type: "exec",
      command: "ls",
      status: "completed",
      exitCode: 0,
      signal: null,
      stdout: "",
      stderr: "",
      startedAt: Date.now(),
      finishedAt: Date.now(),
      pid: null,
      hostname: "host",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    writeFileSync(join(srcDir, "task-456.json"), JSON.stringify(legacyTask))

    // Pre-create destination
    mkdirSync(destTasksDir, { recursive: true })
    writeFileSync(join(destTasksDir, "task-456.json"), JSON.stringify({ id: "task-456", status: "completed" }))

    const result = migrateExecTasks(srcDir, destTasksDir, destOutputDir)

    assert.strictEqual(result.skipped, 1)
    assert.strictEqual(result.migrated, 0)
    // Source file should still be deleted even if skipped
    assert.ok(!existsSync(join(srcDir, "task-456.json")))
  })

  it("backfills missing output files when destination task already exists", () => {
    const legacyTask = {
      id: "task-existing-output",
      type: "exec",
      command: "echo legacy",
      status: "completed",
      exitCode: 0,
      signal: null,
      stdout: "legacy stdout\n",
      stderr: "legacy stderr\n",
      startedAt: Date.now(),
      finishedAt: Date.now(),
      pid: null,
      hostname: "host",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    writeFileSync(join(srcDir, "task-existing-output.json"), JSON.stringify(legacyTask))
    mkdirSync(destTasksDir, { recursive: true })
    writeFileSync(join(destTasksDir, "task-existing-output.json"), JSON.stringify({ id: "task-existing-output", stdoutBytes: 0, stderrBytes: 0 }))

    const result = migrateExecTasks(srcDir, destTasksDir, destOutputDir)

    assert.strictEqual(result.skipped, 1)
    assert.strictEqual(result.migrated, 0)
    assert.strictEqual(readFileSync(join(destOutputDir, "task-existing-output.stdout"), "utf8"), "legacy stdout\n")
    assert.strictEqual(readFileSync(join(destOutputDir, "task-existing-output.stderr"), "utf8"), "legacy stderr\n")
    const migrated = JSON.parse(readFileSync(join(destTasksDir, "task-existing-output.json"), "utf8"))
    assert.strictEqual(migrated.stdoutBytes, Buffer.byteLength("legacy stdout\n"))
    assert.strictEqual(migrated.stderrBytes, Buffer.byteLength("legacy stderr\n"))
    assert.ok(!existsSync(join(srcDir, "task-existing-output.json")))
  })

  it("rejects unsafe task ids and leaves source file untouched", () => {
    const legacyTask = {
      id: "../outside",
      type: "exec",
      command: "echo bad",
      status: "completed",
      exitCode: 0,
      signal: null,
      stdout: "bad\n",
      stderr: "",
      startedAt: Date.now(),
      finishedAt: Date.now(),
      pid: null,
      hostname: "host",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    writeFileSync(join(srcDir, "unsafe.json"), JSON.stringify(legacyTask))

    const result = migrateExecTasks(srcDir, destTasksDir, destOutputDir)

    assert.strictEqual(result.failed, 1)
    assert.strictEqual(result.migrated, 0)
    assert.ok(existsSync(join(srcDir, "unsafe.json")))
    assert.ok(!existsSync(resolve(destTasksDir, "..", "outside.json")))
  })

  it("maps running status to stale", () => {
    const legacyTask = {
      id: "task-789",
      type: "exec",
      command: "sleep 100",
      status: "running",
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      startedAt: Date.now(),
      finishedAt: null,
      pid: 999,
      hostname: "host",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    writeFileSync(join(srcDir, "task-789.json"), JSON.stringify(legacyTask))

    const result = migrateExecTasks(srcDir, destTasksDir, destOutputDir)

    assert.strictEqual(result.migrated, 1)
    const migrated = JSON.parse(readFileSync(join(destTasksDir, "task-789.json"), "utf8"))
    assert.strictEqual(migrated.status, "stale")
  })

  it("handles empty source directory", () => {
    const result = migrateExecTasks(srcDir, destTasksDir, destOutputDir)
    assert.strictEqual(result.migrated, 0)
    assert.strictEqual(result.skipped, 0)
    assert.strictEqual(result.failed, 0)
  })

  it("handles non-existent source directory", () => {
    const nonExistent = join(tmpDir, "does-not-exist")
    const result = migrateExecTasks(nonExistent, destTasksDir, destOutputDir)
    assert.strictEqual(result.migrated, 0)
  })

  it("cleans up empty source directory after migration", () => {
    const legacyTask = {
      id: "task-cleanup",
      type: "exec",
      command: "echo",
      status: "completed",
      exitCode: 0,
      signal: null,
      stdout: "",
      stderr: "",
      startedAt: Date.now(),
      finishedAt: Date.now(),
      pid: null,
      hostname: "host",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    writeFileSync(join(srcDir, "task-cleanup.json"), JSON.stringify(legacyTask))

    migrateExecTasks(srcDir, destTasksDir, destOutputDir)

    // Source directory should be deleted if empty
    assert.ok(!existsSync(srcDir))
  })

  it("preserves source directory if files remain", () => {
    const legacyTask = {
      id: "task-partial",
      type: "exec",
      command: "echo",
      status: "completed",
      exitCode: 0,
      signal: null,
      stdout: "",
      stderr: "",
      startedAt: Date.now(),
      finishedAt: Date.now(),
      pid: null,
      hostname: "host",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    writeFileSync(join(srcDir, "task-partial.json"), JSON.stringify(legacyTask))
    writeFileSync(join(srcDir, "other.txt"), "not a json file")

    migrateExecTasks(srcDir, destTasksDir, destOutputDir)

    // Source directory should still exist
    assert.ok(existsSync(srcDir))
    // But the JSON file should be gone
    assert.ok(!existsSync(join(srcDir, "task-partial.json")))
    // Other files remain
    assert.ok(existsSync(join(srcDir, "other.txt")))
  })

  it("handles corrupted JSON gracefully", () => {
    writeFileSync(join(srcDir, "corrupted.json"), "not valid json{{{")

    const result = migrateExecTasks(srcDir, destTasksDir, destOutputDir)

    assert.strictEqual(result.failed, 1)
    assert.strictEqual(result.migrated, 0)
    // Corrupted file should remain in source
    assert.ok(existsSync(join(srcDir, "corrupted.json")))
  })

  it("migrates multiple tasks in one batch", () => {
    for (let i = 0; i < 5; i++) {
      const task = {
        id: `task-batch-${i}`,
        type: "exec",
        command: `echo ${i}`,
        status: "completed",
        exitCode: 0,
        signal: null,
        stdout: `output-${i}\n`,
        stderr: "",
        startedAt: Date.now() - (5 - i) * 1000,
        finishedAt: Date.now() - (5 - i) * 500,
        pid: 1000 + i,
        hostname: "batch-host",
        createdAt: Date.now() - (5 - i) * 1000,
        updatedAt: Date.now(),
      }
      writeFileSync(join(srcDir, `task-batch-${i}.json`), JSON.stringify(task))
    }

    const result = migrateExecTasks(srcDir, destTasksDir, destOutputDir)

    assert.strictEqual(result.migrated, 5)
    assert.strictEqual(readdirSync(destTasksDir).length, 5)
    assert.strictEqual(readdirSync(destOutputDir).length, 5) // 5 stdout files
  })
})
