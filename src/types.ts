/**
 * Core type definitions for SSH Gateway
 * Supports N-hop SSH connections (0 = direct, 1 = one jump, N = multi-hop)
 */

/** SSH connection authentication credentials */
export interface SSHCredentials {
  username: string
  password?: string
  privateKey?: string
  passphrase?: string
  /** Path to SSH agent socket (e.g., '/tmp/ssh-XXXX/agent.NNNN') or 'pageant' on Windows */
  agent?: string
  /** Enable agent forwarding to hop hosts (requires `agent` to be set) */
  agentForward?: boolean
}

/** A single SSH host in the connection chain */
export interface SSHHostConfig {
  id: string
  name: string
  host: string
  port: number
  auth: SSHCredentials
}

/**
 * Connection chain - an ordered list of hosts to connect through.
 * The last host in the chain is the final target.
 *
 * Examples:
 * - [target]                       → direct connection (0-hop)
 * - [gateway, target]              → one jump (1-hop)
 * - [gw1, gw2, target]            → two jumps (2-hop)
 * - [gw1, gw2, ..., gwN, target]  → N hops
 */
export type SSHConnectionChain = SSHHostConfig[]

/** Session status */
export type SessionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error"
  | "closed"

/** A single SSH session */
export interface SSHSession {
  id: string
  name: string
  status: SessionStatus
  /** Host chain summary: "host1 -> host2 -> host3" */
  chainSummary: string
  /** Number of hops (chain length - 1) */
  hops: number
  createdAt: number
  lastActivity: number
  error?: string
}

/** Connection event types */
export type ConnectionEvent =
  | { type: "connecting"; sessionId: string; hopIndex: number; host: string }
  | { type: "connected"; sessionId: string }
  | { type: "disconnected"; sessionId: string }
  | { type: "error"; sessionId: string; error: string }
  | { type: "data"; sessionId: string; data: Buffer }
  | { type: "resize"; sessionId: string; cols: number; rows: number }

/** Event listener type */
export type ConnectionEventListener = (event: ConnectionEvent) => void

/** Terminal dimensions */
export interface TerminalSize {
  cols: number
  rows: number
}

/** SSH connection options */
export interface ConnectionOptions {
  /** Ordered chain of hosts to connect through (last = target) */
  chain: SSHConnectionChain
  /** Session display name */
  name?: string
  /** Terminal size */
  terminalSize?: TerminalSize
  /** Connection timeout in ms (per hop) */
  timeout?: number
}

/** Stored SSH profile (saved connection config) */
export interface SSHProfile {
  id: string
  name: string
  /** Ordered host chain */
  chain: Omit<SSHHostConfig, "id">[]
  tags?: string[]
  lastUsed?: number
}

/** Security policy for remote tool operations */
export interface SecurityPolicy {
  /** If true, all write operations are disabled (writeFile, mkdir, unlink, rmdir, rename, chmod) */
  readOnly?: boolean
  /** Allowed commands for exec (if set, only these commands can be executed) */
  commandWhitelist?: string[]
  /** Blocked commands for exec (these commands will be rejected) */
  commandBlacklist?: string[]
  /** Maximum command length */
  maxCommandLength?: number
  /** Blocked paths for write operations (glob patterns) */
  blockedPaths?: string[]
}

/** Plugin configuration */
export interface SSHGatewayPluginConfig {
  /** Path to SSH profiles file */
  profilesPath?: string
  /** Default terminal size */
  defaultTerminalSize?: TerminalSize
  /** Connection timeout in ms */
  connectionTimeout?: number
  /** Max concurrent sessions */
  maxSessions?: number
  /** Whether to encrypt stored passwords */
  encryptPasswords?: boolean
  /**
   * Default gateway chain - automatically prepended to all connections.
   * Once configured, you only need to specify the target host.
   *
   * Example:
   *   defaultGateways: [
   *     { host: "gw.corp.com", port: 22, username: "root", password: "xxx" },
   *     { host: "bastion.local", port: 22, username: "ops", password: "yyy" }
   *   ]
   *
   * Then `connectSimple({ host: "10.0.0.50", username: "deploy" })` will automatically
   * connect through gw.corp.com -> bastion.local -> 10.0.0.50
   */
  defaultGateways?: {
    host: string
    port?: number
    username: string
    password?: string
    privateKey?: string
  }[]
  /** Security policy applied to all remote tool operations */
  securityPolicy?: SecurityPolicy
  /** Path to SSH config file (default: ~/.ssh/config) */
  sshConfigPath?: string
  /** Whether to automatically parse SSH config for connection resolution */
  useSSHConfig?: boolean
}
