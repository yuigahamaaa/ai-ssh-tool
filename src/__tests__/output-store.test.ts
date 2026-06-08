/**
 * OutputStore Tests
 */

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert"
import { OutputStore } from "../scheduler/output-store.js"
import { rmSync, mkdirSync, existsSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

describe("OutputStore", () => {
  const testDir = join(tmpdir(), `output-test-${Date.now()}`)

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    try { rmSync(testDir, { recursive: true }) } catch {}
  })

  it("creates stdout/stderr files on create", () => {
    const store = new OutputStore(testDir)
    store.create("task-1")
    
    assert.ok(existsSync(join(testDir, "task-1.stdout")))
    assert.ok(existsSync(join(testDir, "task-1.stderr")))
  })

  it("appends to stdout and stderr", () => {
    const store = new OutputStore(testDir)
    store.create("task-1")
    store.appendStdout("task-1", "hello\n")
    store.appendStderr("task-1", "error\n")
    
    const entry = store.get("task-1")
    assert.equal(entry?.stdoutTail, "hello\n")
    assert.equal(entry?.stderrTail, "error\n")
    assert.equal(entry?.stdoutBytes, 6)
    assert.equal(entry?.stderrBytes, 6)
  })

  it("persists to disk", () => {
    const store = new OutputStore(testDir)
    store.create("task-1")
    store.appendStdout("task-1", "hello\n")
    
    const content = readFileSync(join(testDir, "task-1.stdout"), "utf8")
    assert.equal(content, "hello\n")
  })

  it("gets full stdout/stderr", () => {
    const store = new OutputStore(testDir)
    store.create("task-1")
    store.appendStdout("task-1", "hello world\n")
    
    const full = store.getFullStdout("task-1")
    assert.equal(full, "hello world\n")
  })

  it("removes from memory and deletes disk files", () => {
    const store = new OutputStore(testDir)
    store.create("task-1")
    store.appendStdout("task-1", "hello\n")
    
    store.remove("task-1")
    
    assert.equal(store.get("task-1"), undefined)
    assert.ok(!existsSync(join(testDir, "task-1.stdout")))
    assert.ok(!existsSync(join(testDir, "task-1.stderr")))
  })

  it("handles large output with tail limit", () => {
    const store = new OutputStore(testDir)
    store.create("task-1")
    
    const large = "x".repeat(100 * 1024)
    store.appendStdout("task-1", large)
    
    const entry = store.get("task-1")
    assert.ok(entry!.stdoutTail.length <= 64 * 1024)
  })

  it("returns empty for non-existent task", () => {
    const store = new OutputStore(testDir)
    const full = store.getFullStdout("nonexistent")
    assert.equal(full, "")
  })

  it("returns truncated tail metadata with full output paths", () => {
    const store = new OutputStore(testDir)
    store.create("task-1")
    store.appendStdout("task-1", "x".repeat(40 * 1024))

    const output = store.getOutput("task-1", "tail", 30 * 1024)
    assert.equal(output.stdout.length, 30 * 1024)
    assert.equal(output.stdoutBytes, 40 * 1024)
    assert.equal(output.truncated, true)
    assert.equal(output.stdoutTruncated, true)
    assert.equal(output.stdoutPath, join(testDir, "task-1.stdout"))
  })

  it("loads tail from disk without reading the full output file", () => {
    const store = new OutputStore(testDir)
    const paths = store.getPaths("task-1")
    writeFileSync(paths.stdout, "a".repeat(4 * 1024) + "tail")
    writeFileSync(paths.stderr, "")
    const original = store.getFullStdout
    store.getFullStdout = (() => {
      throw new Error("full stdout should not be read for tail output")
    }) as typeof store.getFullStdout

    try {
      const output = store.getOutput("task-1", "tail", 16)
      assert.equal(output.stdout, "aaaaaaaaaaaatail")
      assert.equal(output.stdoutBytes, 4 * 1024 + 4)
      assert.equal(output.truncated, true)
    } finally {
      store.getFullStdout = original
    }
  })

  it("tracks file truncation separately from logical byte count", () => {
    const store = new OutputStore(testDir, { maxOutputFileSize: 10 })
    store.create("task-1")
    store.appendStdout("task-1", "abcdefghijklmnop")

    const output = store.getOutput("task-1", "full")
    assert.equal(output.stdout, "abcdefghij")
    assert.equal(output.stdoutBytes, 16)
    assert.equal(output.stdoutFileTruncated, true)
    assert.equal(output.truncated, true)
  })

  it("cleanup deletes old output but protects requested task ids and symlinks", () => {
    const store = new OutputStore(testDir)
    store.create("old-task")
    store.appendStdout("old-task", "old")
    store.create("protected-task")
    store.appendStdout("protected-task", "keep")

    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
    utimesSync(join(testDir, "old-task.stdout"), oldDate, oldDate)
    utimesSync(join(testDir, "old-task.stderr"), oldDate, oldDate)
    utimesSync(join(testDir, "protected-task.stdout"), oldDate, oldDate)
    utimesSync(join(testDir, "protected-task.stderr"), oldDate, oldDate)
    symlinkSync(join(testDir, "protected-task.stdout"), join(testDir, "link-task.stdout"))

    const result = store.cleanup({ retentionMs: 1, keepRecentTasks: 0 }, ["protected-task"])

    assert.equal(result.deletedFiles, 2)
    assert.ok(!existsSync(join(testDir, "old-task.stdout")))
    assert.ok(existsSync(join(testDir, "protected-task.stdout")))
    assert.ok(existsSync(join(testDir, "link-task.stdout")))
  })
})
