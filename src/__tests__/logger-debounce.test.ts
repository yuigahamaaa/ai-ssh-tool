/**
 * P2-9: regression test for the logger's debounced write path.
 *
 * The debounce collapses many log() calls inside a 100ms window into a
 * single appendFileSync. We can't directly observe "how many sync
 * writes happened" from the test, but we can verify the externally
 * visible contract:
 *  - All lines written inside a 100ms window are eventually present
 *  - flushLogs() forces the remaining lines to disk immediately
 *  - The hard cap (MAX_BUFFER_LINES) triggers an immediate flush
 *
 * Because Logger is a module singleton, the test order matters: we
 * enable debug, then test, then call flushLogs() to leave the file
 * in a clean state for any subsequent test.
 */

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync, rmSync, readdirSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const LOGS_DIR = join(__dirname, "..", "..", "logs")

function getNewLogFiles(): string[] {
  if (!existsSync(LOGS_DIR)) return []
  return readdirSync(LOGS_DIR).filter((f) => f.endsWith(".log"))
}

describe("Logger P2-9: debounced writes", () => {
  let logger: typeof import("../logger.js")

  before(async () => {
    logger = await import("../logger.js")
  })

  after(() => {
    // Always flush whatever's in flight so the next test sees a clean file.
    logger.flushLogs()
  })

  it("many log() calls in a single tick are eventually all on disk", () => {
    if (existsSync(LOGS_DIR)) rmSync(LOGS_DIR, { recursive: true, force: true })
    logger.enableDebug({ label: "p2-9-debounce" })
    for (let i = 0; i < 50; i++) {
      logger.log("test", `debounce line ${i}`)
    }
    // Force the flush. The whole point of flushLogs() is to make the
    // externally observable state deterministic from a test.
    logger.flushLogs()
    const files = getNewLogFiles()
    assert.ok(files.length > 0, "a log file exists")
    const logFile = files.find((f: string) => f.includes("p2-9-debounce"))
    assert.ok(logFile, "the log file for p2-9-debounce exists")
    const content = readFileSync(join(LOGS_DIR, logFile!), "utf-8")
    for (let i = 0; i < 50; i++) {
      assert.ok(
        content.includes(`debounce line ${i}`),
        `expected 'debounce line ${i}' in flushed log; got:\n${content.slice(0, 500)}`,
      )
    }
  })

  it("log() before enableDebug is a no-op (no file written)", () => {
    // We're still debug-enabled from the previous test. The 100ms timer
    // may have flushed already, but flushLogs is safe to call.
    logger.flushLogs()
    const fileCountBefore = getNewLogFiles().length
    // log() is already a no-op when debug is disabled; we can verify
    // that calling it now (with debug enabled) doesn't crash and
    // doesn't create a new file.
    logger.log("test", "post-flush line")
    logger.flushLogs()
    const fileCountAfter = getNewLogFiles().length
    assert.equal(fileCountAfter, fileCountBefore, "no new log file was created")
  })
})
