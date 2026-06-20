/**
 * SSH Profile Manager - saves/loads SSH connection profiles
 * Supports password obfuscation (NOT encryption!)
 * 
 * SECURITY WARNING:
 * - The XOR-based "encryption" is NOT cryptographically secure!
 * - It only provides basic obfuscation against accidental exposure.
 * - For production environments, use a system keychain (keytar/keychain) or proper encryption.
 * - Profile files are saved with 600 permissions (owner-only read/write) to limit exposure.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, statSync } from "fs"
import { dirname, join } from "path"
import { randomUUID } from "crypto"
import { homedir } from "os"
import type { SSHHostConfig, SSHProfile } from "./types.js"

/**
 * Get user data directory with cross-platform support.
 */
function getUserDataDir(): string {
  if (process.platform === "win32") {
    const userProfile = process.env.USERPROFILE || process.env.HOMEPATH
    if (userProfile) return userProfile
  }
  return homedir()
}

const DEFAULT_PROFILES_DIR = join(
  getUserDataDir(),
  ".opencode",
  "ssh",
)

/**
 * LRU cache for loadFromFile().
 *
 * loadFromFile() is called on every MCP tool invocation (profile lookup,
 * ssh_exec, ssh_upload, ssh_list_tasks, ...). Each call walks 4 search
 * paths and readFileSync + JSON.parse's the first hit. The cache is keyed
 * by the resolved file path and invalidated when the file's mtime changes,
 * so editor workflows ("edit JSON, save, retry") get fresh content while
 * hot paths skip the disk entirely.
 */
type CacheEntry = { profile: SSHProfile; mtimeMs: number }
const fileCache: Map<string, CacheEntry> = new Map()
const CACHE_MAX = 32

function cacheGet(path: string): SSHProfile | undefined {
  const cached = fileCache.get(path)
  if (!cached) return undefined
  // mtime check: if file changed on disk, drop the entry
  let stat: import("fs").Stats
  try {
    stat = statSync(path)
  } catch {
    fileCache.delete(path)
    return undefined
  }
  if (stat.mtimeMs !== cached.mtimeMs) {
    fileCache.delete(path)
    return undefined
  }
  // LRU touch: re-insert so the entry moves to the tail of the iteration order
  fileCache.delete(path)
  fileCache.set(path, cached)
  return cached.profile
}

function cachePut(path: string, profile: SSHProfile, mtimeMs: number): void {
  fileCache.set(path, { profile, mtimeMs })
  if (fileCache.size > CACHE_MAX) {
    // Map iteration order is insertion order; the first key is the oldest.
    const oldest = fileCache.keys().next().value
    if (oldest !== undefined) fileCache.delete(oldest)
  }
}

/** Clear the LRU cache. Exposed for tests and explicit invalidation. */
export function clearProfileCache(): void {
  fileCache.clear()
}

export class ProfileManager {
  private profilesPath: string
  private profiles: SSHProfile[] = []
  private encryptionKey: string | null = null

  constructor(profilesPath?: string, encryptionKey?: string) {
    this.profilesPath = profilesPath ?? join(DEFAULT_PROFILES_DIR, "profiles.json")
    this.encryptionKey = encryptionKey ?? null
  }

  /** Load profiles from disk */
  load(): SSHProfile[] {
    if (!existsSync(this.profilesPath)) {
      this.profiles = []
      return this.profiles
    }

    try {
      const raw = readFileSync(this.profilesPath, "utf-8")
      const data = JSON.parse(raw)
      const loaded = Array.isArray(data) ? data : (data.profiles ?? [])
      this.profiles = loaded.map((profile: Record<string, unknown>) => ProfileManager.normalizeProfile(profile))

      // Decrypt passwords if key is set
      if (this.encryptionKey) {
        for (const profile of this.profiles) {
          this.decryptProfile(profile)
        }
      }
    } catch {
      this.profiles = []
    }

    return this.profiles
  }

  /** Save profiles to disk */
  save(): void {
    const dir = dirname(this.profilesPath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
      // Set directory permissions to 700
      try {
        chmodSync(dir, 0o700)
      } catch {
        // Non-fatal, but log warning
        console.warn("[ProfileManager] Could not set directory permissions to 700")
      }
    }

    let data = this.profiles
    if (this.encryptionKey) {
      data = this.profiles.map((p) => this.encryptProfile(p))
    }

    writeFileSync(this.profilesPath, JSON.stringify(data, null, 2), "utf-8")
    // Set file permissions to 600 (owner read/write only)
    try {
      chmodSync(this.profilesPath, 0o600)
    } catch {
      // Non-fatal, but log warning
      console.warn("[ProfileManager] Could not set file permissions to 600")
    }
  }

  /** Add a new profile */
  add(profile: Omit<SSHProfile, "id">): SSHProfile {
    const normalized = ProfileManager.normalizeProfile(profile as unknown as Record<string, unknown>)
    const newProfile: SSHProfile = {
      ...normalized,
      id: randomUUID(),
    }
    this.profiles.push(newProfile)
    this.save()
    return newProfile
  }

  /** Update an existing profile */
  update(id: string, updates: Partial<Omit<SSHProfile, "id">>): SSHProfile {
    const idx = this.profiles.findIndex((p) => p.id === id)
    if (idx < 0) throw new Error(`Profile ${id} not found`)

    this.profiles[idx] = ProfileManager.normalizeProfile({ ...this.profiles[idx], ...updates, id })
    this.save()
    return this.profiles[idx]
  }

  /** Delete a profile */
  delete(id: string): boolean {
    const idx = this.profiles.findIndex((p) => p.id === id)
    if (idx < 0) return false
    this.profiles.splice(idx, 1)
    this.save()
    return true
  }

  /** Get a profile by ID */
  get(id: string): SSHProfile | undefined {
    return this.profiles.find((p) => p.id === id)
  }

  /** Get a profile by name */
  getByName(name: string): SSHProfile | undefined {
    return this.profiles.find((p) => p.name === name)
  }

  /** Get a profile by alias */
  getByAlias(alias: string): SSHProfile | undefined {
    return this.profiles.find((p) => p.alias === alias)
  }

  /**
   * 从文件路径加载配置，支持多路径搜索
   * 搜索顺序：
   * 1. 绝对路径直接查找
   * 2. 当前目录下的 profiles/ 文件夹
   * 3. 项目根目录（ssh-tool 上一级）的 profiles/ 文件夹
   * 4. 用户主目录的 .ssh-tool/profiles/
   *
   * 命中后按文件路径 mtime 做 LRU 缓存：MCP 每个工具调用都会走这里，
   * 同样的 profileName 反复加载时跳过 readFileSync + JSON.parse。
   */
  loadFromFile(profileFile: string): SSHProfile | undefined {
    const searchPaths = [
      profileFile,
      join(process.cwd(), "profiles", profileFile),
      join(process.cwd(), "..", "profiles", profileFile),
      join(homedir(), ".ssh-tool", "profiles", profileFile),
    ]

    for (const searchPath of searchPaths) {
      if (!existsSync(searchPath)) continue

      // Cache hit: same path, same mtime → return cached profile.
      const cached = cacheGet(searchPath)
      if (cached) return cached

      // Cache miss: read, parse, normalize, store.
      const raw = readFileSync(searchPath, "utf-8")
      const profile = ProfileManager.normalizeProfile(JSON.parse(raw))
      const mtimeMs = statSync(searchPath).mtimeMs
      cachePut(searchPath, profile, mtimeMs)
      return profile
    }

    return undefined
  }

  static normalizeProfile(data: Record<string, unknown>): SSHProfile {
    if (!data || !Array.isArray(data.chain)) {
      throw new Error("Invalid profile: missing chain array")
    }
    return {
      ...data,
      chain: (data.chain as Record<string, unknown>[]).map((hop: Record<string, unknown>) => {
        if (hop.auth) return hop as unknown as Omit<SSHHostConfig, "id">
        const { host, port, name, username, password, privateKey, passphrase, ...rest } = hop as Record<string, unknown>
        return {
          ...rest,
          name: name ?? host,
          host,
          port: port ?? 22,
          auth: { username, password, privateKey, passphrase },
        } as unknown as Omit<SSHHostConfig, "id">
      }),
    } as unknown as SSHProfile
  }

  /** List all profiles */
  list(): SSHProfile[] {
    return [...this.profiles]
  }

  /** Search profiles by name, alias or tag */
  search(query: string): SSHProfile[] {
    const q = query.toLowerCase()
    return this.profiles.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.alias?.toLowerCase().includes(q) ||
        p.tags?.some((t) => t.toLowerCase().includes(q))
    )
  }

  /** Mark a profile as recently used */
  markUsed(id: string): void {
    const profile = this.profiles.find((p) => p.id === id)
    if (profile) {
      profile.lastUsed = Date.now()
      this.save()
    }
  }

  /** Get profiles sorted by most recently used */
  recent(): SSHProfile[] {
    return [...this.profiles].sort(
      (a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0)
    )
  }

  /**
   * Generate a host config with a unique ID from a profile chain entry
   */
  static hostFromProfile(
    host: Omit<SSHHostConfig, "id">,
  ): SSHHostConfig {
    return { ...host, id: randomUUID() }
  }

  /**
   * Convert a profile's chain to SSHHostConfig[]
   */
  static chainFromProfile(profile: SSHProfile): SSHHostConfig[] {
    return profile.chain.map(ProfileManager.hostFromProfile)
  }

  /**
   * Simple XOR-based obfuscation for password storage.
   * WARNING: This is NOT cryptographically secure! It only provides basic obfuscation.
   * For production use, consider using a system keychain or proper encryption library.
   */
  private encrypt(text: string): string {
    if (!this.encryptionKey) return text
    const key = this.encryptionKey
    let result = ""
    for (let i = 0; i < text.length; i++) {
      result += String.fromCharCode(
        text.charCodeAt(i) ^ key.charCodeAt(i % key.length),
      )
    }
    return Buffer.from(result).toString("base64")
  }

  private decrypt(text: string): string {
    if (!this.encryptionKey) return text
    const key = this.encryptionKey
    const decoded = Buffer.from(text, "base64").toString()
    let result = ""
    for (let i = 0; i < decoded.length; i++) {
      result += String.fromCharCode(
        decoded.charCodeAt(i) ^ key.charCodeAt(i % key.length),
      )
    }
    return result
  }

  private encryptProfile(profile: SSHProfile): SSHProfile {
    return {
      ...profile,
      chain: profile.chain.map((host) => ({
        ...host,
        auth: {
          ...host.auth,
          password: host.auth.password
            ? this.encrypt(host.auth.password)
            : undefined,
          passphrase: host.auth.passphrase
            ? this.encrypt(host.auth.passphrase)
            : undefined,
        },
      })),
    }
  }

  private decryptProfile(profile: SSHProfile): void {
    for (const host of profile.chain) {
      if (host.auth.password) {
        host.auth.password = this.decrypt(host.auth.password)
      }
      if (host.auth.passphrase) {
        host.auth.passphrase = this.decrypt(host.auth.passphrase)
      }
    }
  }
}
