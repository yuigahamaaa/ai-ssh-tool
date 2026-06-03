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

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "fs"
import { dirname, join } from "path"
import { randomUUID } from "crypto"
import type { SSHHostConfig, SSHProfile } from "./types.js"

const DEFAULT_PROFILES_DIR = join(
  process.env.HOME ?? process.env.USERPROFILE ?? ".",
  ".opencode",
  "ssh",
)

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
      this.profiles = Array.isArray(data) ? data : (data.profiles ?? [])

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
    const newProfile: SSHProfile = {
      ...profile,
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

    this.profiles[idx] = { ...this.profiles[idx], ...updates, id }
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
   */
  loadFromFile(profileFile: string): SSHProfile | undefined {
    const searchPaths = [
      profileFile,
      join(process.cwd(), "profiles", profileFile),
      join(process.cwd(), "..", "profiles", profileFile),
      join(process.env.HOME ?? ".", ".ssh-tool", "profiles", profileFile),
    ]

    for (const searchPath of searchPaths) {
      if (existsSync(searchPath)) {
        const raw = readFileSync(searchPath, "utf-8")
        return ProfileManager.normalizeProfile(JSON.parse(raw))
      }
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
