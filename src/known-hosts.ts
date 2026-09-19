/**
 * OpenSSH known_hosts support for ssh2 host-key verification.
 *
 * Host-key verification is deliberately independent from login
 * authentication: this module only decides whether the server's identity is
 * known. It never asks for, changes, or inspects a password, private key, or
 * agent credential.
 */

import { accessSync, appendFileSync, constants, readFileSync } from "node:fs"
import { createHash, createHmac } from "node:crypto"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import type { StrictHostKeyChecking } from "./types.js"

export const DEFAULT_STRICT_HOST_KEY_CHECKING: StrictHostKeyChecking = "accept-new"
export const DEFAULT_KNOWN_HOSTS_PATH = join(homedir(), ".ssh", "known_hosts")

export interface HostKeyInfo {
  algorithm: string
  fingerprint: string
  keyBase64: string
}

export interface KnownHostVerificationResult {
  accepted: boolean
  warning?: string
  error?: HostKeyVerificationError
}

export interface KnownHostsStoreOptions {
  warn?: (message: string) => void
}

interface KnownHostEntry {
  lineNumber: number
  hostPatterns: string[]
  algorithm: string
  key: Buffer
  fingerprint: string
}

interface ReadResult {
  entries: KnownHostEntry[]
  readable: boolean
  missing: boolean
  reason?: string
}

/** Actionable error for a changed or unknown host key. */
export class HostKeyVerificationError extends Error {
  readonly host: string
  readonly port: number
  readonly algorithm: string
  readonly newFingerprint: string
  readonly oldFingerprints: string[]
  readonly knownHostsPath: string

  constructor(params: {
    host: string
    port: number
    algorithm: string
    newFingerprint: string
    oldFingerprints?: string[]
    knownHostsPath: string
    lineNumbers?: number[]
    reason: "changed" | "unknown"
  }) {
    const hostPort = formatHostPort(params.host, params.port)
    const oldFingerprints = params.oldFingerprints ?? []
    const lines = params.lineNumbers ?? []
    const oldText = oldFingerprints.length > 0
      ? oldFingerprints.map((fingerprint, index) => `line ${lines[index] ?? "?"}: ${fingerprint}`).join(", ")
      : "none"
    const reasonText = params.reason === "changed"
      ? `The server key changed; refusing the connection. Old fingerprint(s): ${oldText}.`
      : `No matching known_hosts entry exists; Old fingerprint(s): ${oldText}. Strict checking requires a previously recorded key.`
    const repairText = params.reason === "changed"
      ? `To repair, verify the new key, then delete ${params.knownHostsPath} line${lines.length === 1 ? "" : "s"} ${lines.join(", ")} and reconnect`
      : `To repair, verify the server key and add it to ${params.knownHostsPath}, then reconnect`

    super(
      `Host key verification failed for ${hostPort} (${params.algorithm}). `
      + `New fingerprint: ${params.newFingerprint}. `
      + `${reasonText} `
      + `${repairText}, or set this hop's strictHostKeyChecking: "no" `
      + `for a pooled/shared-address jump host. `
      + "Host-key verification is independent of login authentication; no password or extra credential is required.",
    )
    this.name = "HostKeyVerificationError"
    this.host = params.host
    this.port = params.port
    this.algorithm = params.algorithm
    this.newFingerprint = params.newFingerprint
    this.oldFingerprints = oldFingerprints
    this.knownHostsPath = params.knownHostsPath
  }
}

/** Expand `~` and resolve a configured known_hosts path. */
export function resolveKnownHostsPath(path?: string): string {
  const configured = path?.trim() || DEFAULT_KNOWN_HOSTS_PATH
  const expanded = configured === "~"
    ? homedir()
    : configured.startsWith("~/")
      ? join(homedir(), configured.slice(2))
      : configured
  return isAbsolute(expanded) ? resolve(expanded) : resolve(process.cwd(), expanded)
}

/** Return the OpenSSH host token used when appending a new entry. */
export function knownHostToken(host: string, port: number): string {
  const normalizedHost = stripBrackets(host)
  return port === 22 ? normalizedHost : `[${normalizedHost}]:${port}`
}

/** Extract the SSH algorithm and display fingerprint from a raw SSH key blob. */
export function describeHostKey(key: Buffer): HostKeyInfo {
  const algorithm = extractAlgorithm(key)
  const fingerprint = `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/u, "")}`
  return {
    algorithm,
    fingerprint,
    keyBase64: key.toString("base64"),
  }
}

/**
 * Read and verify a known_hosts file. Unknown keys are enrolled only by
 * append; existing lines are never rewritten or replaced.
 */
export class KnownHostsStore {
  readonly path: string
  private readonly warn: (message: string) => void

  constructor(path?: string, options?: KnownHostsStoreOptions) {
    this.path = resolveKnownHostsPath(path)
    this.warn = options?.warn ?? ((message) => console.warn(`[ssh-tool] ${message}`))
  }

  verify(
    host: string,
    port: number,
    key: Buffer,
    policy: StrictHostKeyChecking = DEFAULT_STRICT_HOST_KEY_CHECKING,
  ): KnownHostVerificationResult {
    const info = describeHostKey(key)

    // Explicitly omit hostVerifier in this mode at the connection layer. This
    // branch also makes the compatibility contract testable in isolation.
    if (policy === "no") return { accepted: true }

    const read = this.read()
    if (!read.readable) {
      if (policy === "accept-new" && read.missing) {
        const appended = this.append(host, port, info)
        if (appended) {
          const warning = `${this.path} did not exist; created it and recorded the first host key for ${formatHostPort(host, port)}.`
          this.warn(warning)
          return { accepted: true, warning }
        }
      }
      const warning = this.unavailableWarning(read.reason)
      this.warn(warning)
      return { accepted: true, warning }
    }

    const candidates = hostCandidates(host, port)
    const hostEntries = read.entries.filter((entry) => matchesHost(entry.hostPatterns, candidates))
    const exactEntry = hostEntries.find((entry) => entry.key.equals(key))
    if (exactEntry) return { accepted: true }

    if (hostEntries.length > 0) {
      const error = new HostKeyVerificationError({
        host,
        port,
        algorithm: info.algorithm,
        newFingerprint: info.fingerprint,
        oldFingerprints: hostEntries.map((entry) => entry.fingerprint),
        knownHostsPath: this.path,
        lineNumbers: hostEntries.map((entry) => entry.lineNumber),
        reason: "changed",
      })
      return { accepted: false, error }
    }

    if (policy === "yes") {
      if (!this.isWritable()) {
        const warning = `${this.path} is not writable; continuing without blocking host-key verification for ${formatHostPort(host, port)}.`
        this.warn(warning)
        return { accepted: true, warning }
      }
      const error = new HostKeyVerificationError({
        host,
        port,
        algorithm: info.algorithm,
        newFingerprint: info.fingerprint,
        knownHostsPath: this.path,
        reason: "unknown",
      })
      return { accepted: false, error }
    }

    // accept-new: enroll by append only. An append failure is deliberately a
    // warning, not a connection blocker, because storage availability must not
    // make an otherwise reachable host unusable.
    if (this.append(host, port, info)) return { accepted: true }
    const warning = `${this.path} could not be updated; continuing without blocking host-key verification for ${formatHostPort(host, port)}.`
    this.warn(warning)
    return { accepted: true, warning }
  }

  private read(): ReadResult {
    try {
      const content = readFileSync(this.path, "utf8")
      return { entries: parseKnownHosts(content), readable: true, missing: false }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      return {
        entries: [],
        readable: false,
        missing: code === "ENOENT",
        reason: `${code ?? "read error"}: ${(error as Error).message}`,
      }
    }
  }

  private append(host: string, port: number, info: HostKeyInfo): boolean {
    const line = `${knownHostToken(host, port)} ${info.algorithm} ${info.keyBase64}\n`
    try {
      // appendFileSync never replaces the file and mode only applies when a
      // missing file is created. The containing directory must already exist;
      // inability to persist is handled by the warning-only caller.
      appendFileSync(this.path, line, { encoding: "utf8", mode: 0o600 })
      return true
    } catch {
      return false
    }
  }

  private isWritable(): boolean {
    try {
      accessSync(this.path, constants.W_OK)
      return true
    } catch {
      return false
    }
  }

  private unavailableWarning(reason?: string): string {
    return `Cannot read known_hosts file ${this.path}${reason ? ` (${reason})` : ""}; continuing without blocking host-key verification.`
  }
}

function parseKnownHosts(content: string): KnownHostEntry[] {
  const entries: KnownHostEntry[] = []
  const lines = content.split(/\r?\n/u)
  for (let index = 0; index < lines.length; index++) {
    const trimmed = lines[index].trim()
    if (!trimmed || trimmed.startsWith("#")) continue

    const fields = trimmed.split(/\s+/u)
    if (fields[0].startsWith("@")) fields.shift()
    if (fields.length < 3) continue

    const [hostField, algorithm, keyBase64] = fields
    let key: Buffer
    try {
      key = Buffer.from(keyBase64, "base64")
    } catch {
      continue
    }
    if (key.length === 0) continue

    entries.push({
      lineNumber: index + 1,
      hostPatterns: hostField.split(","),
      algorithm,
      key,
      fingerprint: describeHostKey(key).fingerprint,
    })
  }
  return entries
}

function hostCandidates(host: string, port: number): string[] {
  const normalizedHost = stripBrackets(host)
  const exact = host
  const lower = normalizedHost.toLowerCase()
  const bracketed = `[${normalizedHost}]:${port}`
  const candidates = port === 22
    ? [exact, normalizedHost, lower, bracketed, `[${lower}]:22`]
    : [bracketed, `[${lower}]:${port}`]
  return [...new Set(candidates)]
}

function matchesHost(patterns: string[], candidates: string[]): boolean {
  for (const pattern of patterns) {
    if (pattern.startsWith("|1|")) {
      const [, version, saltBase64, hashBase64] = pattern.split("|")
      if (version !== "1") continue
      if (!saltBase64 || !hashBase64) continue
      let salt: Buffer
      try {
        salt = Buffer.from(saltBase64, "base64")
      } catch {
        continue
      }
      for (const candidate of candidates) {
        const digest = createHmac("sha1", salt).update(candidate).digest("base64")
        if (digest === hashBase64) return true
      }
      continue
    }

    if (candidates.includes(pattern) || candidates.includes(pattern.toLowerCase())) return true
  }
  return false
}

function extractAlgorithm(key: Buffer): string {
  if (key.length < 4) return "unknown"
  const length = key.readUInt32BE(0)
  if (length <= 0 || 4 + length > key.length) return "unknown"
  return key.subarray(4, 4 + length).toString("utf8")
}

function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host
}

function formatHostPort(host: string, port: number): string {
  const normalizedHost = stripBrackets(host)
  return normalizedHost.includes(":") ? `[${normalizedHost}]:${port}` : `${normalizedHost}:${port}`
}
