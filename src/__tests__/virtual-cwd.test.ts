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
    // Debounced write must be flushed before constructing a fresh store to
    // simulate a daemon restart.
    store.flushNow()

    const freshPersistence = new PersistenceStore(tmpDir)
    const freshStore = new VirtualCwdStore(freshPersistence)

    assert.equal(freshStore.resolve("agentA", "host1"), "/repo-a")
  })

  it("dispose() flushes pending writes synchronously", () => {
    store.set("agentA", "host1", "/repo-a")
    // Don't call flushNow() — dispose() must drain the debounce timer.
    store.dispose()

    const freshPersistence = new PersistenceStore(tmpDir)
    const freshStore = new VirtualCwdStore(freshPersistence)
    assert.equal(freshStore.resolve("agentA", "host1"), "/repo-a")
  })

  it("coalesces multiple sets in the debounce window into one disk write", () => {
    // Spy on saveVirtualCwdMap to count writes; it should be 1, not N.
    let writes = 0
    const originalSave = persistence.saveVirtualCwdMap.bind(persistence)
    persistence.saveVirtualCwdMap = (map) => {
      writes++
      return originalSave(map)
    }
    store.set("agentA", "host1", "/a")
    store.set("agentA", "host1", "/b")
    store.set("agentA", "host1", "/c")
    assert.equal(writes, 0, "no writes should happen before debounce timer fires")
    store.flushNow()
    assert.equal(writes, 1, "all three sets should coalesce into a single write")
  })
})
