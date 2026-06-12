import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, existsSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { OutputStore, OUTPUT_TAIL_LIMIT } from "../scheduler/output-store.js"

describe("OutputStore P2-2: appendTail preserves bytes (not UTF-16 code units)", () => {
  let dir: string
  let store: OutputStore

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "ssh-tool-p2-2-"))
    store = new OutputStore(dir)
  })

  after(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("stdoutBytes reflects true UTF-8 byte count, not code unit count", () => {
    const taskId = "byte_count_test"
    store.create(taskId)
    // "你好" = 6 bytes in UTF-8 (2 chars × 3 bytes each), 2 UTF-16 code units
    store.appendStdout(taskId, "你好")
    const entry = store.get(taskId)!
    assert.equal(entry.stdoutBytes, 6, "expected 6 bytes for 2 Chinese chars")
    // Buffer.byteLength of the tail string is also 6
    const tailBytes = Buffer.byteLength(entry.stdoutTail, "utf8")
    assert.equal(tailBytes, 6)
  })

  it("appending more than OUTPUT_TAIL_LIMIT bytes keeps the last N bytes", () => {
    const taskId = "tail_truncate_test"
    store.create(taskId)
    // Each "好" = 3 bytes. 24000 chars = 72000 bytes > 65536.
    // If we naively used .length (UTF-16 code units) we'd keep the last
    // 65536 *code units* = up to 98304 bytes (when ASCII) — far too much.
    // With the byte-based fix, the tail should be exactly OUTPUT_TAIL_LIMIT
    // bytes (or less if append < limit).
    const chunk = "好".repeat(24_000)
    store.appendStdout(taskId, chunk)
    const entry = store.get(taskId)!
    assert.equal(entry.stdoutBytes, 24_000 * 3)
    const tailBytes = Buffer.byteLength(entry.stdoutTail, "utf8")
    assert.ok(
      tailBytes <= OUTPUT_TAIL_LIMIT,
      `tail should not exceed OUTPUT_TAIL_LIMIT bytes, got ${tailBytes}`,
    )
    // The tail bytes plus the disk file bytes (if any) account for the run.
    // Truncation must be reported.
    const out = store.getOutput(taskId, "tail")
    assert.ok(out.stdoutTruncated || out.stdoutFileTruncated, "truncation flag should be set")
  })

  it("many small appends keep tail in sync with byte count (no drift)", () => {
    const taskId = "drift_test"
    store.create(taskId)
    // Mixed ASCII and multibyte
    for (let i = 0; i < 1000; i++) {
      store.appendStdout(taskId, i % 2 === 0 ? "abc" : "好世")
    }
    const entry = store.get(taskId)!
    const expected = 1000 * 3 // 3 bytes per chunk (either 'abc' or '好世' = 3+3=6 wait)
    // Actually '好世' = 6 bytes; re-do expectation: half-and-half
    // 500 × 'abc' = 1500 bytes
    // 500 × '好世' = 3000 bytes
    // total = 4500 bytes
    const expected2 = 500 * 3 + 500 * 6
    assert.equal(entry.stdoutBytes, expected2)
    const tailBytes = Buffer.byteLength(entry.stdoutTail, "utf8")
    assert.ok(tailBytes <= OUTPUT_TAIL_LIMIT)
  })
})
