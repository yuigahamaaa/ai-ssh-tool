import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  createRequest,
  encodeMessage,
  parseMessages,
} from "../ipc-protocol.js"
import type { IPCRequest } from "../ipc-protocol.js"

describe("IPC Scheduler Actions", () => {
  it("createRequest supports schedule action", () => {
    const req = createRequest("schedule", {
      agent: { id: "a1", clientType: "mcp" },
      host: { id: "h1", profileKey: "pk1", targetHost: "host", targetUser: "user", displayName: "host" },
      sessionId: "s1",
      command: "echo ok",
    })
    assert.equal(req.action, "schedule")
    assert.ok(req.id)
    assert.ok((req as any).params)
    assert.equal((req as any).params.command, "echo ok")
  })

  it("createRequest supports queueStatus action", () => {
    const req = createRequest("queueStatus", { hostId: "h1" })
    assert.equal(req.action, "queueStatus")
    assert.equal((req as any).params.hostId, "h1")
  })

  it("createRequest supports waitTask action", () => {
    const req = createRequest("waitTask", { taskId: "t1", timeoutMs: 5000 })
    assert.equal(req.action, "waitTask")
    assert.equal((req as any).params.taskId, "t1")
  })

  it("createRequest supports dequeueTask action", () => {
    const req = createRequest("dequeueTask", { taskId: "t1" })
    assert.equal(req.action, "dequeueTask")
    assert.equal((req as any).params.taskId, "t1")
  })

  it("createRequest supports task output/status cleanup actions", () => {
    const outputReq = createRequest("getTaskOutput", { taskId: "t1", mode: "tail" })
    const statusReq = createRequest("getTaskStatus", { taskId: "t1" })
    const cleanupReq = createRequest("cleanupOutputs", {})

    assert.equal(outputReq.action, "getTaskOutput")
    assert.equal((statusReq as any).params.taskId, "t1")
    assert.equal(cleanupReq.action, "cleanupOutputs")
  })

  it("createRequest supports abortActiveTasks action", () => {
    const req = createRequest("abortActiveTasks", { reason: "fatal shutdown" })
    assert.equal(req.action, "abortActiveTasks")
    assert.equal((req as any).params.reason, "fatal shutdown")
  })

  it("createRequest supports setCwd action", () => {
    const req = createRequest("setCwd", {
      agent: { id: "a1", clientType: "mcp" },
      host: { id: "h1", profileKey: "pk1", targetHost: "host", targetUser: "user", displayName: "host" },
      cwd: "/repo",
    })
    assert.equal(req.action, "setCwd")
    assert.equal((req as any).params.cwd, "/repo")
  })

  it("encode/decode new request preserves action and params", () => {
    const req = createRequest("schedule", {
      agent: { id: "a1", clientType: "mcp" },
      host: { id: "h1", profileKey: "pk1", targetHost: "host", targetUser: "user", displayName: "host" },
      sessionId: "s1",
      command: "npm test",
    })

    const encoded = encodeMessage(req)
    let decoded: any = null
    parseMessages(Buffer.from(encoded), (msg) => { decoded = msg })

    assert.ok(decoded)
    assert.equal(decoded.action, "schedule")
    assert.equal(decoded.params.command, "npm test")
  })
})
