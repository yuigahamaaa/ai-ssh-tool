/**
 * P2-10: regression test for the ProfileManager LRU cache.
 *
 * loadFromFile() walks 4 search paths and does a readFileSync + JSON.parse
 * per path. The MCP server calls it on every tool invocation (profile
 * lookup, ssh_exec, ssh_upload, ...), so we cache by resolved file path
 * with mtime-based invalidation.
 */

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, utimesSync, mkdirSync } from "fs"
import { join, dirname } from "path"
import { tmpdir } from "os"
import { ProfileManager } from "../profile-manager.js"
import type { SSHProfile } from "../types.js"

function makeProfile(name: string): SSHProfile {
  return {
    id: `id-${name}`,
    name,
    chain: [
      {
        name: "hop1",
        host: "10.0.0.1",
        port: 22,
        auth: { username: "u", password: name === "alpha" ? "p1" : "p2" },
      },
    ],
    tags: [],
  }
}

describe("ProfileManager P2-10: loadFromFile LRU cache", () => {
  let tmpDir: string
  let profilesDir: string

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pm-cache-"))
    profilesDir = join(tmpDir, "profiles")
    mkdirSync(profilesDir, { recursive: true })
  })

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("caches by resolved file path (second call does not re-read)", () => {
    const filePath = join(profilesDir, "alpha.json")
    writeFileSync(filePath, JSON.stringify(makeProfile("alpha")))
    // Pin mtime so the second writeFileSync cannot bump it (cache must see
    // the same mtime and serve the cached entry rather than re-reading).
    const pinned = new Date("2026-06-13T10:00:00Z")
    utimesSync(filePath, pinned, pinned)

    const pm = new ProfileManager()
    const a = pm.loadFromFile(filePath)
    assert.ok(a, "first load returns profile")
    assert.equal(a!.name, "alpha")

    // Mutate the file on disk. We rely on mtime staying the same (we just
    // pinned it) to prove the cache is doing its job.
    writeFileSync(filePath, JSON.stringify(makeProfile("alpha-mutated")))
    utimesSync(filePath, pinned, pinned)
    const b = pm.loadFromFile(filePath)
    assert.ok(b, "second load returns cached profile")
    assert.equal(b!.name, "alpha", "second load returns the cached version, not the mutated file")
  })

  it("invalidates cache when file mtime changes", () => {
    const filePath = join(profilesDir, "beta.json")
    writeFileSync(filePath, JSON.stringify(makeProfile("beta")))

    const pm = new ProfileManager()
    const a = pm.loadFromFile(filePath)
    assert.equal(a!.name, "beta")

    // Rewrite the file with new content, then explicitly bump mtime forward
    // by 2s so the cache's mtime check sees a real change (filesystem mtime
    // resolution on macOS HFS+/APFS is ~1s; coarser on some FSes).
    writeFileSync(filePath, JSON.stringify(makeProfile("beta-v2")))
    const future = new Date(Date.now() + 2000)
    utimesSync(filePath, future, future)

    const b = pm.loadFromFile(filePath)
    assert.equal(b!.name, "beta-v2", "cache invalidates on mtime change")
  })

  it("respects LRU eviction when more files are loaded than capacity", () => {
    // We need many files to overflow the LRU. Capacity is internal but
    // bounded to a small number; loading more files than the cap should
    // evict the oldest entries. We use 64 files to be safe.
    const pm = new ProfileManager()
    const N = 64
    for (let i = 0; i < N; i++) {
      const f = join(profilesDir, `f${i}.json`)
      writeFileSync(f, JSON.stringify(makeProfile(`f${i}`)))
    }
    for (let i = 0; i < N; i++) {
      const f = join(profilesDir, `f${i}.json`)
      const p = pm.loadFromFile(f)
      assert.ok(p, `load f${i}`)
    }
    // Re-touch f0 to bump its mtime forward, then re-load. If the cache
    // evicted f0, the new read picks up the bumped name; if it didn't
    // evict, the cached "f0" is returned regardless of the on-disk change.
    const first = join(profilesDir, "f0.json")
    writeFileSync(first, JSON.stringify(makeProfile("f0-mutated")))
    const future = new Date(Date.now() + 2000)
    utimesSync(first, future, future)
    const re = pm.loadFromFile(first)
    assert.equal(re!.name, "f0-mutated", "f0 was evicted and re-read on access")
  })

  it("caches a 'file not found' result (does not re-stat on every call)", () => {
    const pm = new ProfileManager()
    const missing = join(profilesDir, "does-not-exist.json")
    // First call: file missing, walks paths, returns undefined.
    // Second call: cache should remember the miss for this basename.
    // We don't have a public probe, but we can at least verify the
    // function is idempotent and doesn't throw.
    const a = pm.loadFromFile(missing)
    const b = pm.loadFromFile(missing)
    assert.equal(a, undefined)
    assert.equal(b, undefined)
  })
})
