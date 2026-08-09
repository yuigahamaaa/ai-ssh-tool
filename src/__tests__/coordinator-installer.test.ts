import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createHash, generateKeyPairSync, sign } from "crypto"
import { existsSync, mkdtempSync, readlinkSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { CoordinatorInstaller } from "../coordinator/installer.js"
import type { CoordinatorManifest } from "../coordinator/artifact-manifest.js"

function fixture(healthy: boolean) {
  const bytes = Buffer.from("coordinator-binary")
  const keys = generateKeyPairSync("ed25519")
  const digest = createHash("sha256").update(bytes).digest("hex")
  const manifest: CoordinatorManifest = { publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(), artifacts: [{ version: "1.0.0", protocolMajor: 1, platform: process.platform, arch: process.arch, fileName: "server-main.js", sha256: digest, signature: sign(null, Buffer.from(digest), keys.privateKey).toString("base64"), size: bytes.length }] }
  return { bytes, manifest, keys, healthy }
}

describe("coordinator installer", () => {
  it("verifies and atomically switches a healthy release", async () => {
    const dir = mkdtempSync(join(tmpdir(), "coordinator-install-"))
    const item = fixture(true)
    const installer = new CoordinatorInstaller({ rootDir: dir, publicKey: item.manifest.publicKey, manifest: item.manifest, healthCheck: async () => item.healthy })
    const result = await installer.install("1.0.0", item.bytes)
    assert.equal(result.installed, true)
    assert.equal(readlinkSync(join(dir, "current")).endsWith("releases/1.0.0"), true)
    rmSync(dir, { recursive: true, force: true })
  })

  it("rejects bad artifacts and preserves an existing release", async () => {
    const dir = mkdtempSync(join(tmpdir(), "coordinator-install-"))
    const item = fixture(false)
    const installer = new CoordinatorInstaller({ rootDir: dir, publicKey: item.manifest.publicKey, manifest: item.manifest, healthCheck: async () => true })
    const first = await installer.install("1.0.0", item.bytes)
    assert.equal(first.installed, true)
    const bad = await installer.install("2.0.0", Buffer.from("tampered"))
    assert.equal(bad.installed, false)
    assert.equal(existsSync(join(dir, "current")), true)
    rmSync(dir, { recursive: true, force: true })
  })

  it("keeps the old current release when health check fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "coordinator-install-"))
    const item = fixture(true)
    let healthy = true
    const installer = new CoordinatorInstaller({ rootDir: dir, publicKey: item.manifest.publicKey, manifest: item.manifest, healthCheck: async () => healthy })
    await installer.install("1.0.0", item.bytes)
    healthy = false
    const second = await installer.install("2.0.0", item.bytes)
    assert.equal(second.installed, false)
    assert.equal(readlinkSync(join(dir, "current")).endsWith("releases/1.0.0"), true)
    rmSync(dir, { recursive: true, force: true })
  })
})
