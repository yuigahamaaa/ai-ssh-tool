import { describe, it } from "node:test"
import assert from "node:assert/strict"
import ssh2 from "ssh2"
import { createStableEd25519KeyPair } from "./ssh-test-key.js"

describe("createStableEd25519KeyPair", () => {
  it("retries generated keys until ssh2 can parse them", () => {
    const originalGenerate = ssh2.utils.generateKeyPairSync
    let attempts = 0

    try {
      ssh2.utils.generateKeyPairSync = ((type: any, opts?: any) => {
        attempts++
        const key = originalGenerate.call(ssh2.utils, type, opts)
        if (attempts === 1) {
          return { ...key, private: "-----BEGIN OPENSSH PRIVATE KEY-----\nbad\n-----END OPENSSH PRIVATE KEY-----" }
        }
        return key
      }) as typeof ssh2.utils.generateKeyPairSync

      const key = createStableEd25519KeyPair()

      assert.equal(attempts, 2)
      assert.ok(!((ssh2.utils as any).parseKey(key.private) instanceof Error))
    } finally {
      ssh2.utils.generateKeyPairSync = originalGenerate
    }
  })
})
