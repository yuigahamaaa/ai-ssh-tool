import ssh2 from "ssh2"

type KeyPair = ReturnType<typeof ssh2.utils.generateKeyPairSync>

export function createStableEd25519KeyPair(): KeyPair {
  for (let attempt = 0; attempt < 100; attempt++) {
    const key = ssh2.utils.generateKeyPairSync("ed25519")
    if (!((ssh2.utils as any).parseKey(key.private) instanceof Error)) {
      return key
    }
  }
  throw new Error("Unable to generate a parseable ed25519 SSH test key")
}
