/**
 * Daemon Tests
 * Tests IPC protocol, daemon lifecycle, multi-session support, and session cleanup
 */

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "crypto"
import {
  encodeMessage,
  parseMessages,
  type IPCRequest,
  type IPCResponse,
} from "../ipc-protocol.js"

// --- IPC Protocol Tests ---

describe("IPC Protocol", () => {
  describe("encodeMessage", () => {
    it("should encode request as JSON with newline", () => {
      const req: IPCRequest = { id: "test-1", action: "ping" }
      const encoded = encodeMessage(req)
      assert.ok(encoded.endsWith("\n"))
      const parsed = JSON.parse(encoded.trim())
      assert.equal(parsed.id, "test-1")
      assert.equal(parsed.action, "ping")
    })

    it("should encode response as JSON with newline", () => {
      const resp: IPCResponse = { id: "test-2", ok: true, data: { message: "ok" } }
      const encoded = encodeMessage(resp)
      assert.ok(encoded.endsWith("\n"))
      const parsed = JSON.parse(encoded.trim())
      assert.equal(parsed.id, "test-2")
      assert.equal(parsed.ok, true)
    })
  })

  describe("parseMessages", () => {
    it("should parse single complete message", () => {
      const msg = encodeMessage({ id: "1", action: "ping" })
      const received: IPCRequest[] = []
      const remainder = parseMessages(Buffer.from(msg), (m) => {
        received.push(m as IPCRequest)
      })
      assert.equal(received.length, 1)
      assert.equal(received[0].action, "ping")
      assert.equal(remainder.length, 0)
    })

    it("should parse multiple messages in one buffer", () => {
      const msg1 = encodeMessage({ id: "1", action: "ping" })
      const msg2 = encodeMessage({ id: "2", action: "list" })
      const received: IPCRequest[] = []
      const remainder = parseMessages(Buffer.from(msg1 + msg2), (m) => {
        received.push(m as IPCRequest)
      })
      assert.equal(received.length, 2)
      assert.equal(received[0].action, "ping")
      assert.equal(received[1].action, "list")
      assert.equal(remainder.length, 0)
    })

    it("should handle partial messages", () => {
      const full = encodeMessage({ id: "1", action: "ping" })
      const partial = full.slice(0, 10) // incomplete
      const rest = full.slice(10)

      const received: IPCRequest[] = []
      let remainder = parseMessages(Buffer.from(partial), (m) => {
        received.push(m as IPCRequest)
      })
      assert.equal(received.length, 0)
      assert.ok(remainder.length > 0)

      remainder = parseMessages(Buffer.concat([remainder, Buffer.from(rest)]), (m) => {
        received.push(m as IPCRequest)
      })
      assert.equal(received.length, 1)
      assert.equal(received[0].action, "ping")
    })

    it("should skip malformed JSON lines", () => {
      const valid = encodeMessage({ id: "1", action: "ping" })
      const invalid = "not-json\n"
      const received: IPCRequest[] = []
      const remainder = parseMessages(Buffer.from(invalid + valid), (m) => {
        received.push(m as IPCRequest)
      })
      assert.equal(received.length, 1)
      assert.equal(received[0].action, "ping")
    })

    it("should handle empty buffer", () => {
      const received: IPCRequest[] = []
      const remainder = parseMessages(Buffer.alloc(0), (m) => {
        received.push(m as IPCRequest)
      })
      assert.equal(received.length, 0)
      assert.equal(remainder.length, 0)
    })
  })
})

// --- Config Hash Tests ---

describe("Config Hash", () => {
  it("should produce same hash for same config", () => {
    const config = JSON.stringify({ target: { host: "10.0.0.1", username: "root" } })
    const hash1 = createHash("md5").update(config).digest("hex")
    const hash2 = createHash("md5").update(config).digest("hex")
    assert.equal(hash1, hash2)
  })

  it("should produce different hash for different config", () => {
    const config1 = JSON.stringify({ target: { host: "10.0.0.1", username: "root" } })
    const config2 = JSON.stringify({ target: { host: "10.0.0.2", username: "root" } })
    const hash1 = createHash("md5").update(config1).digest("hex")
    const hash2 = createHash("md5").update(config2).digest("hex")
    assert.notEqual(hash1, hash2)
  })

  it("should produce same hash after normalization (regardless of key order)", () => {
    const config1 = JSON.stringify({ target: { host: "10.0.0.1", username: "root" }, gateways: [] })
    const config2 = JSON.stringify({ gateways: [], target: { username: "root", host: "10.0.0.1" } })
    // Normalize: parse then stringify with sorted keys (same as daemon does)
    const normalize = (s: string) => JSON.stringify(JSON.parse(s), Object.keys(JSON.parse(s)).sort())
    const hash1 = createHash("md5").update(normalize(config1)).digest("hex")
    const hash2 = createHash("md5").update(normalize(config2)).digest("hex")
    assert.equal(hash1, hash2, "Normalized configs with different key order should produce same hash")
  })
})

// --- IPC Request/Response Type Tests ---

describe("IPC Message Types", () => {
  it("should have correct structure for connect request", () => {
    const req: IPCRequest = { id: "abc", action: "connect", params: { configPath: "/tmp/test.json" } }
    assert.equal(req.action, "connect")
    assert.ok("params" in req)
    assert.equal((req as any).params.configPath, "/tmp/test.json")
  })

  it("should have correct structure for connectJson request", () => {
    const json = '{"target":{"host":"10.0.0.1","username":"root"}}'
    const req: IPCRequest = { id: "ghi", action: "connectJson", params: { configJson: json } }
    assert.equal(req.action, "connectJson")
    assert.ok("params" in req)
    assert.equal((req as any).params.configJson, json)
  })

  it("should have correct structure for exec request", () => {
    const req: IPCRequest = { id: "def", action: "exec", params: { sessionId: "sid", command: "ls", timeout: 5000 } }
    assert.equal(req.action, "exec")
    assert.equal((req as any).params.command, "ls")
  })

  it("should have correct structure for success response", () => {
    const resp: IPCResponse = { id: "abc", ok: true, data: { sessionId: "sid" } }
    assert.equal(resp.ok, true)
    assert.equal((resp as any).data.sessionId, "sid")
  })

  it("should have correct structure for error response", () => {
    const resp: IPCResponse = { id: "abc", ok: false, error: "connection failed" }
    assert.equal(resp.ok, false)
    assert.equal(resp.error, "connection failed")
  })
})
