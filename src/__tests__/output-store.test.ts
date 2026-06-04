/**
 * OutputStore Tests
 */

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert"
import { OutputStore } from "../output-store.js"
import { rmSync, mkdirSync, existsSync, readFileSync } from "fs"
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
})
