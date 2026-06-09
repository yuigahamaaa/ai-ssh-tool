/**
 * SSH Config Parser - parses ~/.ssh/config and resolves hostnames to connection chains
 *
 * Supports: Host, HostName, User, Port, IdentityFile, ProxyJump, ForwardAgent, Include
 */

import { readFileSync, existsSync } from "fs"
import { homedir } from "os"
import { join, resolve } from "path"
import type { SSHConnectionChain, SSHHostConfig } from "./types.js"

export interface SSHConfigHostEntry {
  hostPattern: string
  hostName?: string
  user?: string
  port?: number
  identityFile?: string[]
  proxyJump?: string[]
  forwardAgent?: boolean
  identityAgent?: string
}

export interface SSHConfig {
  hosts: SSHConfigHostEntry[]
  resolve(hostname: string): SSHConnectionChain
  getHost(hostname: string): Partial<SSHConfigHostEntry>
}

// --- Parsing ---

function parseLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith("#")) return null
  const idx = trimmed.indexOf(" ")
  if (idx === -1) return null
  const key = trimmed.slice(0, idx).toLowerCase()
  const value = trimmed.slice(idx + 1).trim()
  return { key, value }
}

function parseContent(content: string, baseDir: string): SSHConfigHostEntry[] {
  const entries: SSHConfigHostEntry[] = []
  let currentGroup: SSHConfigHostEntry[] | null = null

  for (const line of content.split(/\r?\n/)) {
    const parsed = parseLine(line)
    if (!parsed) continue
    const { key, value } = parsed

    if (key === "host") {
      // Multiple patterns on one line: Host web1 web2 *.corp.com
      const patterns = value.split(/\s+/).filter(Boolean)
      currentGroup = patterns.map(pattern => ({ hostPattern: pattern }))
      entries.push(...currentGroup)
      continue
    }

    if (key === "include") {
      // Include can be relative to ~/.ssh or absolute
      const includePath = value.startsWith("/") || value.match(/^[A-Z]:\\/i)
        ? value
        : join(baseDir, value)
      try {
        if (existsSync(includePath)) {
          const includeContent = readFileSync(includePath, "utf-8")
          const includeDir = resolve(includePath, "..")
          entries.push(...parseContent(includeContent, includeDir))
        }
      } catch {
        // ignore unreadable includes
      }
      continue
    }

    if (!currentGroup || currentGroup.length === 0) continue

    switch (key) {
      case "hostname":
        for (const c of currentGroup) c.hostName = value
        break
      case "user":
        for (const c of currentGroup) c.user = value
        break
      case "port":
        for (const c of currentGroup) c.port = parseInt(value, 10)
        break
      case "identityfile":
        for (const c of currentGroup) {
          c.identityFile = c.identityFile ?? []
          c.identityFile.push(value)
        }
        break
      case "proxyjump":
        // ProxyJump can be comma-separated: jump1,jump2
        for (const c of currentGroup) {
          c.proxyJump = value.split(",").map(s => s.trim()).filter(Boolean)
        }
        break
      case "forwardagent":
        for (const c of currentGroup) c.forwardAgent = value.toLowerCase() === "yes"
        break
      case "identityagent":
        for (const c of currentGroup) c.identityAgent = value
        break
    }
  }

  return entries
}

function matchHost(pattern: string, hostname: string): boolean {
  // Convert SSH host pattern to regex: * -> .*, ? -> .
  const regexStr = "^" + pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".") + "$"
  return new RegExp(regexStr, "i").test(hostname)
}

function mergeEntries(entries: SSHConfigHostEntry[]): Partial<SSHConfigHostEntry> {
  const merged: Partial<SSHConfigHostEntry> = {}
  for (const entry of entries) {
    if (entry.hostName !== undefined) merged.hostName = entry.hostName
    if (entry.user !== undefined) merged.user = entry.user
    if (entry.port !== undefined) merged.port = entry.port
    if (entry.identityFile !== undefined) merged.identityFile = entry.identityFile
    if (entry.proxyJump !== undefined) merged.proxyJump = entry.proxyJump
    if (entry.forwardAgent !== undefined) merged.forwardAgent = entry.forwardAgent
    if (entry.identityAgent !== undefined) merged.identityAgent = entry.identityAgent
  }
  return merged
}

function hostIdCounter(): () => string {
  let n = 0
  return () => `ssh-cfg-${n++}`
}

function resolveHostToChain(
  hostname: string,
  allEntries: SSHConfigHostEntry[],
  genId: () => string,
  visited: Set<string>,
): SSHConnectionChain {
  if (visited.has(hostname)) return [] // prevent circular ProxyJump
  visited.add(hostname)

  // Find all matching Host entries (in order) and merge
  const matching = allEntries.filter(e => matchHost(e.hostPattern, hostname))
  const cfg = mergeEntries(matching)

  // If no HostName is set, use the original hostname
  const resolvedHost = cfg.hostName ?? hostname
  const port = cfg.port ?? 22
  const user = cfg.user ?? "root"

  // Resolve ProxyJump chain first
  const chain: SSHConnectionChain = []

  if (cfg.proxyJump && cfg.proxyJump.length > 0) {
    for (const jump of cfg.proxyJump) {
      if (jump === "none") continue
      // jump can be [user@]host[:port]
      const jumpChain = resolveHostToChain(jump, allEntries, genId, visited)
      chain.push(...jumpChain)
    }
  }

  // Read identity file if specified
  let privateKey: string | undefined
  if (cfg.identityFile && cfg.identityFile.length > 0) {
    const keyPath = cfg.identityFile[0].replace(/^~/, homedir())
    try {
      if (existsSync(keyPath)) {
        privateKey = readFileSync(keyPath, "utf-8")
      }
    } catch {
      // ignore unreadable key files
    }
  }

  // Add the target host
  chain.push({
    id: genId(),
    name: hostname,
    host: resolvedHost,
    port,
    auth: {
      username: user,
      privateKey,
      agent: cfg.identityAgent,
      agentForward: cfg.forwardAgent,
    },
  })

  return chain
}

// --- Public API ---

/** Parse SSH config content from a string */
export function parseSSHConfigContent(content: string, baseDir?: string): SSHConfig {
  const entries = parseContent(content, baseDir ?? homedir())

  return {
    hosts: entries,

    resolve(hostname: string): SSHConnectionChain {
      const genId = hostIdCounter()
      return resolveHostToChain(hostname, entries, genId, new Set())
    },

    getHost(hostname: string): Partial<SSHConfigHostEntry> {
      const matching = entries.filter(e => matchHost(e.hostPattern, hostname))
      return mergeEntries(matching)
    },
  }
}

/** Parse ~/.ssh/config (or a custom path) */
export function parseSSHConfig(configPath?: string): SSHConfig {
  const defaultPath = join(homedir(), ".ssh", "config")
  const filePath = configPath ?? defaultPath

  if (!existsSync(filePath)) {
    // Return empty config if file doesn't exist
    return parseSSHConfigContent("", resolve(filePath, ".."))
  }

  const content = readFileSync(filePath, "utf-8")
  const baseDir = resolve(filePath, "..")
  return parseSSHConfigContent(content, baseDir)
}
