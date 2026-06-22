import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  guidanceForTaskStatus,
  guidanceForTransferResult,
  guidanceForWaitResult,
  mcpEnvelope,
  scheduleDecisionEnvelope,
} from "../mcp-response.js"
import type { ScheduleDecision, ScheduledTask, TaskOutputResult } from "../scheduler/types.js"

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "t_1",
    agentId: "agent-1",
    hostId: "host-1",
    profileKey: "profile-1",
    sessionId: "session-1",
    command: "npm test",
    classification: {
      intent: "test",
      cost: "large",
      blocking: true,
      mutates: false,
      risky: false,
      source: "auto",
      reason: "test command",
    },
    scheduler: "auto",
    status: "running",
    updatedAt: Date.now(),
    stdoutTail: "",
    stderrTail: "",
    stdoutBytes: 0,
    stderrBytes: 0,
    ...overrides,
  }
}

function output(overrides: Partial<TaskOutputResult> = {}): TaskOutputResult {
  return {
    stdout: "tail",
    stderr: "",
    stdoutBytes: 4,
    stderrBytes: 0,
    stdoutPath: "/tmp/t_1.stdout",
    stderrPath: "/tmp/t_1.stderr",
    outputFiles: {
      stdout: "/tmp/t_1.stdout",
      stderr: "/tmp/t_1.stderr",
    },
    truncated: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutFileTruncated: false,
    stderrFileTruncated: false,
    ...overrides,
  }
}

describe("MCP response envelopes", () => {
  it("keeps schedule decision fields at the top level while adding a uniform envelope", () => {
    const decision: ScheduleDecision = {
      action: "queued",
      taskId: "t_1",
      queuePosition: 1,
      reason: "Host busy",
    }

    const wrapped = scheduleDecisionEnvelope(decision)

    assert.equal(wrapped.ok, true)
    assert.equal(wrapped.kind, "schedule_decision")
    assert.equal(wrapped.action, "queued")
    assert.equal(wrapped.taskId, "t_1")
    assert.deepEqual(wrapped.data, decision)
    assert.ok(wrapped.agentGuidance.some(g => g.includes("Do not immediately resubmit")))
  })

  it("adds truncation guidance for completed task status", () => {
    const t = task({ status: "completed" })
    const o = output({ truncated: true, stdoutTruncated: true })

    const guidance = guidanceForTaskStatus(t, o)

    assert.ok(guidance.some(g => g.includes("Task completed")))
    assert.ok(guidance.some(g => g.includes("Output is truncated inline")))
  })

  it("marks wait timeout as a non-rerun situation", () => {
    const guidance = guidanceForWaitResult(task({ status: "running" }), true)

    assert.equal(guidance.length, 1)
    assert.ok(guidance[0].includes("Do not rerun"))
  })

  it("wraps auxiliary tool data with ok/kind/data/agentGuidance", () => {
    const wrapped = mcpEnvelope("cancel_result", { taskId: "t_1", cancelled: false }, ["check status"])

    assert.deepEqual(wrapped, {
      ok: true,
      kind: "cancel_result",
      data: { taskId: "t_1", cancelled: false },
      agentGuidance: ["check status"],
    })
  })

  it("gives transfer results binary-safe guidance with bytes and checksum", () => {
    const guidance = guidanceForTransferResult("download", {
      success: true,
      path: "/tmp/requested.txt.1",
      finalPath: "/tmp/requested.txt.1",
      requestedPath: "/tmp/requested.txt",
      action: "downloaded",
      targetType: "file",
      size: 5,
      sourceBytes: 5,
      bytesTransferred: 5,
      checksum: { algorithm: "sha256", destination: "abc123" },
      verification: { sizeMatched: true },
    })

    assert.ok(guidance.some(g => g.includes("Final local path: /tmp/requested.txt.1")))
    assert.ok(guidance.some(g => g.includes("Requested destination was /tmp/requested.txt")))
    assert.ok(guidance.some(g => g.includes("Transferred 5 bytes from 5 source bytes")))
    assert.ok(guidance.some(g => g.includes("sha256 checksum: abc123")))
    assert.ok(guidance.some(g => g.includes("binary-safe")))
    assert.ok(guidance.some(g => g.includes("do not use shell/base64")))
  })
})
