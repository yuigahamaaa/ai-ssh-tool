/**
 * ProfileManager Tests
 * Tests CRUD, search, encryption, and persistence using temp directory
 */

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { ProfileManager } from "../profile-manager.js"
import type { SSHProfile } from "../types.js"

function makeProfile(overrides?: Partial<Omit<SSHProfile, "id">>): Omit<SSHProfile, "id"> {
  return {
    name: "test-profile",
    chain: [
      {
        name: "gateway",
        host: "10.0.0.1",
        port: 22,
        auth: { username: "jump", password: "jump123" },
      },
      {
        name: "target",
        host: "10.0.0.2",
        port: 22,
        auth: { username: "root", password: "root123" },
      },
    ],
    tags: ["prod", "web"],
    ...overrides,
  }
}

describe("ProfileManager", () => {
  let tmpDir: string
  let profilesPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "profile-test-"))
    profilesPath = join(tmpDir, "profiles.json")
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  describe("load", () => {
    it("should return empty list when file does not exist", () => {
      const pm = new ProfileManager(profilesPath)
      const profiles = pm.load()
      assert.deepEqual(profiles, [])
    })

    it("should load profiles from file", () => {
      const pm = new ProfileManager(profilesPath)
      pm.add(makeProfile())

      const pm2 = new ProfileManager(profilesPath)
      const profiles = pm2.load()
      assert.equal(profiles.length, 1)
      assert.equal(profiles[0].name, "test-profile")
    })

    it("should handle corrupt file gracefully", async () => {
      const { writeFileSync } = await import("fs")
      writeFileSync(profilesPath, "not-json", "utf-8")

      const pm = new ProfileManager(profilesPath)
      const profiles = pm.load()
      assert.deepEqual(profiles, [])
    })
  })

  describe("add", () => {
    it("should add a profile with generated ID", () => {
      const pm = new ProfileManager(profilesPath)
      pm.load()
      const profile = pm.add(makeProfile())

      assert.ok(profile.id)
      assert.equal(profile.name, "test-profile")
      assert.equal(profile.chain.length, 2)
    })

    it("should persist to disk", () => {
      const pm = new ProfileManager(profilesPath)
      pm.load()
      pm.add(makeProfile())

      assert.ok(existsSync(profilesPath))
      const raw = readFileSync(profilesPath, "utf-8")
      const data = JSON.parse(raw)
      assert.equal(data.length, 1)
    })
  })

  describe("get", () => {
    it("should get profile by ID", () => {
      const pm = new ProfileManager(profilesPath)
      pm.load()
      const added = pm.add(makeProfile())
      const found = pm.get(added.id)

      assert.ok(found)
      assert.equal(found!.id, added.id)
    })

    it("should return undefined for nonexistent ID", () => {
      const pm = new ProfileManager(profilesPath)
      pm.load()
      assert.equal(pm.get("nonexistent"), undefined)
    })
  })

  describe("getByName", () => {
    it("should get profile by name", () => {
      const pm = new ProfileManager(profilesPath)
      pm.load()
      pm.add(makeProfile({ name: "my-server" }))

      const found = pm.getByName("my-server")
      assert.ok(found)
      assert.equal(found!.name, "my-server")
    })

    it("should return undefined for nonexistent name", () => {
      const pm = new ProfileManager(profilesPath)
      pm.load()
      assert.equal(pm.getByName("nope"), undefined)
    })
  })

  describe("update", () => {
    it("should update profile fields", () => {
      const pm = new ProfileManager(profilesPath)
      pm.load()
      const added = pm.add(makeProfile())

      const updated = pm.update(added.id, { name: "renamed" })
      assert.equal(updated.name, "renamed")
      assert.equal(updated.id, added.id)
    })

    it("should persist updates", () => {
      const pm = new ProfileManager(profilesPath)
      pm.load()
      const added = pm.add(makeProfile())
      pm.update(added.id, { name: "renamed" })

      const pm2 = new ProfileManager(profilesPath)
      pm2.load()
      assert.equal(pm2.get(added.id)!.name, "renamed")
    })

    it("should reject updating nonexistent profile", () => {
      const pm = new ProfileManager(profilesPath)
      pm.load()
      assert.throws(
        () => pm.update("nonexistent", { name: "x" }),
        { message: "Profile nonexistent not found" },
      )
    })
  })

  describe("delete", () => {
    it("should delete profile", () => {
      const pm = new ProfileManager(profilesPath)
      pm.load()
      const added = pm.add(makeProfile())

      assert.equal(pm.delete(added.id), true)
      assert.equal(pm.get(added.id), undefined)
      assert.equal(pm.list().length, 0)
    })

    it("should return false for nonexistent ID", () => {
      const pm = new ProfileManager(profilesPath)
      pm.load()
      assert.equal(pm.delete("nonexistent"), false)
    })
  })

  describe("list", () => {
    it("should list all profiles", () => {
      const pm = new ProfileManager(profilesPath)
      pm.load()
      pm.add(makeProfile({ name: "a" }))
      pm.add(makeProfile({ name: "b" }))
      pm.add(makeProfile({ name: "c" }))

      assert.equal(pm.list().length, 3)
    })
  })

  describe("search", () => {
    it("should search by name", () => {
      const pm = new ProfileManager(profilesPath)
      pm.load()
      pm.add(makeProfile({ name: "prod-server", tags: ["web"] }))
      pm.add(makeProfile({ name: "dev-server", tags: ["dev"] }))

      const results = pm.search("prod")
      assert.equal(results.length, 1)
      assert.equal(results[0].name, "prod-server")
    })

    it("should search by tag", () => {
      const pm = new ProfileManager(profilesPath)
      pm.load()
      pm.add(makeProfile({ name: "a", tags: ["web", "prod"] }))
      pm.add(makeProfile({ name: "b", tags: ["db"] }))

      const results = pm.search("web")
      assert.equal(results.length, 1)
    })

    it("should be case insensitive", () => {
      const pm = new ProfileManager(profilesPath)
      pm.load()
      pm.add(makeProfile({ name: "PROD-server" }))

      assert.equal(pm.search("prod").length, 1)
    })
  })

  describe("recent", () => {
    it("should sort by lastUsed descending", () => {
      const pm = new ProfileManager(profilesPath)
      pm.load()
      const a = pm.add(makeProfile({ name: "a" }))
      const b = pm.add(makeProfile({ name: "b" }))

      pm.markUsed(a.id)
      pm.markUsed(b.id)
      pm.markUsed(a.id) // a is more recent

      const recent = pm.recent()
      assert.equal(recent[0].name, "a")
      assert.equal(recent[1].name, "b")
    })
  })

  describe("encryption", () => {
    it("should encrypt passwords on disk", () => {
      const pm = new ProfileManager(profilesPath, "test-key")
      pm.load()
      pm.add(makeProfile())

      const raw = readFileSync(profilesPath, "utf-8")
      const data = JSON.parse(raw)
      // Passwords should NOT be plaintext
      assert.notEqual(data[0].chain[0].auth.password, "jump123")
    })

    it("should decrypt passwords on load", () => {
      const pm = new ProfileManager(profilesPath, "test-key")
      pm.load()
      pm.add(makeProfile())

      const pm2 = new ProfileManager(profilesPath, "test-key")
      const profiles = pm2.load()
      assert.equal(profiles[0].chain[0].auth.password, "jump123")
      assert.equal(profiles[0].chain[1].auth.password, "root123")
    })

    it("should not encrypt without key", () => {
      const pm = new ProfileManager(profilesPath)
      pm.load()
      pm.add(makeProfile())

      const raw = readFileSync(profilesPath, "utf-8")
      const data = JSON.parse(raw)
      assert.equal(data[0].chain[0].auth.password, "jump123")
    })
  })

  describe("static helpers", () => {
    it("hostFromProfile should add ID", () => {
      const host = ProfileManager.hostFromProfile({
        name: "test",
        host: "10.0.0.1",
        port: 22,
        auth: { username: "root" },
      })
      assert.ok(host.id)
      assert.equal(host.host, "10.0.0.1")
    })

    it("chainFromProfile should add IDs to all hosts", () => {
      const pm = new ProfileManager(profilesPath)
      pm.load()
      const profile = pm.add(makeProfile())
      const chain = ProfileManager.chainFromProfile(profile)

      assert.equal(chain.length, 2)
      assert.ok(chain[0].id)
      assert.ok(chain[1].id)
      assert.notEqual(chain[0].id, chain[1].id)
    })
  })

  describe("normalizeProfile", () => {
    it("normalizes flat profile to auth format", () => {
      const flat = {
        name: "flat-test",
        chain: [
          { host: "10.0.0.1", port: 22, username: "root", password: "pass123" },
        ],
      }
      const normalized = ProfileManager.normalizeProfile(flat)
      assert.ok(normalized.chain[0].auth)
      assert.equal(normalized.chain[0].auth.username, "root")
      assert.equal(normalized.chain[0].auth.password, "pass123")
      assert.equal(normalized.chain[0].host, "10.0.0.1")
      assert.equal(normalized.chain[0].port, 22)
    })

    it("keeps auth profile unchanged", () => {
      const auth = {
        name: "auth-test",
        chain: [
          { name: "target", host: "10.0.0.2", port: 22, auth: { username: "deploy", privateKey: "KEY" } },
        ],
      }
      const normalized = ProfileManager.normalizeProfile(auth)
      assert.equal(normalized.chain[0].auth.username, "deploy")
      assert.equal(normalized.chain[0].auth.privateKey, "KEY")
      assert.equal((normalized.chain[0] as any).username, undefined)
    })

    it("throws on invalid profile missing chain", () => {
      assert.throws(
        () => ProfileManager.normalizeProfile({ name: "bad" }),
        { message: /missing chain/ },
      )
    })
  })
})
