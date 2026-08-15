import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { resolvePrivateKeyContent } from "../private-key.js"

const PEM_ED25519 = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAA",
  "-----END OPENSSH PRIVATE KEY-----",
  "",
].join("\n")

const PEM_PUBLIC = "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE\n-----END PUBLIC KEY-----\n"
const PUBKEY_ONELINER = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGV4YW1wbGU= user@host"

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ssh-tool-key-"))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe("resolvePrivateKeyContent", () => {
  it("reads key content from an absolute file path", () => {
    const keyPath = join(tmp, "id_ed25519")
    writeFileSync(keyPath, PEM_ED25519, "utf-8")
    assert.equal(resolvePrivateKeyContent(keyPath), PEM_ED25519)
  })

  it("resolves relative key paths against cwd", () => {
    const keyPath = join(tmp, "id_ed25519")
    writeFileSync(keyPath, PEM_ED25519, "utf-8")
    const prevCwd = process.cwd()
    try {
      process.chdir(tmp)
      assert.equal(resolvePrivateKeyContent("id_ed25519"), PEM_ED25519)
    } finally {
      process.chdir(prevCwd)
    }
  })

  it("passes inline PEM content through unchanged", () => {
    assert.equal(resolvePrivateKeyContent(PEM_ED25519), PEM_ED25519)
  })

  it("accepts RSA and EC PEM headers", () => {
    const rsa = "-----BEGIN RSA PRIVATE KEY-----\nTU9DSw==\n-----END RSA PRIVATE KEY-----\n"
    assert.equal(resolvePrivateKeyContent(rsa), rsa)
  })

  it("normalizes CRLF line endings to LF with a single trailing newline", () => {
    const crlf =
      "-----BEGIN OPENSSH PRIVATE KEY-----\r\nc29tZS1jcnRsZg==\r\n-----END OPENSSH PRIVATE KEY-----\r\n\r\n"
    const expected =
      "-----BEGIN OPENSSH PRIVATE KEY-----\nc29tZS1jcnRsZg==\n-----END OPENSSH PRIVATE KEY-----\n"
    assert.equal(resolvePrivateKeyContent(crlf), expected)
  })

  it("throws a clear error when the value is a public key", () => {
    assert.throws(() => resolvePrivateKeyContent(PUBKEY_ONELINER), /public key/i)
    assert.throws(() => resolvePrivateKeyContent(PEM_PUBLIC), /public key/i)
  })

  it("throws a clear error when a path-like value does not exist", () => {
    assert.throws(() => resolvePrivateKeyContent(join(tmp, "missing-key")), /does not exist/i)
  })

  it("rejects empty values", () => {
    assert.throws(() => resolvePrivateKeyContent("   "), /Empty private key/)
  })
})
