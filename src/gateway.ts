/**
 * SSH Gateway - the main facade that ties everything together
 *
 * This is the primary API for using SSH gateway functionality.
 * It composes:
 * - SSHSessionManager (concurrent connections)
 * - ProfileManager (saved configs)
 * - Remote tools (file ops, shell exec via SSH)
 */

import { SSHSessionManager } from "./session-manager.js"
import { ProfileManager } from "./profile-manager.js"
import { createRemoteTools, type RemoteTools } from "./remote-tools.js"
import { detectAndCache } from "./remote-dialect/index.js"
import { log } from "./logger.js"
import type {
  ConnectionOptions,
  SSHConnectionChain,
  SSHGatewayPluginConfig,
  SSHProfile,
  SSHSession,
  SSHHostConfig,
  SSHHostKeyOptions,
} from "./types.js"

export class SSHGateway {
  readonly sessions: SSHSessionManager
  readonly profiles: ProfileManager
  private activeTools = new Map<string, RemoteTools>()
  private config: SSHGatewayPluginConfig

  constructor(config?: SSHGatewayPluginConfig) {
    this.config = config ?? {}
    this.profiles = new ProfileManager(
      config?.profilesPath,
      config?.encryptPasswords ? "opencode-ssh" : undefined,
    )
    this.profiles.load()
    this.sessions = new SSHSessionManager({
      maxSessions: config?.maxSessions,
      defaultTerminalSize: config?.defaultTerminalSize,
    })

    // Clean up tools when sessions disconnect
    this.sessions.on("session-event", (event) => {
      if (event.type === "disconnected" || event.type === "error") {
        const tools = this.activeTools.get(event.sessionId)
        if (tools) {
          tools.dispose()
          this.activeTools.delete(event.sessionId)
        }
      }
    })
  }

  /** Connect using a saved profile */
  async connectByProfile(profileIdOrName: string, name?: string): Promise<SSHSession> {
    const profile = this.profiles.get(profileIdOrName) ?? this.profiles.getByName(profileIdOrName)
    if (!profile) throw new Error(`Profile "${profileIdOrName}" not found`)

    const chain = ProfileManager.chainFromProfile(profile)
    const session = await this.connectByChain(chain, name ?? profile.name, { openShell: false })
    this.profiles.markUsed(profile.id)
    return session
  }

  /** Connect using an inline host chain */
  async connectByChain(chain: SSHConnectionChain, name?: string, options?: { openShell?: boolean }): Promise<SSHSession> {
    const opts: ConnectionOptions = {
      chain,
      name,
      timeout: this.config.connectionTimeout,
      openShell: options?.openShell ?? false,
    }
    const session = await this.sessions.connect(opts)
    // Resolve the dialect before returning the session so the first command
    // cannot race the asynchronous probe and fall back to POSIX on Windows.
    await this.probeRemoteDialect(session)
    return session
  }

  /** 连接成功后探测远端 shell 方言（best-effort，失败静默回退 posix，不阻塞连接）。 */
  private async probeRemoteDialect(session: SSHSession): Promise<void> {
    try {
      const connection = this.sessions.getConnection(session.id)
      if (!connection || !connection.isConnected()) return
      const host = connection.getFinalHost()
      await detectAndCache(connection.getFinalClient(), host.host, host.port, host.auth.username)
    } catch (err) {
      log("gateway", `dialect probe failed for session ${session.id.slice(0, 8)}: ${(err as Error).message}`)
    }
  }

  /** Connect using a simple inline config (convenience for direct / single-hop) */
  async connectSimple(params: {
    host: string
    port?: number
    username: string
    password?: string
    privateKey?: string
    strictHostKeyChecking?: SSHHostKeyOptions["strictHostKeyChecking"]
    knownHostsPath?: string
    /**
     * Jump hosts to connect through. If not provided, uses defaultGateways from config.
     * Pass `jumpHosts: []` explicitly to skip default gateways and connect directly.
     */
    jumpHosts?: (SSHHostKeyOptions & { host: string; port?: number; username: string; password?: string; privateKey?: string })[]
    openShell?: boolean
    name?: string
  }): Promise<SSHSession> {
    const chain = buildSimpleChain(params, this.config.defaultGateways)
    return this.connectByChain(chain, params.name, { openShell: params.openShell ?? false })
  }

  /** Connect by resolving a hostname through ~/.ssh/config */
  async connectBySSHConfig(
    hostname: string,
    overrides?: { username?: string; password?: string; privateKey?: string },
  ): Promise<SSHSession> {
    const { parseSSHConfig } = await import("./ssh-config.js")
    const sshConfig = parseSSHConfig(this.config.sshConfigPath)
    const chain = sshConfig.resolve(hostname)

    if (chain.length === 0) {
      throw new Error(`No SSH config entry found for "${hostname}"`)
    }

    // Apply overrides to the final (target) host
    if (overrides) {
      const target = chain[chain.length - 1]
      if (overrides.username) target.auth.username = overrides.username
      if (overrides.password) target.auth.password = overrides.password
      if (overrides.privateKey) target.auth.privateKey = overrides.privateKey
    }

    return this.connectByChain(chain, `ssh-config:${hostname}`, { openShell: false })
  }

  /** Get the current default gateways */
  getDefaultGateways(): NonNullable<SSHGatewayPluginConfig["defaultGateways"]> {
    return this.config.defaultGateways ?? []
  }

  /** Set or replace default gateways at runtime */
  setDefaultGateways(gateways: {
    host: string
    port?: number
    username: string
    password?: string
    privateKey?: string
    strictHostKeyChecking?: SSHHostKeyOptions["strictHostKeyChecking"]
    knownHostsPath?: string
  }[]): void {
    this.config.defaultGateways = gateways
  }

  /** Clear default gateways (connections will be direct unless jumpHosts is specified) */
  clearDefaultGateways(): void {
    this.config.defaultGateways = []
  }

  /** Get remote tools for a connected session (SFTP + exec) */
  async getRemoteTools(sessionId: string): Promise<RemoteTools> {
    // Return cached tools if available
    const existing = this.activeTools.get(sessionId)
    if (existing) return existing

    const connection = this.sessions.getConnection(sessionId)
    if (!connection) throw new Error(`Session ${sessionId} not found`)

    const client = connection.getFinalClient()
    const tools = await createRemoteTools(
      { sessionId, client, cwd: `~`, sessionKey: connection.getHostId() },
      this.config.securityPolicy,
    )

    this.activeTools.set(sessionId, tools)
    return tools
  }

  /** Disconnect a session and clean up its tools */
  async disconnect(sessionId: string): Promise<void> {
    const tools = this.activeTools.get(sessionId)
    if (tools) {
      tools.dispose()
      this.activeTools.delete(sessionId)
    }
    await this.sessions.disconnect(sessionId)
  }

  /** Disconnect all sessions */
  async disconnectAll(): Promise<void> {
    for (const [, tools] of this.activeTools) {
      tools.dispose()
    }
    this.activeTools.clear()
    await this.sessions.disconnectAll()
  }

  /** List all active sessions */
  listSessions(): SSHSession[] {
    return this.sessions.listSessions()
  }

  /** Save a connection as a profile */
  saveProfile(name: string, chain: Omit<SSHHostConfig, "id">[], tags?: string[]): SSHProfile {
    return this.profiles.add({ name, chain, tags })
  }
}

/** Build the hop chain for connectSimple. Exported as a pure function so the
 *  gateway-selection rules (jumpHosts over defaultGateways, empty array skips
 *  defaults) can be tested without a live SSH connection. */
export function buildSimpleChain(
  params: {
    host: string
    port?: number
    username: string
    password?: string
    privateKey?: string
    strictHostKeyChecking?: SSHHostKeyOptions["strictHostKeyChecking"]
    knownHostsPath?: string
    jumpHosts?: (SSHHostKeyOptions & { host: string; port?: number; username: string; password?: string; privateKey?: string })[]
    name?: string
  },
  defaultGateways?: (SSHHostKeyOptions & { host: string; port?: number; username: string; password?: string; privateKey?: string })[],
): SSHConnectionChain {
  const chain: SSHConnectionChain = []

  // Determine which gateways to use:
  // - If jumpHosts is explicitly provided (even empty array), use it
  // - If jumpHosts is undefined, use defaultGateways from config
  const gateways = params.jumpHosts !== undefined
    ? params.jumpHosts
    : (defaultGateways ?? [])

  // Add gateways first
  for (let i = 0; i < gateways.length; i++) {
    const gw = gateways[i]
    chain.push({
      id: `gw-${i}`,
      name: gw.host,
      host: gw.host,
      port: gw.port ?? 22,
      strictHostKeyChecking: gw.strictHostKeyChecking,
      knownHostsPath: gw.knownHostsPath,
      auth: {
        username: gw.username,
        password: gw.password,
        privateKey: gw.privateKey,
      },
    })
  }

  // Add target host last
  chain.push({
    id: "target",
    name: params.host,
    host: params.host,
    port: params.port ?? 22,
    strictHostKeyChecking: params.strictHostKeyChecking,
    knownHostsPath: params.knownHostsPath,
    auth: {
      username: params.username,
      password: params.password,
      privateKey: params.privateKey,
    },
  })

  return chain
}
