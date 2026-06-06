import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { handleDaemonExec } from "../cli/daemon-commands.js"

class FakeDaemonClient {
  ensured = false
  disconnected = false
  execCalled = false
  connectedConfigJson: string | undefined
  scheduled: any

  async ensureDaemon(): Promise<void> {
    this.ensured = true
  }

  async connectHostJson(configJson: string): Promise<any> {
    this.connectedConfigJson = configJson
    return {
      ok: true,
      data: {
        sessionId: "sess-1234567890abcdef",
        configHash: "cfg-123",
      },
    }
  }

  async connectHost(_configPath: string): Promise<any> {
    throw new Error("connectHost should not be used for --config-json")
  }

  async schedule(req: Record<string, unknown>): Promise<any> {
    this.scheduled = req
    return {
      ok: true,
      data: {
        action: "queued",
        taskId: "t_1",
        queuePosition: 1,
        reason: "busy",
      },
    }
  }

  async exec(): Promise<any> {
    this.execCalled = true
    throw new Error("exec should not be called by daemon exec")
  }

  disconnect(): void {
    this.disconnected = true
  }
}

describe("CLI scheduler contract", () => {
  let originalExitCode: string | number | null | undefined
  let logs: string[]
  let errors: string[]
  let originalLog: typeof console.log
  let originalError: typeof console.error

  beforeEach(() => {
    originalExitCode = process.exitCode
    process.exitCode = undefined
    logs = []
    errors = []
    originalLog = console.log
    originalError = console.error
    console.log = (...args: any[]) => { logs.push(args.join(" ")) }
    console.error = (...args: any[]) => { errors.push(args.join(" ")) }
  })

  afterEach(() => {
    process.exitCode = originalExitCode
    console.log = originalLog
    console.error = originalError
  })

  it("daemon exec defaults to scheduler=auto and sends ScheduleRequest instead of raw exec", async () => {
    const fake = new FakeDaemonClient()
    const configJson = JSON.stringify({
      target: { host: "vm.example.com", username: "deploy", port: 22 },
    })

    await handleDaemonExec([
      "--config-json", configJson,
      "--command", "npm test",
      "--reason", "verify",
      "--intent", "test",
      "--cost", "large",
      "--urgency", "high",
      "--if-busy", "queue",
      "--cwd", "/repo",
      "--timeout", "60000",
      "--force",
    ], { clientFactory: () => fake as any })

    assert.equal(fake.ensured, true)
    assert.equal(fake.connectedConfigJson, configJson)
    assert.equal(fake.execCalled, false)
    assert.equal(fake.disconnected, true)
    assert.equal(process.exitCode, 0)

    assert.equal(fake.scheduled.scheduler, "auto")
    assert.equal(fake.scheduled.command, "npm test")
    assert.equal(fake.scheduled.cwd, "/repo")
    assert.equal(fake.scheduled.reason, "verify")
    assert.equal(fake.scheduled.intent, "test")
    assert.equal(fake.scheduled.cost, "large")
    assert.equal(fake.scheduled.urgency, "high")
    assert.equal(fake.scheduled.ifBusy, "queue")
    assert.equal(fake.scheduled.timeoutMs, 60000)
    assert.equal(fake.scheduled.force, true)
    assert.equal(fake.scheduled.agent.clientType, "cli")
    assert.equal(fake.scheduled.host.id, "cfg-123")
    assert.equal(fake.scheduled.host.targetHost, "vm.example.com")
    assert.equal(fake.scheduled.host.targetUser, "deploy")
    assert.ok(logs.join("\n").includes('"action": "queued"'))
  })

  it("daemon exec preserves explicit scheduler=bypass", async () => {
    const fake = new FakeDaemonClient()
    const configJson = JSON.stringify({
      target: { host: "vm.example.com", username: "deploy" },
    })

    await handleDaemonExec([
      "--config-json", configJson,
      "--command", "rg TODO src",
      "--scheduler", "bypass",
    ], { clientFactory: () => fake as any })

    assert.equal(fake.scheduled.scheduler, "bypass")
    assert.equal(fake.scheduled.command, "rg TODO src")
  })
})
