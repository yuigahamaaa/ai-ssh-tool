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
  /** Virtual cwd hostId: derived from target.host + target.username only, not the full config.
   * This ensures the same host+user gets the same virtual cwd regardless of jumpHosts or port. */
  hostId: string
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

export function createMcpScheduleRequest(input: McpScheduleRequestInput): ScheduleRequest {
  const target = input.profile.chain[input.profile.chain.length - 1]
  // hostId comes from the daemon and is based on target.host + target.username only,
  // not the full configHash. This ensures virtual cwd works consistently
  // regardless of which profile (jumpHosts, port, etc.) is used.
  const hostKey = input.hostId
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
