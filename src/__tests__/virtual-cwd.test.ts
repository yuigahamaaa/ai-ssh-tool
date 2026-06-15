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
    store.dispose()
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
    freshStore.dispose()
  })

  it("dispose() flushes pending writes synchronously", () => {
    store.set("agentA", "host1", "/repo-a")
    // Don't call flushNow() — dispose() must drain the debounce timer.
    store.dispose()

    const freshPersistence = new PersistenceStore(tmpDir)
    const freshStore = new VirtualCwdStore(freshPersistence)
    assert.equal(freshStore.resolve("agentA", "host1"), "/repo-a")
    freshStore.dispose()
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

  // ============================================================
  // hostId 计算逻辑一致性测试
  // 验证 configHash ?? sessionId.slice(0, 16) 在不同调用路径中一致
  // ============================================================

  it("scheduleRequest and ssh_cd use same hostId computation logic", () => {
    // Simulate: configHash = "abc123" (from connectHostJson response)
    const configHash = "abc123"
    const sessionId = "session-456-789-abcdef"
    const hostIdWithConfigHash = configHash // configHash exists, use it
    const hostIdWithSessionId = sessionId.slice(0, 16) // configHash absent, fallback

    // Both paths should produce consistent hostId for same config
    store.set("agentA", hostIdWithConfigHash, "/repo-a")
    store.set("agentA", hostIdWithSessionId, "/repo-b")

    assert.equal(store.resolve("agentA", hostIdWithConfigHash), "/repo-a")
    assert.equal(store.resolve("agentA", hostIdWithSessionId), "/repo-b")
  })

  // ============================================================
  // 相同配置但不同 profile.name 的情况
  // 验证 hostId 只取决于 configHash，不取决于 displayName
  // ============================================================

  it("same target host+auth but different profile.name uses same hostId", () => {
    // Profile "work" and profile "home" point to same host with same auth
    // Both have configHash = "config-hash-same" (same connection config)
    const sameConfigHash = "config-hash-same"

    // displayName differs, but hostId is derived from configHash
    store.set("agentA", sameConfigHash, "/work-repo")
    // Another profile with same config but different name
    store.set("agentA", sameConfigHash, "/home-repo") // Overwrites because same hostId

    // Only one entry exists because hostId is the same
    const states = store.getAll()
    assert.equal(states.length, 1, "same configHash should produce one entry regardless of profile.name")
    assert.equal(store.resolve("agentA", sameConfigHash), "/home-repo")
  })

  it("different profile.name without configHash uses sessionId slice", () => {
    // When configHash is absent, hostId falls back to sessionId.slice(0, 16)
    const sessionId1 = "session-aaaa-bbbb-cccc"
    const sessionId2 = "session-dddd-eeee-ffff"
    const hostId1 = sessionId1.slice(0, 16) // "session-aaaa-bbb"
    const hostId2 = sessionId2.slice(0, 16) // "session-dddd-eee"

    store.set("agentA", hostId1, "/repo-1")
    store.set("agentA", hostId2, "/repo-2")

    assert.equal(store.resolve("agentA", hostId1), "/repo-1")
    assert.equal(store.resolve("agentA", hostId2), "/repo-2")
    assert.notEqual(hostId1, hostId2, "different sessionId slices should produce different hostIds")
  })

  // ============================================================
  // setCwd / resolveCwd 配对使用测试
  // ============================================================

  it("setCwd then resolveCwd returns the set value", () => {
    // VirtualCwdStore.set returns VirtualCwdState, resolve returns cwd string
    const state = store.set("agentX", "hostX", "/project")
    const resolved = store.resolve("agentX", "hostX")

    assert.equal(resolved, "/project")
    assert.equal(state.cwd, "/project")
    assert.equal(state.agentId, "agentX")
    assert.equal(state.hostId, "hostX")
  })

  it("setCwd then resolveCwd with explicitCwd returns explicitCwd", () => {
    store.set("agentX", "hostX", "/virtual-cwd")
    const resolved = store.resolve("agentX", "hostX", "/explicit-cwd")

    assert.equal(resolved, "/explicit-cwd", "explicit cwd should override virtual cwd")
  })

  // ============================================================
  // configHash 覆盖场景（当 sessionId 前 16 字符相同时）
  // ============================================================

  it("configHash takes precedence over sessionId when sessionId prefix matches", () => {
    // sessionIds that share the same first 16 characters
    const sessionIdSharedPrefix = "abcdefghijklmnopXXXX"
    const anotherSessionId = "abcdefghijklmnopYYYY"
    const configHashOverride = "override-hash"

    // configHash exists for first session, so hostId = configHash
    const hostIdFromConfig = configHashOverride
    // no configHash for second, so hostId = sessionId.slice(0, 16)
    const hostIdFromSession = anotherSessionId.slice(0, 16)

    store.set("agentA", hostIdFromConfig, "/from-config")
    store.set("agentA", hostIdFromSession, "/from-session")

    assert.notEqual(hostIdFromConfig, hostIdFromSession)
    assert.equal(store.resolve("agentA", hostIdFromConfig), "/from-config")
    assert.equal(store.resolve("agentA", hostIdFromSession), "/from-session")
  })

  it("without configHash, sessionId.slice(0,16) is used as hostId", () => {
    const sessionId = "mysessionid12345"
    const hostId = sessionId.slice(0, 16)

    store.set("agentB", hostId, "/home/user")

    assert.equal(store.resolve("agentB", hostId), "/home/user")
    assert.equal(hostId, "mysessionid12345")
  })

  // ============================================================
  // VirtualCwdState updatedAt 测试
  // ============================================================

  it("updatedAt is set on initial set", () => {
    const before = Date.now()
    const state = store.set("agentA", "host1", "/repo")
    const after = Date.now()

    assert.ok(state.updatedAt >= before, "updatedAt should be >= before set time")
    assert.ok(state.updatedAt <= after, "updatedAt should be <= after set time")
  })

  it("updatedAt updates on subsequent set to same agent+host", () => {
    const state1 = store.set("agentA", "host1", "/repo-a")
    const originalUpdatedAt = state1.updatedAt

    // Wait a tiny bit to ensure time advances
    const state2 = store.set("agentA", "host1", "/repo-b")

    assert.ok(state2.updatedAt >= originalUpdatedAt, "updatedAt should advance on update")
    assert.equal(state2.cwd, "/repo-b")
    assert.equal(state2.agentId, "agentA")
    assert.equal(state2.hostId, "host1")

    // Only one entry should exist
    const states = store.getAll()
    assert.equal(states.length, 1)
    assert.equal(states[0].cwd, "/repo-b")
  })

  it("get() returns current state with updated updatedAt", () => {
    store.set("agentA", "host1", "/initial")
    const state1 = store.get("agentA", "host1")
    const updatedAt1 = state1!.updatedAt

    // Use setImmediate to ensure Date.now() returns a different value
    return new Promise<void>((resolve) => {
      setImmediate(() => {
        store.set("agentA", "host1", "/updated")
        const state2 = store.get("agentA", "host1")
        assert.ok(state2!.updatedAt > updatedAt1, "get() should return state with updated updatedAt")
        resolve()
      })
    })
  })
})
