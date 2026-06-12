/**
 * Logger Tests
 * Tests debug logging, file creation, filename formatting, and content format
 *
 * Note: Logger is a singleton module with module-level state.
 * Tests run sequentially and build on each other.
 */

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync, rmSync, readdirSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))
// Logger creates logs at <project-root>/logs/, which is dist/../logs when compiled
const LOGS_DIR = join(__dirname, "..", "..", "logs")

function getLogFiles(): string[] {
  if (!existsSync(LOGS_DIR)) return []
  return readdirSync(LOGS_DIR).filter((f) => f.endsWith(".log"))
}

function readLog(filename: string): string {
  return readFileSync(join(LOGS_DIR, filename), "utf-8")
}

// Clean up before and after all tests
before(() => {
  if (existsSync(LOGS_DIR)) rmSync(LOGS_DIR, { recursive: true, force: true })
})

after(() => {
  if (existsSync(LOGS_DIR)) rmSync(LOGS_DIR, { recursive: true, force: true })
})

describe("Logger", () => {
  // We import once - the module is a singleton
  let logger: typeof import("../logger.js")

  before(async () => {
    logger = await import("../logger.js")
  })

  describe("initial state", () => {
    it("isDebug should be false before enableDebug", () => {
      assert.equal(logger.isDebug(), false)
    })

    it("getLogPath should be empty before enableDebug", () => {
      assert.equal(logger.getLogPath(), "")
    })

    it("log should not write when debug is disabled", () => {
      logger.log("test", "should not appear")
      const files = getLogFiles()
      // Either no files, or message not in any file
      for (const f of files) {
        assert.ok(!readLog(f).includes("should not appear"))
      }
    })
  })

  describe("enableDebug with host+command", () => {
    it("should create logs directory", () => {
      logger.enableDebug({ host: "192.168.1.100", command: "echo hello" })
      assert.ok(existsSync(LOGS_DIR))
    })

    it("should create a log file", () => {
      const files = getLogFiles()
      assert.ok(files.length > 0)
    })

    it("should include host in filename", () => {
      const files = getLogFiles()
      assert.ok(files.some((f) => f.includes("192.168.1.100")))
    })

    it("should include command in filename", () => {
      const files = getLogFiles()
      assert.ok(files.some((f) => f.includes("echo_hello")))
    })

    it("should include timestamp in filename (YYYYMMDD-HHmmss)", () => {
      const files = getLogFiles()
      assert.ok(files.some((f) => /\d{8}-\d{6}\.log$/.test(f)))
    })

    it("should set isDebug to true", () => {
      assert.equal(logger.isDebug(), true)
    })

    it("should set getLogPath", () => {
      const path = logger.getLogPath()
      assert.ok(path.endsWith(".log"))
      assert.ok(path.includes("logs"))
    })

    it("should write init messages", () => {
      const path = logger.getLogPath()
      // enableDebug already calls flushNow() on its bootstrap lines, so
      // the init messages are on disk synchronously. No flushLogs() needed.
      const content = readFileSync(path, "utf-8")
      assert.ok(content.includes("[init] Session started"))
      assert.ok(content.includes("[init] Platform:"))
      assert.ok(content.includes("[init] Log file:"))
    })
  })

  describe("log content format", () => {
    it("should write messages with [timestamp] [category] format", () => {
      logger.log("conn", "Connecting to host")
      logger.flushLogs()
      const content = readFileSync(logger.getLogPath(), "utf-8")
      assert.ok(content.includes("[conn] Connecting to host"))
      // Timestamp format: [HH:MM:SS.mmm]
      assert.ok(/\[\d{2}:\d{2}:\d{2}\.\d{3}\]/.test(content))
    })

    it("should include data as JSON when provided", () => {
      logger.log("exec", "Running command", { cmd: "ls", timeout: 5000 })
      logger.flushLogs()
      const content = readFileSync(logger.getLogPath(), "utf-8")
      assert.ok(content.includes('"cmd":"ls"'))
      assert.ok(content.includes('"timeout":5000'))
    })

    it("should handle unserializable data gracefully", () => {
      const circular: any = {}
      circular.self = circular
      // Should not throw
      logger.log("test", "circular", circular)
      logger.flushLogs()
      const content = readFileSync(logger.getLogPath(), "utf-8")
      assert.ok(content.includes("[unserializable]"))
    })
  })

  describe("logError", () => {
    it("should write error message with context", () => {
      logger.logError("conn", "connection failed", new Error("timeout"))
      logger.flushLogs()
      const content = readFileSync(logger.getLogPath(), "utf-8")
      assert.ok(content.includes("[conn] ERROR connection failed: timeout"))
    })

    it("should write stack trace", () => {
      logger.logError("exec", "exec failed", new Error("bad command"))
      logger.flushLogs()
      const content = readFileSync(logger.getLogPath(), "utf-8")
      assert.ok(content.includes("Stack:"))
    })
  })

  describe("enableDebug with label", () => {
    let fileCountBefore: number

    it("should create a new file with label", () => {
      fileCountBefore = getLogFiles().length
      logger.enableDebug({ label: "prod-server" })
      const files = getLogFiles()
      assert.ok(files.length > fileCountBefore)
      assert.ok(files.some((f) => f.includes("prod-server")))
    })

    it("should not include 'debug-' prefix in label part", () => {
      const files = getLogFiles()
      const labelFile = files.find((f) => f.includes("prod-server"))
      assert.ok(labelFile)
      // Should be debug-prod-server-YYYYMMDD-HHmmss.log
      assert.ok(labelFile!.startsWith("debug-prod-server-"))
    })
  })

  describe("enableDebug without context", () => {
    it("should create file with just debug prefix and timestamp", () => {
      logger.enableDebug()
      const files = getLogFiles()
      // Should have a file like debug-YYYYMMDD-HHmmss.log (no host/label)
      const simpleFiles = files.filter((f) => /^debug-\d{8}-\d{6}\.log$/.test(f))
      assert.ok(simpleFiles.length > 0)
    })
  })

  describe("filename sanitization", () => {
    it("should replace colons with underscores", () => {
      logger.enableDebug({ host: "10.0.0.1:22" })
      const files = getLogFiles()
      assert.ok(files.every((f) => !f.includes(":")))
    })

    it("should replace slashes with underscores", () => {
      logger.enableDebug({ command: "ls -la /tmp" })
      const files = getLogFiles()
      assert.ok(files.every((f) => !f.includes("/")))
    })

    it("should truncate long hostnames", () => {
      const longHost = "a".repeat(100)
      logger.enableDebug({ host: longHost })
      const files = getLogFiles()
      // Filename should be reasonable length (not 100+ chars from host)
      assert.ok(files.every((f) => f.length < 100))
    })
  })

  describe("concurrent log writes", () => {
    it("should handle multiple rapid log calls", () => {
      logger.enableDebug()
      // Simulate concurrent logging (like multiple daemon sessions)
      for (let i = 0; i < 100; i++) {
        logger.log("stress", `message ${i}`, { index: i })
      }
      logger.flushLogs()
      const content = readFileSync(logger.getLogPath(), "utf-8")
      assert.ok(content.includes("message 0"))
      assert.ok(content.includes("message 99"))
      // Count lines - should have init + 100 log messages
      const lines = content.trim().split("\n").filter((l) => l.length > 0)
      assert.ok(lines.length >= 100)
    })
  })
})
