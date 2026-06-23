import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { CommandRegistryStore } from "../command-registry.js"
import { _resetPathsForTest } from "../paths.js"

describe("CommandRegistryStore", () => {
  let tmpDir: string
  let store: CommandRegistryStore

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "command-registry-"))
    store = new CommandRegistryStore(tmpDir)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("registers and retrieves a command by project and name", () => {
    const saved = store.register({
      project: "ssh-tool",
      name: "test",
      description: "Run tests",
      command: "npm test",
      cwd: "/repo/ssh-tool",
      execution: {
        mode: "schedule",
        intent: "test",
        cost: "large",
      },
    })

    assert.equal(saved.schemaVersion, 1)
    assert.equal(saved.project, "ssh-tool")
    assert.equal(saved.name, "test")
    assert.equal(saved.execution.mode, "schedule")
    assert.equal(saved.log.mode, "managed")
    assert.ok(saved.createdAt > 0)
    assert.equal(saved.updatedAt, saved.createdAt)

    assert.deepEqual(store.get("ssh-tool", "test"), saved)
  })

  it("lists commands by project sorted by name", () => {
    store.register({ project: "ssh-tool", name: "z-build", command: "npm run build" })
    store.register({ project: "ssh-tool", name: "a-test", command: "npm test" })
    store.register({ project: "other", name: "test", command: "pytest" })

    assert.deepEqual(store.list("ssh-tool").map(c => c.name), ["a-test", "z-build"])
    assert.deepEqual(store.list().map(c => `${c.project}/${c.name}`), [
      "other/test",
      "ssh-tool/a-test",
      "ssh-tool/z-build",
    ])
  })

  it("defaults unspecific commands to managed background execution", () => {
    const saved = store.register({ project: "ssh-tool", name: "lint", command: "npm run lint" })

    assert.equal(saved.execution.mode, "background")
    assert.equal(saved.execution.cost, "large")
  })

  it("updates and deletes commands", () => {
    store.register({ project: "ssh-tool", name: "test", command: "npm test" })

    const updated = store.update("ssh-tool", "test", {
      command: "npm run test:fast",
      execution: { mode: "exec", intent: "test", cost: "medium" },
    })

    assert.equal(updated?.command, "npm run test:fast")
    assert.equal(updated?.execution.mode, "exec")
    assert.equal(updated?.execution.intent, "test")
    assert.equal(updated?.execution.cost, "medium")

    assert.equal(store.delete("ssh-tool", "test"), true)
    assert.equal(store.get("ssh-tool", "test"), undefined)
    assert.equal(store.delete("ssh-tool", "missing"), false)
  })

  it("ignores undefined update fields so partial MCP patches preserve existing values", () => {
    store.register({
      project: "ssh-tool",
      name: "test",
      description: "old",
      command: "npm test",
      cwd: "/repo",
    })

    const updated = store.update("ssh-tool", "test", {
      description: "new",
      command: undefined,
      cwd: undefined,
      execution: undefined,
    })

    assert.equal(updated?.description, "new")
    assert.equal(updated?.command, "npm test")
    assert.equal(updated?.cwd, "/repo")
  })

  it("loads legacy array format and normalizes defaults", () => {
    const stateDir = join(tmpDir, "state")
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, "commands.json"), JSON.stringify([
      {
        project: "legacy",
        name: "dev",
        description: "start dev server",
        command: "npm run dev",
        cwd: "/repo/legacy",
        mode: "background",
      },
    ]))

    const loaded = new CommandRegistryStore(tmpDir)
    const command = loaded.get("legacy", "dev")

    assert.equal(command?.schemaVersion, 1)
    assert.equal(command?.execution.mode, "background")
    assert.equal(command?.execution.intent, "server")
    assert.equal(command?.execution.cost, "large")
    assert.equal(command?.log.mode, "managed")
  })

  it("persists schema envelope for compatibility", () => {
    store.register({ project: "ssh-tool", name: "test", command: "npm test" })

    const raw = JSON.parse(readFileSync(join(tmpDir, "state", "commands.json"), "utf8"))

    assert.equal(raw.schemaVersion, 1)
    assert.equal(Array.isArray(raw.commands), true)
    assert.equal(raw.commands[0].project, "ssh-tool")
    assert.equal(raw.commands[0].name, "test")
  })

  it("uses the scheduler state directory when no baseDir override is supplied", () => {
    const originalDataDir = process.env.SSH_TOOL_DATA_DIR
    const isolatedDataDir = mkdtempSync(join(tmpdir(), "command-registry-data-"))

    try {
      _resetPathsForTest()
      process.env.SSH_TOOL_DATA_DIR = isolatedDataDir

      const defaultStore = new CommandRegistryStore()
      defaultStore.register({ project: "ssh-tool", name: "test", command: "npm test" })

      assert.equal(existsSync(join(isolatedDataDir, "scheduler", "state", "commands.json")), true)
    } finally {
      if (originalDataDir === undefined) delete process.env.SSH_TOOL_DATA_DIR
      else process.env.SSH_TOOL_DATA_DIR = originalDataDir
      _resetPathsForTest()
      rmSync(isolatedDataDir, { recursive: true, force: true })
    }
  })

  it("merges concurrent registrations from separate store instances", () => {
    const first = new CommandRegistryStore(tmpDir)
    const second = new CommandRegistryStore(tmpDir)

    first.register({ project: "ssh-tool", name: "test", command: "npm test" })
    second.register({ project: "ssh-tool", name: "build", command: "npm run build" })

    const loaded = new CommandRegistryStore(tmpDir)
    assert.deepEqual(loaded.list("ssh-tool").map(c => c.name), ["build", "test"])
  })

  it("applies concurrent updates and deletes against latest persisted state", () => {
    store.register({ project: "ssh-tool", name: "test", command: "npm test" })
    store.register({ project: "ssh-tool", name: "build", command: "npm run build" })

    const updater = new CommandRegistryStore(tmpDir)
    const deleter = new CommandRegistryStore(tmpDir)

    updater.update("ssh-tool", "test", { command: "npm run test:fast" })
    deleter.delete("ssh-tool", "build")

    const loaded = new CommandRegistryStore(tmpDir)
    assert.equal(loaded.get("ssh-tool", "test")?.command, "npm run test:fast")
    assert.equal(loaded.get("ssh-tool", "build"), undefined)
  })
})
