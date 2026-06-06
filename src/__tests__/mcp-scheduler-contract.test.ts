import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createMcpScheduleRequest, profileToLegacyConfigJson } from "../mcp-scheduler-contract.js"
import type { SSHProfile } from "../types.js"

function profile(): SSHProfile {
  return {
    id: "p1",
    name: "prod",
    chain: [
      {
        name: "jump",
        host: "jump.example.com",
        port: 22,
        auth: { username: "jump-user" },
      },
      {
        name: "target",
        host: "target.example.com",
        port: 2222,
        auth: { username: "deploy", password: "secret" },
      },
    ],
  }
}

describe("MCP scheduler contract", () => {
  it("builds ssh_exec ScheduleRequest with scheduler=auto by default and preserves agent parameters", () => {
    const req = createMcpScheduleRequest({
      profile: profile(),
      sessionId: "sess-1234567890abcdef",
      configHash: "cfg-abc",
      agentId: "mcp-agent",
      command: "npm test",
      cwd: "/repo",
      reason: "verify changes",
      intent: "test",
      cost: "large",
      urgency: "high",
      if_busy: "queue",
      force: true,
      timeout: 60000,
    })

    assert.equal(req.scheduler, "auto")
    assert.equal(req.agent.id, "mcp-agent")
    assert.equal(req.agent.clientType, "mcp")
    assert.equal(req.host.id, "cfg-abc")
    assert.equal(req.host.targetHost, "target.example.com")
    assert.equal(req.host.targetUser, "deploy")
    assert.equal(req.command, "npm test")
    assert.equal(req.cwd, "/repo")
    assert.equal(req.reason, "verify changes")
    assert.equal(req.intent, "test")
    assert.equal(req.cost, "large")
    assert.equal(req.urgency, "high")
    assert.equal(req.ifBusy, "queue")
    assert.equal(req.force, true)
    assert.equal(req.timeoutMs, 60000)
  })

  it("allows explicit bypass but still builds a scheduler-visible request", () => {
    const req = createMcpScheduleRequest({
      profile: profile(),
      sessionId: "sess-abcdef",
      agentId: "mcp-agent",
      command: "rg TODO src",
      scheduler: "bypass",
    })

    assert.equal(req.scheduler, "bypass")
    assert.equal(req.host.id, "sess-abcdef")
    assert.equal(req.host.profileKey, "sess-abcdef")
    assert.equal(req.command, "rg TODO src")
  })

  it("converts profile chain to daemon legacy config json", () => {
    const config = JSON.parse(profileToLegacyConfigJson(profile()))

    assert.deepEqual(config.gateways, [{
      host: "jump.example.com",
      port: 22,
      username: "jump-user",
    }])
    assert.deepEqual(config.target, {
      host: "target.example.com",
      port: 2222,
      username: "deploy",
      password: "secret",
    })
  })
})
