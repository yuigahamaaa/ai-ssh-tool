/**
 * CLI daemon subcommand handlers
 */

import { DaemonClient } from "../daemon-client.js"
import { readFileSync } from "fs"
import { resolve } from "path"
import { log, logError, printErrorAndLogPath } from "../logger.js"
import { ProfileManager } from "../profile-manager.js"
import type { SSHProfile } from "../types.js"
import type { ScheduleRequest, AgentIdentity, HostIdentity, TaskIntent, TaskCost, TaskUrgency } from "../scheduler/types.js"

interface DaemonCommandClient {
  ensureDaemon(opts?: { debug?: boolean; label?: string }): Promise<void>
  connectHost(configPath: string): Promise<any>
  connectHostJson(configJson: string): Promise<any>
  schedule(req: Record<string, unknown>): Promise<any>
  disconnect(): void
}

interface DaemonCommandDeps {
  clientFactory?: () => DaemonCommandClient
}

function createClient(): DaemonClient {
  return new DaemonClient()
}

/**
 * Convert a profile to legacy config JSON string
 */
function profileToLegacyConfigJson(profile: SSHProfile): string {
  const chain = profile.chain
  const target = chain[chain.length - 1]
  const gateways = chain.slice(0, -1)
  
  const legacyConfig = {
    gateways: gateways.map(g => ({
      host: g.host,
      port: g.port,
      username: g.auth.username,
      password: g.auth.password,
      privateKey: g.auth.privateKey
    })),
    target: {
      host: target.host,
      port: target.port,
      username: target.auth.username,
      password: target.auth.password,
      privateKey: target.auth.privateKey
    }
  }
  
  return JSON.stringify(legacyConfig)
}

function hostIdentityFromConfigJson(configJson: string | undefined): { targetHost: string; targetUser: string } {
  if (!configJson) {
    return { targetHost: "unknown", targetUser: "unknown" }
  }
  try {
    const config = JSON.parse(configJson) as { target?: { host?: string; username?: string } }
    return {
      targetHost: config.target?.host ?? "unknown",
      targetUser: config.target?.username ?? "unknown",
    }
  } catch {
    return { targetHost: "unknown", targetUser: "unknown" }
  }
}

export async function handleDaemonStart(args: string[]): Promise<void> {
  const debug = args.includes("--debug")
  const labelIdx = args.indexOf("--label")
  const label = labelIdx >= 0 && labelIdx + 1 < args.length ? args[labelIdx + 1] : undefined
  const client = createClient()
  try {
    await client.ensureDaemon({ debug, label })
    console.log("Daemon started.")
    const resp = await client.ping()
    if (resp.ok) {
      const data = resp.data as any
      console.log(`  Uptime: ${data.uptime}s  Sessions: ${data.sessionCount}`)
    }
  } catch (err: any) {
    console.error(`Failed to start daemon: ${err.message}`)
    process.exitCode = 1
  } finally {
    client.disconnect()
  }
}

export async function handleDaemonStop(): Promise<void> {
  const client = createClient()
  try {
    await client.connect()
    const resp = await client.shutdown()
    if (resp.ok) {
      console.log("Daemon stopped.")
    } else {
      console.error(`Failed to stop daemon: ${(resp as any).error}`)
      process.exitCode = 1
    }
  } catch (err: any) {
    if (err.code === "ECONNREFUSED") {
      console.log("Daemon is not running.")
    } else {
      console.error(`Error: ${err.message}`)
      process.exitCode = 1
    }
  } finally {
    client.disconnect()
  }
}

export async function handleDaemonExec(args: string[], deps: DaemonCommandDeps = {}): Promise<void> {
  let configPath: string | undefined
  let configJson: string | undefined
  let profileName: string | undefined
  let profileJson: string | undefined
  let command: string | undefined
  let scheduler: "auto" | "bypass" = "auto"
  let reason: string | undefined
  let intent: TaskIntent | undefined
  let cost: TaskCost | undefined
  let urgency: TaskUrgency | undefined
  let ifBusy: "run_anyway" | "wait" | "queue" | "fail" | undefined
  let force = false
  let cwd: string | undefined
  let timeout: number | undefined

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config" && i + 1 < args.length) {
      configPath = args[++i]
    } else if (args[i] === "--config-json" && i + 1 < args.length) {
      configJson = args[++i]
    } else if (args[i] === "--profile-name" && i + 1 < args.length) {
      profileName = args[++i]
    } else if (args[i] === "--profile-json" && i + 1 < args.length) {
      profileJson = args[++i]
    } else if (args[i] === "--command" && i + 1 < args.length) {
      command = args[++i]
    } else if (args[i] === "--scheduler" && i + 1 < args.length) {
      scheduler = args[++i] as "auto" | "bypass"
    } else if (args[i] === "--reason" && i + 1 < args.length) {
      reason = args[++i]
    } else if (args[i] === "--intent" && i + 1 < args.length) {
      intent = args[++i] as TaskIntent
    } else if (args[i] === "--cost" && i + 1 < args.length) {
      cost = args[++i] as TaskCost
    } else if (args[i] === "--urgency" && i + 1 < args.length) {
      urgency = args[++i] as TaskUrgency
    } else if (args[i] === "--if-busy" && i + 1 < args.length) {
      ifBusy = args[++i] as "run_anyway" | "wait" | "queue" | "fail"
    } else if (args[i] === "--force") {
      force = true
    } else if (args[i] === "--cwd" && i + 1 < args.length) {
      cwd = args[++i]
    } else if (args[i] === "--timeout" && i + 1 < args.length) {
      timeout = parseInt(args[++i])
    }
  }

  if (!configPath && !configJson && !profileName && !profileJson) {
    console.error("Error: --config, --config-json, --profile-name, or --profile-json is required")
    process.exitCode = 1
    return
  }
  if (!command) {
    console.error("Error: --command is required")
    process.exitCode = 1
    return
  }

  const debug = args.includes("--debug")
  const client = deps.clientFactory?.() ?? createClient()
  try {
    log("daemon-cli", `daemon exec: config=${configPath ?? profileName ?? "inline-json"}, command=${command}`)
    await client.ensureDaemon({ debug })

    let connectResp
    let finalConfigJson: string | undefined
    let sourceType: string | undefined
    
    if (configJson) {
      log("daemon-cli", "Connecting to host via inline JSON")
      connectResp = await client.connectHostJson(configJson)
      finalConfigJson = configJson
      sourceType = "config-json"
    } else if (profileJson) {
      log("daemon-cli", "Connecting to host via profile JSON")
      const profile = JSON.parse(profileJson) as SSHProfile
      finalConfigJson = profileToLegacyConfigJson(profile)
      connectResp = await client.connectHostJson(finalConfigJson)
      sourceType = "profile-json"
    } else if (profileName) {
      log("daemon-cli", `Connecting to host via profile: ${profileName}`)
      const pm = new ProfileManager()
      pm.load()
      const profile = pm.getByName(profileName)
      if (!profile) {
        throw new Error(`Profile not found: ${profileName}`)
      }
      pm.markUsed(profile.id)
      finalConfigJson = profileToLegacyConfigJson(profile)
      connectResp = await client.connectHostJson(finalConfigJson)
      sourceType = "profile-name"
    } else {
      const absConfig = resolve(configPath!)
      log("daemon-cli", `Connecting to host via config: ${absConfig}`)
      connectResp = await client.connectHost(absConfig)
      sourceType = "config-file"
    }

    if (!connectResp.ok) {
      log("daemon-cli", `Connection failed: ${(connectResp as any).error}`)
      console.error(`Connection failed: ${(connectResp as any).error}`)
      process.exitCode = 1
      return
    }

    const { sessionId, reused, configHash } = connectResp.data as any
    log("daemon-cli", `Session: ${sessionId.slice(0, 8)}, reused=${reused}`)
    if (reused) {
      console.error(`[ssh-exec] reusing session ${sessionId.slice(0, 8)}`)
    } else {
      console.error(`[ssh-exec] connected, session ${sessionId.slice(0, 8)}`)
    }

    const hostIdentity: HostIdentity = {
      id: configHash ?? sessionId.slice(0, 16),
      profileKey: configHash ?? sessionId.slice(0, 16),
      ...hostIdentityFromConfigJson(finalConfigJson),
      displayName: profileName ?? configPath ?? "inline",
    }
    const agentIdentity: AgentIdentity = {
      id: `cli-${process.pid}-${Date.now()}`,
      clientType: "cli",
    }

    const scheduleReq: ScheduleRequest = {
      agent: agentIdentity,
      host: hostIdentity,
      sessionId,
      command: command!,
      cwd,
      reason,
      intent,
      cost,
      urgency,
      ifBusy,
      scheduler,
      timeoutMs: timeout,
      force,
    }

    log("daemon-cli", `Scheduling: ${command} (scheduler=${scheduler})`)
    const schedResp = await client.schedule(scheduleReq as unknown as Record<string, unknown>)
    if (!schedResp.ok) {
      log("daemon-cli", `Schedule failed: ${(schedResp as any).error}`)
      printErrorAndLogPath((schedResp as any).error)
      process.exitCode = 1
      return
    }

    const decision = schedResp.data as any
    log("daemon-cli", `Decision: ${decision.action}`)

    if (decision.action === "run_now" && decision.result) {
      if (decision.result.stdout) process.stdout.write(decision.result.stdout)
      if (decision.result.stderr) process.stderr.write(decision.result.stderr)
      if (decision.result.truncated) {
        console.error(`\n[ssh-exec] output truncated; full output files:`)
        console.error(`[ssh-exec] stdout: ${decision.result.stdoutPath}`)
        console.error(`[ssh-exec] stderr: ${decision.result.stderrPath}`)
      }
      process.exitCode = decision.result.code ?? 0
    } else {
      console.log(JSON.stringify(decision, null, 2))
      process.exitCode = 0
    }
  } catch (err: any) {
    logError("daemon-cli", "daemon exec failed", err)
    printErrorAndLogPath(err.message)
    process.exitCode = 1
  } finally {
    client.disconnect()
  }
}

export async function handleDaemonSessions(): Promise<void> {
  const client = createClient()
  try {
    await client.ensureDaemon()
    const resp = await client.list()
    if (!resp.ok) {
      console.error(`Error: ${(resp as any).error}`)
      process.exitCode = 1
      return
    }

    const sessions = resp.data as any[]
    if (sessions.length === 0) {
      console.log("No active sessions.")
      return
    }

    console.log(`Active sessions (${sessions.length}):`)
    const statusIcons: Record<string, string> = {
      disconnected: "[x]",
      connecting: "[~]",
      connected: "[*]",
      error: "[!]",
      closed: "[-]",
    }
    for (const s of sessions) {
      const statusIcon = statusIcons[s.status] ?? "[?]"

      const idleSec = Math.floor((Date.now() - s.lastActivity) / 1000)
      console.log(
        `  ${statusIcon} ${s.id.slice(0, 8)}  ${s.name}  (${s.hops} hops)  idle: ${idleSec}s`,
      )
    }
  } catch (err: any) {
    console.error(`Error: ${err.message}`)
    process.exitCode = 1
  } finally {
    client.disconnect()
  }
}

export async function handleDaemonDisconnect(args: string[]): Promise<void> {
  const sessionId = args[0]
  if (!sessionId) {
    console.error("Usage: ssh-exec daemon disconnect <sessionId>")
    process.exitCode = 1
    return
  }

  const client = createClient()
  try {
    await client.connect()
    const resp = await client.disconnectSession(sessionId)
    if (resp.ok) {
      console.log(`Disconnected session ${sessionId}`)
    } else {
      console.error(`Error: ${(resp as any).error}`)
      process.exitCode = 1
    }
  } catch (err: any) {
    console.error(`Error: ${err.message}`)
    process.exitCode = 1
  } finally {
    client.disconnect()
  }
}

export async function handleDaemonPing(): Promise<void> {
  const client = createClient()
  try {
    await client.connect()
    const resp = await client.ping()
    if (resp.ok) {
      const data = resp.data as any
      console.log(`Daemon is running.`)
      console.log(`  Uptime: ${data.uptime}s`)
      console.log(`  Sessions: ${data.sessionCount}`)
    } else {
      console.error(`Daemon error: ${(resp as any).error}`)
      process.exitCode = 1
    }
  } catch (err: any) {
    if (err.code === "ECONNREFUSED") {
      console.log("Daemon is not running.")
    } else {
      console.error(`Error: ${err.message}`)
      process.exitCode = 1
    }
  } finally {
    client.disconnect()
  }
}
