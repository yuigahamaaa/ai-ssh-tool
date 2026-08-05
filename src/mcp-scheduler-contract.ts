import { createHash } from "crypto"
import type { SSHProfile } from "./types.js"
import type {
  AgentIdentity,
  ScheduleRequest,
  TaskCost,
  TaskIntent,
  TaskUrgency,
} from "./scheduler/types.js"

export interface McpScheduleRequestInput {
  profile: SSHProfile
  sessionId: string
  configHash?: string
  agentId: string
  command: string
  cwd?: string
  scheduler?: "auto" | "bypass"
  reason?: string
  intent?: TaskIntent
  cost?: TaskCost
  urgency?: TaskUrgency
  if_busy?: "run_anyway" | "wait" | "queue" | "fail"
  force?: boolean
  timeout?: number
  background?: boolean
}

export function profileToLegacyConfigJson(profile: SSHProfile): string {
  const chain = profile.chain
  const target = chain[chain.length - 1]
  const gateways = chain.slice(0, -1)

  return JSON.stringify({
    gateways: gateways.map(g => ({
      host: g.host,
      port: g.port,
      username: g.auth.username,
      password: g.auth.password,
      privateKey: g.auth.privateKey,
    })),
    target: {
      host: target.host,
      port: target.port,
      username: target.auth.username,
      password: target.auth.password,
      privateKey: target.auth.privateKey,
    },
  })
}

export interface TargetIdentity {
  host: string
  port?: number
  username: string
}

/**
 * Hash of the remote target identity (host/port/user) only — deliberately
 * excluding credentials. Virtual cwd is keyed by this so rotating a password
 * or private key for the same target does not lose the stored cwd.
 */
export function targetIdentityHash(target: TargetIdentity): string {
  return createHash("md5").update(JSON.stringify({
    host: target.host,
    port: target.port ?? 22,
    username: target.username,
  })).digest("hex")
}

export function createMcpScheduleRequest(input: McpScheduleRequestInput): ScheduleRequest {
  const target = input.profile.chain[input.profile.chain.length - 1]
  const hostKey = input.configHash ?? input.sessionId.slice(0, 16)
  const agent: AgentIdentity = {
    id: input.agentId,
    name: "mcp-server",
    clientType: "mcp",
  }

  return {
    agent,
    host: {
      id: hostKey,
      profileKey: hostKey,
      targetHost: target.host,
      targetUser: target.auth.username,
      displayName: input.profile.name,
    },
    sessionId: input.sessionId,
    command: input.command,
    cwd: input.cwd,
    reason: input.reason,
    intent: input.intent,
    cost: input.cost,
    urgency: input.urgency,
    ifBusy: input.if_busy,
    scheduler: input.scheduler ?? "auto",
    timeoutMs: input.timeout,
    force: input.force,
    background: input.background,
  }
}
