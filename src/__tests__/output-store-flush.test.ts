import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { OutputStore } from "../scheduler/output-store.js"
import { rmSync, mkdirSync, existsSync, readFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

describe("OutputStore flush batching", () => {
  const testDir = join(tmpdir(), `output-flush-${Date.now()}`)

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    try { rmSync(testDir, { recursive: true }) } catch {}
  })

  it("does not write to disk immediately within the batch window", () => {
    const store = new OutputStore(testDir, { flushIntervalMs: 500 })
    store.create("t1")
    store.appendStdout("t1", "hello\n")
    assert.ok(!existsSync(join(testDir, "t1.stdout")))
    store.flush("t1")
    assert.ok(existsSync(join(testDir, "t1.stdout")))
    assert.equal(readFileSync(join(testDir, "t1.stdout"), "utf8"), "hello\n")
  })

  it("coalesces many appends into one disk write", () => {
    // With a long window, none of the per-append writes reach the disk;
    // the content appears only after an explicit flush.
    const store = new OutputStore(testDir, { flushIntervalMs: 10000 })
    store.create("t1")
    for (let i = 0; i < 50; i++) store.appendStdout("t1", `line${i}\n`)
    assert.ok(!existsSync(join(testDir, "t1.stdout")))
    store.flush("t1")
    const expected = Array.from({ length: 50 }, (_, i) => `line${i}\n`).join("")
    assert.equal(readFileSync(join(testDir, "t1.stdout"), "utf8"), expected)
  })

  it("flushes all pending tasks via flushAll", () => {
    const store = new OutputStore(testDir, { flushIntervalMs: 500 })
    store.create("a"); store.create("b")
    store.appendStdout("a", "A")
    store.appendStderr("b", "B")
    store.flushAll()
    assert.equal(readFileSync(join(testDir, "a.stdout"), "utf8"), "A")
    assert.equal(readFileSync(join(testDir, "b.stderr"), "utf8"), "B")
  })

  it("stops writing to disk past maxOutputFileSize but keeps memory tail", () => {
    const store = new OutputStore(testDir, { maxOutputFileSize: 10, flushIntervalMs: 100 })
    store.create("t1")
    store.appendStdout("t1", "abcdefghijklmnop")
    const output = store.getOutput("t1", "full")
    assert.equal(output.stdout, "abcdefghij")
    assert.equal(output.stdoutBytes, 16)
    assert.equal(output.stdoutFileTruncated, true)
  })

  it("does not throw when a disk write fails", () => {
    const store = new OutputStore(testDir, { flushIntervalMs: 100 })
    store.create("t1")
    store.appendStdout("t1", "x")
    // Remove the output dir so the flush's appendFileSync hits ENOENT.
    rmSync(testDir, { recursive: true, force: true })
    assert.doesNotThrow(() => store.flush("t1"))
  })
})
