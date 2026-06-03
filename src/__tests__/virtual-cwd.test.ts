import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { VirtualCwdStore } from "../scheduler/virtual-cwd-store.js"
import { PersistenceStore } from "../scheduler/persistence-store.js"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

describe("VirtualCwdStore", () => {
  let tmpDir: string
  let persistence: PersistenceStore
  let store: VirtualCwdStore

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "vcwd-test-"))
    persistence = new PersistenceStore(tmpDir)
    store = new VirtualCwdStore(persistence)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("agent isolation: different agents on same host get different cwd", () => {
    store.set("agentA", "host1", "/repo-a")
    store.set("agentB", "host1", "/repo-b")

    assert.equal(store.resolve("agentA", "host1"), "/repo-a")
    assert.equal(store.resolve("agentB", "host1"), "/repo-b")
  })

  it("host isolation: same agent on different hosts get different cwd", () => {
    store.set("agentA", "host1", "/repo-a")
    store.set("agentA", "host2", "/repo-b")

    assert.equal(store.resolve("agentA", "host1"), "/repo-a")
    assert.equal(store.resolve("agentA", "host2"), "/repo-b")
  })

  it("explicit cwd overrides virtual cwd", () => {
    store.set("agentA", "host1", "/repo-a")
    assert.equal(store.resolve("agentA", "host1", "/tmp"), "/tmp")
  })

  it("no cwd returns undefined", () => {
    assert.equal(store.resolve("agentA", "host1"), undefined)
  })

  it("persists to disk and reloads", () => {
    store.set("agentA", "host1", "/repo-a")

    const freshPersistence = new PersistenceStore(tmpDir)
    const freshStore = new VirtualCwdStore(freshPersistence)

    assert.equal(freshStore.resolve("agentA", "host1"), "/repo-a")
  })
})
