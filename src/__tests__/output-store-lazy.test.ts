/**
 * OutputStore lazy file-creation tests
 *
 * The store no longer creates empty stdout/stderr files up front in
 * `create()`. Files are only created on the first append. This avoids
 * two useless syscalls + 0-byte file artefacts for tasks that finish
 * without writing anything.
 */

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { OutputStore } from "../scheduler/output-store.js"
import { rmSync, mkdirSync, existsSync, readFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

describe("OutputStore lazy file creation", () => {
  const testDir = join(tmpdir(), `outputstore-lazy-${Date.now()}-${process.pid}`)

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true })
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    try { rmSync(testDir, { recursive: true }) } catch {}
  })

  it("create() does not write any file to disk", () => {
    const store = new OutputStore(testDir)
    store.create("lazy-1")
    const paths = store.getPaths("lazy-1")
    assert.equal(existsSync(paths.stdout), false, "stdout should not be created eagerly")
    assert.equal(existsSync(paths.stderr), false, "stderr should not be created eagerly")
  })

  it("first appendStdout creates only the stdout file", () => {
    const store = new OutputStore(testDir)
    store.create("lazy-2")
    store.appendStdout("lazy-2", "hello\n")
    const paths = store.getPaths("lazy-2")
    assert.equal(existsSync(paths.stdout), true)
    assert.equal(existsSync(paths.stderr), false, "stderr should remain absent until used")
    assert.equal(readFileSync(paths.stdout, "utf8"), "hello\n")
  })

  it("first appendStderr creates only the stderr file", () => {
    const store = new OutputStore(testDir)
    store.create("lazy-3")
    store.appendStderr("lazy-3", "warn\n")
    const paths = store.getPaths("lazy-3")
    assert.equal(existsSync(paths.stdout), false)
    assert.equal(existsSync(paths.stderr), true)
  })

  it("subsequent appends use appendFileSync, not writeFileSync", () => {
    const store = new OutputStore(testDir)
    store.create("lazy-4")
    store.appendStdout("lazy-4", "first\n")
    store.appendStdout("lazy-4", "second\n")
    const paths = store.getPaths("lazy-4")
    assert.equal(readFileSync(paths.stdout, "utf8"), "first\nsecond\n")
  })

  it("a task that never writes anything leaves no trace on disk", () => {
    const store = new OutputStore(testDir)
    store.create("no-output")
    store.remove("no-output")
    const paths = store.getPaths("no-output")
    assert.equal(existsSync(paths.stdout), false)
    assert.equal(existsSync(paths.stderr), false)
  })

  it("getOutput returns empty strings for a task with no on-disk files", () => {
    const store = new OutputStore(testDir)
    store.create("ghost")
    const out = store.getOutput("ghost", "full")
    assert.equal(out.stdout, "")
    assert.equal(out.stderr, "")
    assert.equal(out.stdoutBytes, 0)
    assert.equal(out.stderrBytes, 0)
  })
})
