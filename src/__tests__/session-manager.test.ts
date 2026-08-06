/**
 * SSHSessionManager Unit Tests
 * Tests session lifecycle, limits, lookups, and event handling
 * Note: connect() tests wrap in try-catch since no real SSH server is available
 */

import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { SSHSessionManager } from "../session-manager.js"
import type { SSHConnectionChain, ConnectionEvent, SSHSession } from "../types.js"

function makeChain(hosts: string[]): SSHConnectionChain {
  return hosts.map((host, i) => ({
    id: `host-${i}`,
    name: host,
    host,
    port: 46000 + i,
    auth: { username: "testuser", password: "testpass" },
  }))
}

async function connectExpectingFailure(
  manager: SSHSessionManager,
  chain: SSHConnectionChain,
  name?: string,
): Promise<void> {
  try {
    await manager.connect({ chain, name, timeout: 25 })
  } catch {
    // expected: tests only need the session bookkeeping around a failed connect
  }
}

describe("SSHSessionManager", () => {
  let manager: SSHSessionManager

  beforeEach(() => {
    manager = new SSHSessionManager({ maxSessions: 5 })
  })

  describe("construction", () => {
    it("should create with default options", () => {
      const m = new SSHSessionManager()
      assert.equal(m.sessionCount, 0)
    })

    it("should create with custom options", () => {
      const m = new SSHSessionManager({
        maxSessions: 100,
        defaultTerminalSize: { cols: 120, rows: 40 },
      })
      assert.equal(m.sessionCount, 0)
    })
  })

  describe("session listing (initial state)", () => {
    it("should return empty list initially", () => {
      assert.deepEqual(manager.listSessions(), [])
    })

    it("should return empty count initially", () => {
      assert.equal(manager.sessionCount, 0)
    })

    it("should report no session exists", () => {
      assert.equal(manager.hasSession("nonexistent"), false)
    })

    it("should return undefined for nonexistent session", () => {
      assert.equal(manager.getSession("nonexistent"), undefined)
    })

    it("should return undefined for nonexistent lastActivity", () => {
      assert.equal(manager.getLastActivity("nonexistent"), undefined)
    })

    it("should return undefined for nonexistent connection", () => {
      assert.equal(manager.getConnection("nonexistent"), undefined)
    })

    it("should return empty for any status filter", () => {
      assert.deepEqual(manager.getSessionsByStatus("connecting"), [])
      assert.deepEqual(manager.getSessionsByStatus("connected"), [])
      assert.deepEqual(manager.getSessionsByStatus("error"), [])
      assert.deepEqual(manager.getSessionsByStatus("closed"), [])
    })
  })

  describe("connect validation", () => {
    it("should reject empty chain", async () => {
      await assert.rejects(
        () => manager.connect({ chain: [] }),
        { message: "Connection chain cannot be empty" },
      )
    })

    it("removes a failed connection attempt from session indexes", async () => {
      await connectExpectingFailure(manager, makeChain(["local"]), "test")

      assert.equal(manager.sessionCount, 0)
      assert.deepEqual(manager.listSessions(), [])
    })

    it("does not retain failed connections", async () => {
      await connectExpectingFailure(manager, makeChain(["host1"]))
      await connectExpectingFailure(manager, makeChain(["host2"]))
      await connectExpectingFailure(manager, makeChain(["host3"]))

      assert.equal(manager.sessionCount, 0)
    })
  })

  describe("max sessions limit", () => {
    it("failed connects do not consume the session quota", async () => {
      // More failed attempts than maxSessions: the quota must never be the
      // blocker — each attempt should fail with a connection error instead.
      for (let i = 0; i < 6; i++) {
        await assert.rejects(
          () => manager.connect({ chain: makeChain([`host${i}`]), timeout: 25 }),
          (err: Error) => {
            assert.notEqual(err.message, "Maximum concurrent sessions (5) reached")
            return true
          },
        )
      }
      // Failed connections are cleaned up, so nothing accumulates.
      assert.equal(manager.sessionCount, 0)
    })

    it("should enforce limit even with empty chain", async () => {
      // Empty chain is rejected before limit check
      await assert.rejects(
        () => manager.connect({ chain: [] }),
        { message: "Connection chain cannot be empty" },
      )
    })
  })

  describe("getSessionsByStatus", () => {
    it("should return empty for status with no sessions", async () => {
      await connectExpectingFailure(manager, makeChain(["host1"]))
      assert.deepEqual(manager.getSessionsByStatus("connected"), [])
      assert.deepEqual(manager.getSessionsByStatus("closed"), [])
      assert.deepEqual(manager.getSessionsByStatus("error"), [])
    })
  })

  describe("disconnect", () => {
    it("should reject disconnecting nonexistent session", async () => {
      await assert.rejects(
        () => manager.disconnect("nonexistent"),
        { message: "Session nonexistent not found" },
      )
    })
  })

  describe("disconnectAll", () => {
    it("should handle empty session list", async () => {
      await manager.disconnectAll()
      assert.equal(manager.sessionCount, 0)
    })
  })

  describe("events", () => {
    it("should emit session-event on connect attempt", async () => {
      const events: ConnectionEvent[] = []
      manager.on("session-event", (event: ConnectionEvent) => events.push(event))

      await connectExpectingFailure(manager, makeChain(["host1"]))

      // Connection failures still emit their event even though the session
      // entry is cleaned up afterwards.
      assert.ok(events.length > 0)
      assert.ok(events.some((e) => e.type === "error" || e.type === "connecting"))
    })
  })

  describe("retry after failure", () => {
    it("allows retrying the same configuration after a failed connection", async () => {
      const chain = makeChain(["retry-host"])

      await connectExpectingFailure(manager, chain)
      await connectExpectingFailure(manager, chain)

      assert.equal(manager.sessionCount, 0)
    })
  })
})
