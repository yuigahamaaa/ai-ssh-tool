/**
 * SSHSessionManager Unit Tests
 * Tests session lifecycle, limits, lookups, and event handling
 * Note: connect() tests wrap in try-catch since no real SSH server is available
 */

import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { SSHSessionManager } from "../session-manager.js"
import type { SSHConnectionChain, ConnectionEvent } from "../types.js"

function makeChain(hosts: string[]): SSHConnectionChain {
  return hosts.map((host, i) => ({
    id: `host-${i}`,
    name: host,
    host,
    port: 22,
    auth: { username: "testuser", password: "testpass" },
  }))
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
      try {
        await manager.connect({ chain: makeChain(["127.0.0.1"]), name: "test" })
      } catch {
        // expected to fail
      }

      // Session should exist (in error state)
      assert.equal(manager.sessionCount, 1)
      const sessions = manager.listSessions()
      assert.equal(sessions.length, 1)
      assert.equal(sessions[0].name, "test")
      assert.equal(sessions[0].status, "error")
    })

    it("should use chain summary as default name", async () => {
      try {
        await manager.connect({ chain: makeChain(["gw1", "target1"]) })
      } catch {
        // expected
      }

      const sessions = manager.listSessions()
      assert.equal(sessions[0].name, "gw1 -> target1")
      assert.equal(sessions[0].chainSummary, "gw1 -> target1")
      assert.equal(sessions[0].hops, 1) // 2 hosts = 1 hop
    })

    it("should track multiple sessions", async () => {
      try { await manager.connect({ chain: makeChain(["host1"]) }) } catch {}
      try { await manager.connect({ chain: makeChain(["host2"]) }) } catch {}
      try { await manager.connect({ chain: makeChain(["host3"]) }) } catch {}

      assert.equal(manager.sessionCount, 3)
    })
  })

  describe("max sessions limit", () => {
    it("should reject when max sessions reached", async () => {
      // Fill up to max (5)
      for (let i = 0; i < 5; i++) {
        try { await manager.connect({ chain: makeChain([`host${i}`]) }) } catch {}
      }
      assert.equal(manager.sessionCount, 5)

      // 6th should fail with max sessions error
      await assert.rejects(
        () => manager.connect({ chain: makeChain(["host5"]) }),
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
        const session = await manager.connect({ chain: makeChain(["host1"]), name: "test" })
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
      try { await manager.connect({ chain: makeChain(["host1"]) }) } catch {}
      const id = manager.listSessions()[0].id
      assert.equal(manager.hasSession(id), true)
    })

    it("should return false for nonexistent session", () => {
      assert.equal(manager.hasSession("nonexistent"), false)
    })
  })

  describe("getLastActivity", () => {
    it("should return timestamp for existing session", async () => {
      try { await manager.connect({ chain: makeChain(["host1"]) }) } catch {}
      const id = manager.listSessions()[0].id
      const lastActivity = manager.getLastActivity(id)
      assert.ok(lastActivity)
      assert.ok(lastActivity! > 0)
    })
  })

  describe("getConnection", () => {
    it("should return connection for existing session", async () => {
      try { await manager.connect({ chain: makeChain(["host1"]) }) } catch {}
      const id = manager.listSessions()[0].id
      const conn = manager.getConnection(id)
      assert.ok(conn)
    })
  })

  describe("getSessionsByStatus", () => {
    it("should filter sessions by error status (failed connections)", async () => {
      try { await manager.connect({ chain: makeChain(["host1"]) }) } catch {}
      try { await manager.connect({ chain: makeChain(["host2"]) }) } catch {}

      const errorSessions = manager.getSessionsByStatus("error")
      assert.equal(errorSessions.length, 2)
    })

    it("should return empty for status with no sessions", async () => {
      try { await manager.connect({ chain: makeChain(["host1"]) }) } catch {}
      assert.deepEqual(manager.getSessionsByStatus("connected"), [])
      assert.deepEqual(manager.getSessionsByStatus("closed"), [])
    })
  })

  describe("disconnect", () => {
    it("should remove session", async () => {
      try { await manager.connect({ chain: makeChain(["host1"]) }) } catch {}
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
      try { await manager.connect({ chain: makeChain(["host1"]) }) } catch {}
      try { await manager.connect({ chain: makeChain(["host2"]) }) } catch {}
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

      try { await manager.connect({ chain: makeChain(["host1"]) }) } catch {}

      // Should have at least the error event (connection failed)
      assert.ok(events.length > 0)
      assert.ok(events.some((e) => e.type === "error" || e.type === "connecting"))
    })
  })
})
