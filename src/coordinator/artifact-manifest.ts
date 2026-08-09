import { createHash, verify } from "crypto"

export interface CoordinatorArtifact {
  version: string
  protocolMajor: number
  platform: NodeJS.Platform
  arch: string
  fileName: string
  sha256: string
  signature: string
  size: number
}

export interface CoordinatorManifest {
  artifacts: CoordinatorArtifact[]
  publicKey: string
}

export function selectArtifact(platform: NodeJS.Platform, arch: string, manifest: CoordinatorManifest): CoordinatorArtifact {
  const artifact = manifest.artifacts.find((item) => item.platform === platform && item.arch === arch)
  if (!artifact) throw new Error(`ARTIFACT_UNSUPPORTED: no coordinator artifact for ${platform}/${arch}`)
  return artifact
}

export function verifyArtifact(artifact: CoordinatorArtifact, bytes: Uint8Array, publicKey: string): void {
  if (bytes.byteLength !== artifact.size) throw new Error("ARTIFACT_HASH_MISMATCH: artifact size mismatch")
  const digest = createHash("sha256").update(bytes).digest("hex")
  if (digest !== artifact.sha256.toLowerCase()) throw new Error("ARTIFACT_HASH_MISMATCH: artifact digest mismatch")
  const signature = Buffer.from(artifact.signature, "base64")
  if (!verify(null, Buffer.from(digest, "utf8"), publicKey, signature)) throw new Error("ARTIFACT_SIGNATURE_INVALID: artifact signature mismatch")
}
