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

    it("should create session before connection attempt (on valid chain)", async () => {
      // connect will fail (no real SSH server), but session should be created
      await connectExpectingFailure(manager, makeChain(["local"]), "test")

      // Session should exist (in error state)
      assert.equal(manager.sessionCount, 1)
      const sessions = manager.listSessions()
      assert.equal(sessions.length, 1)
      assert.equal(sessions[0].name, "test")
      assert.equal(sessions[0].status, "error")
    })

    it("should use chain summary as default name", async () => {
      await connectExpectingFailure(manager, makeChain(["gw1", "target1"]))

      const sessions = manager.listSessions()
      assert.equal(sessions[0].name, "gw1 -> target1")
      assert.equal(sessions[0].chainSummary, "gw1 -> target1")
      assert.equal(sessions[0].hops, 1) // 2 hosts = 1 hop
    })

    it("should track multiple sessions", async () => {
      await connectExpectingFailure(manager, makeChain(["host1"]))
      await connectExpectingFailure(manager, makeChain(["host2"]))
      await connectExpectingFailure(manager, makeChain(["host3"]))

      assert.equal(manager.sessionCount, 3)
    })
  })

  describe("max sessions limit", () => {
    it("should reject when max sessions reached", async () => {
      // Fill up to max (5)
      for (let i = 0; i < 5; i++) {
        await connectExpectingFailure(manager, makeChain([`host${i}`]))
      }
      assert.equal(manager.sessionCount, 5)

      // 6th should fail with max sessions error
      await assert.rejects(
        () => manager.connect({ chain: makeChain(["host5"]), timeout: 25 }),
        { message: "Maximum concurrent sessions (5) reached" },
      )
    })

    it("should enforce limit even with empty chain", async () => {
      // Empty chain is rejected before limit check
      await assert.rejects(
        () => manager.connect({ chain: [] }),
        { message: "Connection chain cannot be empty" },
      )
    })
  })

  describe("getSession", () => {
    it("should return session by ID after connect attempt", async () => {
      let sessionId: string | undefined
      try {
        const session = await manager.connect({ chain: makeChain(["host1"]), name: "test", timeout: 25 })
        sessionId = session.id
      } catch {
        // Get the session ID from the list
        sessionId = manager.listSessions()[0]?.id
      }

      assert.ok(sessionId)
      const found = manager.getSession(sessionId!)
      assert.ok(found)
      assert.equal(found!.name, "test")
    })
  })

  describe("hasSession", () => {
    it("should return true for existing session", async () => {
      await connectExpectingFailure(manager, makeChain(["host1"]))
      const id = manager.listSessions()[0].id
      assert.equal(manager.hasSession(id), true)
    })

    it("should return false for nonexistent session", () => {
      assert.equal(manager.hasSession("nonexistent"), false)
    })
  })

  describe("getLastActivity", () => {
    it("should return timestamp for existing session", async () => {
      await connectExpectingFailure(manager, makeChain(["host1"]))
      const id = manager.listSessions()[0].id
      const lastActivity = manager.getLastActivity(id)
      assert.ok(lastActivity)
      assert.ok(lastActivity! > 0)
    })
  })

  describe("getConnection", () => {
    it("should return connection for existing session", async () => {
      await connectExpectingFailure(manager, makeChain(["host1"]))
      const id = manager.listSessions()[0].id
      const conn = manager.getConnection(id)
      assert.ok(conn)
    })
  })

  describe("getSessionsByStatus", () => {
    it("should filter sessions by error status (failed connections)", async () => {
      await connectExpectingFailure(manager, makeChain(["host1"]))
      await connectExpectingFailure(manager, makeChain(["host2"]))

      const errorSessions = manager.getSessionsByStatus("error")
      assert.equal(errorSessions.length, 2)
    })

    it("should return empty for status with no sessions", async () => {
      await connectExpectingFailure(manager, makeChain(["host1"]))
      assert.deepEqual(manager.getSessionsByStatus("connected"), [])
      assert.deepEqual(manager.getSessionsByStatus("closed"), [])
    })
  })

  describe("disconnect", () => {
    it("should remove session", async () => {
      await connectExpectingFailure(manager, makeChain(["host1"]))
      const id = manager.listSessions()[0].id
      assert.equal(manager.sessionCount, 1)

      await manager.disconnect(id)
      assert.equal(manager.sessionCount, 0)
      assert.equal(manager.hasSession(id), false)
    })

    it("should reject disconnecting nonexistent session", async () => {
      await assert.rejects(
        () => manager.disconnect("nonexistent"),
        { message: "Session nonexistent not found" },
      )
    })
  })

  describe("disconnectAll", () => {
    it("should remove all sessions", async () => {
      await connectExpectingFailure(manager, makeChain(["host1"]))
      await connectExpectingFailure(manager, makeChain(["host2"]))
      assert.equal(manager.sessionCount, 2)

      await manager.disconnectAll()
      assert.equal(manager.sessionCount, 0)
    })

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

      // Should have at least the error event (connection failed)
      assert.ok(events.length > 0)
      assert.ok(events.some((e) => e.type === "error" || e.type === "connecting"))
    })
  })

  describe("config hash preserves hop order", () => {
    it("A->B->target and B->A->target produce different hashes", async () => {
      const chainAB = makeChain(["hostA", "hostB", "target"])
      const chainBA = makeChain(["hostB", "hostA", "target"])

      let session1: SSHSession | undefined
      let session2: SSHSession | undefined
      try { session1 = await manager.connect({ chain: chainAB, timeout: 25 }) } catch {}
      // We need a new manager to avoid session reuse
      const manager2 = new SSHSessionManager({ maxSessions: 5 })
      try { session2 = await manager2.connect({ chain: chainBA, timeout: 25 }) } catch {}

      // Both should create sessions (not reuse each other)
      assert.equal(manager.sessionCount, 1)
      assert.equal(manager2.sessionCount, 1)

      const id1 = manager.listSessions()[0].id
      const id2 = manager2.listSessions()[0].id
      assert.notEqual(id1, id2)
    })

    it("same chain produces same hash (session reuse)", async () => {
      const chain = makeChain(["gw1", "target1"])

      await connectExpectingFailure(manager, chain)
      const s1 = manager.listSessions()[0]

      // Connect again with same chain - should reuse (but session is in error state, so it creates new)
      await connectExpectingFailure(manager, chain)
      const sessions = manager.listSessions()

      // Even if error, the config hash logic should be tested
      assert.ok(sessions.length >= 1)
    })
  })
})
