#!/usr/bin/env node

/**
 * ssh-exec - 通过 SSH 网关执行远程命令
 *
 * 用法:
 *   node ssh-exec.ts --config <json-file> --command <命令>
 *   node ssh-exec.ts --config <json-file> --shell  (交互式 shell)
 *
 * 配置文件格式 (JSON):
 * {
 *   "gateways": [
 *     { "host": "跳板机1", "port": 22, "username": "user1", "password": "pass1" },
 *     { "host": "跳板机2", "port": 22, "username": "user2", "password": "pass2" }
 *   ],
 *   "target": { "host": "目标机", "port": 22, "username": "root", "password": "xxx" }
 * }
 */

import { readFileSync } from "fs"
import { resolve } from "path"
import { checkDeps } from "../check-deps.js"
import { SSHGateway } from "../gateway.js"
import { remoteExec } from "../remote-shell.js"
import {
  handleDaemonStart,
  handleDaemonStop,
  handleDaemonExec,
  handleDaemonSessions,
  handleDaemonDisconnect,
  handleDaemonPing,
} from "./daemon-commands.js"
import { DaemonClient } from "../daemon-client.js"
import { createRequest } from "../ipc-protocol.js"
import { upload, download } from "../file-transfer.js"
import { BackgroundExecManager } from "../background-exec.js"
import { enableDebug, log, logError, printErrorAndLogPath } from "../logger.js"
import type { ScheduleRequest, AgentIdentity, HostIdentity, TaskIntent, TaskCost, TaskUrgency } from "../scheduler/types.js"
import { ProfileManager } from "../profile-manager.js"
import type { SSHProfile } from "../types.js"

interface HostConfig {
  host: string
  port?: number
  username: string
  password?: string
  privateKey?: string
}

interface SshExecConfig {
  gateways?: HostConfig[]
  target: HostConfig
  timeout?: number
}

function parseArgs(): {
  configPath?: string;
  configJson?: string;
  profileName?: string;
  profileJson?: string;
  command?: string;
  shell: boolean;
  debug: boolean;
  scheduler: "auto" | "bypass";
  reason?: string;
  intent?: TaskIntent;
  cost?: TaskCost;
  urgency?: TaskUrgency;
  ifBusy?: "run_anyway" | "wait" | "queue" | "fail";
  force: boolean;
  cwd?: string;
  timeout?: number;
} {
  const args = process.argv.slice(2)
  let configPath: string | undefined
  let configJson: string | undefined
  let profileName: string | undefined
  let profileJson: string | undefined
  let command: string | undefined
  let shell = false
  let debug = false
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
    } else if (args[i] === "--shell") {
      shell = true
    } else if (args[i] === "--debug") {
      debug = true
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
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`用法:
  ssh-exec [--debug] --config <json文件> --command <命令>       执行命令（单次连接）
  ssh-exec [--debug] --config-json '<json串>' --command <命令>  同上，但直接传 JSON
  ssh-exec [--debug] --profile-name <profile名称> --command <命令>  使用保存的 profile 执行命令
  ssh-exec [--debug] --profile-json '<json串>' --command <命令> 使用内联 profile JSON 执行命令
  ssh-exec [--debug] --config <json文件> --shell                交互式 shell
  ssh-exec [--debug] --profile-name <profile名称> --shell       使用保存的 profile 启动交互式 shell
  ssh-exec daemon start                                         启动持久化 daemon
  ssh-exec daemon stop                                          停止 daemon
  ssh-exec daemon exec --config <json文件> --command <命令>      通过 daemon 执行（复用连接）
  ssh-exec daemon exec --config-json '<json串>' --command <命令> 同上，但直接传 JSON
  ssh-exec daemon exec --profile-name <profile名称> --command <命令> 使用保存的 profile 通过 daemon 执行
  ssh-exec daemon exec --profile-json '<json串>' --command <命令> 使用内联 profile JSON 通过 daemon 执行
  ssh-exec daemon sessions                                      查看活跃会话
  ssh-exec daemon disconnect <sessionId>                        断开指定会话
  ssh-exec daemon ping                                          检查 daemon 状态

配置方式 (任选其一):
  --config <文件>           SSH 配置文件路径（旧格式）
  --config-json <JSON>      直接传入 SSH 配置 JSON 字符串（旧格式）
  --profile-name <名称>    使用保存的 profile（推荐，通过 MCP 或其他方式添加）
  --profile-json <JSON>     直接传入完整的 SSHProfile JSON 字符串

--debug                   开启调试日志

持久化模式（daemon）:
  首次 exec 自动启动 daemon，后续命令复用已有 SSH 连接，无需重复握手。
  空闲 10 分钟后自动断开连接。

旧格式配置:
{
  "gateways": [
    { "host": "跳板机", "port": 22, "username": "user", "password": "pass" }
  ],
  "target": { "host": "目标机", "port": 22, "username": "root", "password": "xxx" }
}

Profile 格式:
{
  "name": "my-server",
  "chain": [
    { "name": "jump", "host": "jump.example.com", "port": 22, "auth": { "username": "user", "password": "pass" } },
    { "name": "target", "host": "target.example.com", "port": 22, "auth": { "username": "root", "password": "pass" } }
  ],
  "tags": ["production"]
}`)
      process.exit(0)
    }
  }

  return { configPath, configJson, profileName, profileJson, command, shell, debug, scheduler, reason, intent, cost, urgency, ifBusy, force, cwd, timeout }
}

/**
 * Convert a profile (or legacy config) to SshExecConfig
 */
function profileToLegacyConfig(profile: SSHProfile): SshExecConfig {
  const chain = profile.chain
  const target = chain[chain.length - 1]
  const gateways = chain.slice(0, -1)
  
  return {
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
}

/**
 * Load config from profile name
 */
function loadConfigFromProfileName(name: string): SshExecConfig {
  const pm = new ProfileManager()
  pm.load()
  const profile = pm.getByName(name)
  if (!profile) {
    throw new Error(`Profile not found: ${name}`)
  }
  pm.markUsed(profile.id)
  return profileToLegacyConfig(profile)
}

/**
 * Load config from profile JSON string
 */
function loadConfigFromProfileJson(jsonStr: string): SshExecConfig {
  const profile = JSON.parse(jsonStr) as SSHProfile
  return profileToLegacyConfig(profile)
}

function loadConfigFromJson(jsonStr: string): SshExecConfig {
  const config = JSON.parse(jsonStr) as SshExecConfig

  if (!config.target?.host || !config.target?.username) {
    throw new Error("配置必须包含 target.host 和 target.username")
  }

  return config
}

function loadConfig(path: string): SshExecConfig {
  const raw = readFileSync(path, "utf-8")
  const config = JSON.parse(raw) as SshExecConfig

  if (!config.target?.host || !config.target?.username) {
    throw new Error("配置文件必须包含 target.host 和 target.username")
  }

  return config
}

async function execCommand(config: SshExecConfig, command: string): Promise<void> {
  log("exec", `Starting exec: ${command}`)
  log("exec", `Target: ${config.target.host}:${config.target.port ?? 22} as ${config.target.username}`)
  log("exec", `Gateways: ${(config.gateways ?? []).length}`)

  const gw = new SSHGateway({
    connectionTimeout: config.timeout ?? 15000,
    maxSessions: 1,
  })

  try {
    const jumpHosts = (config.gateways ?? []).map((g) => ({
      host: g.host,
      port: g.port ?? 22,
      username: g.username,
      password: g.password,
      privateKey: g.privateKey,
    }))

    log("exec", "Connecting...")
    const session = await gw.connectSimple({
      host: config.target.host,
      port: config.target.port ?? 22,
      username: config.target.username,
      password: config.target.password,
      privateKey: config.target.privateKey,
      jumpHosts,
      name: `exec-${Date.now()}`,
    })
    log("exec", `Connected, session: ${session.id}`)

    const connection = gw.sessions.getConnection(session.id)
    if (!connection) throw new Error("连接失败")

    const client = connection.getFinalClient()
    log("exec", `Executing: ${command}`)
    const result = await remoteExec(client, command, {
      timeout: config.timeout ?? 30000,
    })
    log("exec", `Exit code: ${result.code}, stdout: ${result.stdout.length} bytes, stderr: ${result.stderr.length} bytes`)

    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)

    process.exitCode = result.code
  } catch (err: any) {
    logError("exec", "exec failed", err)
    printErrorAndLogPath(err.message)
    process.exitCode = 1
  } finally {
    log("exec", "Disconnecting...")
    await gw.disconnectAll()
  }
}

async function interactiveShell(config: SshExecConfig): Promise<void> {
  const gw = new SSHGateway({
    connectionTimeout: config.timeout ?? 15000,
    maxSessions: 1,
  })

  try {
    const jumpHosts = (config.gateways ?? []).map((g) => ({
      host: g.host,
      port: g.port ?? 22,
      username: g.username,
      password: g.password,
      privateKey: g.privateKey,
    }))

    const session = await gw.connectSimple({
      host: config.target.host,
      port: config.target.port ?? 22,
      username: config.target.username,
      password: config.target.password,
      privateKey: config.target.privateKey,
      jumpHosts,
      name: `shell-${Date.now()}`,
    })

    const connection = gw.sessions.getConnection(session.id)
    if (!connection) throw new Error("连接失败")

    // 监听远程输出（保存引用以便清理）
    const onData = (event: any) => {
      if (event.type === "data") {
        process.stdout.write(event.data)
      }
    }
    connection.on("event", onData)

    // 本地 stdin → 远程 shell
    const onStdin = async (data: Buffer) => {
      try {
        await connection.sendData(data)
      } catch {
        // 连接已断开
      }
    }
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on("data", onStdin)

    // 等待断开
    await new Promise<void>((resolve) => {
      const onDisconnect = (event: any) => {
        if (event.type === "disconnected" || event.type === "error") {
          resolve()
        }
      }
      connection.on("event", onDisconnect)
      // 清理 disconnect 监听器（onData 在 finally 中统一清理）
      connection.once("event", (event: any) => {
        if (event.type === "disconnected" || event.type === "error") {
          connection.off("event", onDisconnect)
        }
      })
    })
  } finally {
    process.stdin.setRawMode(false)
    process.stdin.pause()
    process.stdin.removeAllListeners("data")
    await gw.disconnectAll()
  }
}

async function execScheduledCommand(
  config: SshExecConfig,
  command: string,
  opts: {
    scheduler: "auto" | "bypass"
    reason?: string
    intent?: TaskIntent
    cost?: TaskCost
    urgency?: TaskUrgency
    ifBusy?: "run_anyway" | "wait" | "queue" | "fail"
    force: boolean
    cwd?: string
    timeout?: number
    profileName?: string
  }
): Promise<void> {
  const client = createClient()
  try {
    await client.ensureDaemon({ debug: false })

    const configJson = JSON.stringify(config)
    const connectResp = await client.connectHostJson(configJson)
    if (!connectResp.ok) {
      console.error(`Connection failed: ${(connectResp as any).error}`)
      process.exitCode = 1
      return
    }

    const { sessionId } = connectResp.data as any
    const agentIdentity: AgentIdentity = {
      id: `cli-${process.pid}-${Date.now()}`,
      clientType: "cli",
    }
    const hostIdentity: HostIdentity = {
      id: sessionId.slice(0, 16),
      profileKey: sessionId.slice(0, 16),
      targetHost: config.target.host,
      targetUser: config.target.username,
      displayName: opts.profileName ?? config.target.host,
    }

    const scheduleReq: ScheduleRequest = {
      agent: agentIdentity,
      host: hostIdentity,
      sessionId,
      command,
      cwd: opts.cwd,
      reason: opts.reason,
      intent: opts.intent,
      cost: opts.cost,
      urgency: opts.urgency,
      ifBusy: opts.ifBusy,
      scheduler: opts.scheduler,
      timeoutMs: opts.timeout,
      force: opts.force,
    }

    const schedResp = await client.schedule(scheduleReq as unknown as Record<string, unknown>)
    if (!schedResp.ok) {
      console.error(`Schedule failed: ${(schedResp as any).error}`)
      process.exitCode = 1
      return
    }

    const decision = schedResp.data as any
    if (decision.action === "run_now" && decision.result) {
      if (decision.result.stdout) process.stdout.write(decision.result.stdout)
      if (decision.result.stderr) process.stderr.write(decision.result.stderr)
      process.exitCode = decision.result.code ?? 0
    } else {
      console.log(JSON.stringify(decision, null, 2))
      process.exitCode = 0
    }
  } catch (err: any) {
    logError("exec-scheduled", "scheduled exec failed", err)
    printErrorAndLogPath(err.message)
    process.exitCode = 1
  } finally {
    client.disconnect()
  }
}

function createClient(): DaemonClient {
  return new DaemonClient()
}

export async function handleDaemonTransfer(args: string[]): Promise<void> {
  let configPath: string | undefined
  let configJson: string | undefined
  let profileName: string | undefined
  let profileJson: string | undefined
  let action: string | undefined
  let localPath: string | undefined
  let remotePath: string | undefined

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config" && i + 1 < args.length) {
      configPath = args[++i]
    } else if (args[i] === "--config-json" && i + 1 < args.length) {
      configJson = args[++i]
    } else if (args[i] === "--profile-name" && i + 1 < args.length) {
      profileName = args[++i]
    } else if (args[i] === "--profile-json" && i + 1 < args.length) {
      profileJson = args[++i]
    } else if (args[i] === "--action" && i + 1 < args.length) {
      action = args[++i]
    } else if (args[i] === "--local" && i + 1 < args.length) {
      localPath = args[++i]
    } else if (args[i] === "--remote" && i + 1 < args.length) {
      remotePath = args[++i]
    }
  }

  if (!configPath && !configJson && !profileName && !profileJson) {
    console.error("Error: --config, --config-json, --profile-name, or --profile-json is required")
    process.exitCode = 1
    return
  }
  if (!action || !localPath || !remotePath) {
    console.error("Error: --action (upload/download), --local, and --remote are required")
    process.exitCode = 1
    return
  }
  if (action !== "upload" && action !== "download") {
    console.error(`Error: --action must be 'upload' or 'download' (got: ${action}). Path is auto-detected as file or folder.`)
    process.exitCode = 1
    return
  }

  const debug = args.includes("--debug")
  const client = createClient()
  try {
    await client.ensureDaemon({ debug })

    let connectResp
    if (configJson) {
      connectResp = await client.connectHostJson(configJson)
    } else if (profileJson) {
      // 将 profile 转换为旧格式的 config json
      const config = loadConfigFromProfileJson(profileJson)
      connectResp = await client.connectHostJson(JSON.stringify(config))
    } else if (profileName) {
      const config = loadConfigFromProfileName(profileName)
      connectResp = await client.connectHostJson(JSON.stringify(config))
    } else {
      connectResp = await client.connectHost(resolve(configPath!))
    }

    if (!connectResp.ok) {
      console.error(`Connection failed: ${(connectResp as any).error}`)
      process.exitCode = 1
      return
    }

    const { sessionId } = connectResp.data as any
    const execResp = await client.exec(sessionId, "echo ok", 5000)
    if (!execResp.ok) {
      console.error(`Session validation failed: ${(execResp as any).error}`)
      process.exitCode = 1
      return
    }

    console.error(`[ssh-exec] Connected, starting ${action}...`)

    const result = await client.send(
      createRequest("transfer", { sessionId, action, localPath, remotePath }),
      300000,
    )

    if (result.ok) {
      const data = result.data as any
      console.log(JSON.stringify(data, null, 2))
    } else {
      console.error(`Transfer failed: ${(result as any).error}`)
      process.exitCode = 1
    }
  } catch (err: any) {
    console.error(`Error: ${err.message}`)
    process.exitCode = 1
  } finally {
    client.disconnect()
  }
}

export async function handleDaemonBgExec(args: string[]): Promise<void> {
  let configPath: string | undefined
  let configJson: string | undefined
  let profileName: string | undefined
  let profileJson: string | undefined
  let command: string | undefined
  let subcommand = "start"

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
    } else if (args[i] === "--task-id" && i + 1 < args.length) {
      command = args[++i]
    } else if (args[i] === "--sub" && i + 1 < args.length) {
      subcommand = args[++i]
    }
  }

  if (!configPath && !configJson && !profileName && !profileJson) {
    console.error("Error: --config, --config-json, --profile-name, or --profile-json is required")
    process.exitCode = 1
    return
  }

  const debug = args.includes("--debug")
  const client = createClient()
  try {
    await client.ensureDaemon({ debug })

    let connectResp
    if (configJson) {
      connectResp = await client.connectHostJson(configJson)
    } else if (profileJson) {
      const config = loadConfigFromProfileJson(profileJson)
      connectResp = await client.connectHostJson(JSON.stringify(config))
    } else if (profileName) {
      const config = loadConfigFromProfileName(profileName)
      connectResp = await client.connectHostJson(JSON.stringify(config))
    } else {
      connectResp = await client.connectHost(resolve(configPath!))
    }

    if (!connectResp.ok) {
      console.error(`Connection failed: ${(connectResp as any).error}`)
      process.exitCode = 1
      return
    }

    const { sessionId } = connectResp.data as any

    const result = await client.send(
      createRequest("bgExec", { sessionId, subcommand, command, taskId: command }),
      60000,
    )

    if (result.ok) {
      console.log(JSON.stringify(result.data, null, 2))
    } else {
      console.error(`Error: ${(result as any).error}`)
      process.exitCode = 1
    }
  } catch (err: any) {
    console.error(`Error: ${err.message}`)
    process.exitCode = 1
  } finally {
    client.disconnect()
  }
}

export async function handleDaemonPortForward(args: string[]): Promise<void> {
  let configPath: string | undefined
  let configJson: string | undefined
  let profileName: string | undefined
  let profileJson: string | undefined
  let subcommand = "list"
  let type = "local"
  let bindAddr = "127.0.0.1"
  let bindPort: number | undefined
  let dstAddr: string | undefined
  let dstPort: number | undefined
  let forwardId: string | undefined

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config" && i + 1 < args.length) {
      configPath = args[++i]
    } else if (args[i] === "--config-json" && i + 1 < args.length) {
      configJson = args[++i]
    } else if (args[i] === "--profile-name" && i + 1 < args.length) {
      profileName = args[++i]
    } else if (args[i] === "--profile-json" && i + 1 < args.length) {
      profileJson = args[++i]
    } else if (args[i] === "--sub" && i + 1 < args.length) {
      subcommand = args[++i]
    } else if (args[i] === "--type" && i + 1 < args.length) {
      type = args[++i]
    } else if (args[i] === "--bind-addr" && i + 1 < args.length) {
      bindAddr = args[++i]
    } else if (args[i] === "--bind-port" && i + 1 < args.length) {
      bindPort = parseInt(args[++i])
    } else if (args[i] === "--dst-addr" && i + 1 < args.length) {
      dstAddr = args[++i]
    } else if (args[i] === "--dst-port" && i + 1 < args.length) {
      dstPort = parseInt(args[++i])
    } else if (args[i] === "--forward-id" && i + 1 < args.length) {
      forwardId = args[++i]
    }
  }

  if (!configPath && !configJson && !profileName && !profileJson) {
    console.error("Error: --config, --config-json, --profile-name, or --profile-json is required")
    process.exitCode = 1
    return
  }

  const debug = args.includes("--debug")
  const client = createClient()
  try {
    await client.ensureDaemon({ debug })

    let connectResp
    if (configJson) {
      connectResp = await client.connectHostJson(configJson)
    } else if (profileJson) {
      const config = loadConfigFromProfileJson(profileJson)
      connectResp = await client.connectHostJson(JSON.stringify(config))
    } else if (profileName) {
      const config = loadConfigFromProfileName(profileName)
      connectResp = await client.connectHostJson(JSON.stringify(config))
    } else {
      connectResp = await client.connectHost(resolve(configPath!))
    }

    if (!connectResp.ok) {
      console.error(`Connection failed: ${(connectResp as any).error}`)
      process.exitCode = 1
      return
    }

    const { sessionId } = connectResp.data as any
    const result = await client.send(
      createRequest("portForward", { sessionId, subcommand, type, bindAddr, bindPort, dstAddr, dstPort, forwardId }),
      30000,
    )

    if (result.ok) {
      console.log(JSON.stringify(result.data, null, 2))
    } else {
      console.error(`Error: ${(result as any).error}`)
      process.exitCode = 1
    }
  } catch (err: any) {
    console.error(`Error: ${err.message}`)
    process.exitCode = 1
  } finally {
    client.disconnect()
  }
}

async function main() {
  checkDeps()
  const args = process.argv.slice(2)
  const hasDebug = args.includes("--debug")

  // Parse config early if debug mode, to extract host for log filename
  if (hasDebug) {
    let host: string | undefined
    let cmd: string | undefined
    let label: string | undefined
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--config" && i + 1 < args.length) {
        try {
          const cfg = JSON.parse(readFileSync(args[i + 1], "utf-8"))
          host = cfg.target?.host
        } catch {}
      }
      if (args[i] === "--config-json" && i + 1 < args.length) {
        try {
          const cfg = JSON.parse(args[i + 1])
          host = cfg.target?.host
        } catch {}
      }
      if (args[i] === "--command" && i + 1 < args.length) {
        cmd = args[i + 1]
      }
      if (args[i] === "--label" && i + 1 < args.length) {
        label = args[++i]
      }
    }
    // For daemon subcommands, use label or "daemon"; for direct mode, use host+command
    if (args[0] === "daemon") {
      enableDebug({ label: label ?? "daemon" })
    } else {
      enableDebug({ host, command: cmd })
    }
    log("main", "Debug mode enabled")
  }

  // Handle daemon subcommands (filter debug flags from args)
  const cmdArgs = args.filter((a, i) => a !== "--debug" && a !== "--label" && args[i - 1] !== "--label")
  if (cmdArgs[0] === "daemon") {
    const sub = cmdArgs[1]
    const remaining = cmdArgs.slice(2)

    switch (sub) {
      case "start": {
        const extra = []
        if (hasDebug) extra.push("--debug")
        const lbl = args.find((a, i) => args[i - 1] === "--label")
        if (lbl) extra.push("--label", lbl)
        await handleDaemonStart([...remaining, ...extra])
        return
      }
      case "stop":
        await handleDaemonStop()
        return
      case "exec":
        await handleDaemonExec(hasDebug ? [...remaining, "--debug"] : remaining)
        return
      case "sessions":
        await handleDaemonSessions()
        return
      case "disconnect":
        await handleDaemonDisconnect(remaining)
        return
      case "ping":
        await handleDaemonPing()
        return
      case "transfer":
        await handleDaemonTransfer(remaining)
        return
      case "bg-exec":
      case "bgexec":
        await handleDaemonBgExec(remaining)
        return
      case "port-forward":
      case "fwd":
        await handleDaemonPortForward(remaining)
        return
      default:
        console.error(`Unknown daemon subcommand: ${sub ?? ""}`)
        console.log("Available: start, stop, exec, sessions, disconnect, ping, transfer, bg-exec, port-forward")
        process.exit(1)
    }
  }

  // Handle mcp subcommand
  if (cmdArgs[0] === "mcp") {
    const { spawn } = await import("child_process")
    const __dirname = new URL(".", import.meta.url).pathname
    const mcpScript = __dirname.replace(/cli\/?$/, "mcp-server.js")
    const mcpArgs = cmdArgs.slice(1)
    if (hasDebug) mcpArgs.push("--debug")
    const child = spawn("node", [mcpScript, ...mcpArgs], {
      stdio: "inherit",
    })
    child.on("exit", (code) => process.exit(code ?? 0))
    return
  }

  // Original behavior: direct connection (no daemon)
  const { configPath, configJson, profileName, profileJson, command, shell, scheduler, reason, intent, cost, urgency, ifBusy, force, cwd, timeout } = parseArgs()

  if (!configPath && !configJson && !profileName && !profileJson) {
    console.error("错误: 必须指定 --config <json 文件路径> 或 --config-json '<json 字符串>' 或 --profile-name <profile 名称> 或 --profile-json '<json 字符串>'")
    process.exit(1)
  }

  let config: SshExecConfig
  if (profileName) {
    log("main", `Config: profile name ${profileName}`)
    config = loadConfigFromProfileName(profileName)
  } else if (profileJson) {
    log("main", "Config: profile inline JSON")
    config = loadConfigFromProfileJson(profileJson)
  } else if (configJson) {
    log("main", "Config: inline JSON")
    config = loadConfigFromJson(configJson)
  } else {
    log("main", `Config: ${configPath}`)
    config = loadConfig(configPath!)
  }
  log("main", `Loaded config: target=${config.target.host}, gateways=${(config.gateways ?? []).length}`)

  if (shell) {
    await interactiveShell(config)
  } else if (command) {
    await execScheduledCommand(config, command, { scheduler, reason, intent, cost, urgency, ifBusy, force, cwd, timeout, profileName })
  } else {
    console.error("错误: 必须指定 --command <命令> 或 --shell")
    process.exit(1)
  }
}

main().catch((err) => {
  logError("main", "fatal error", err)
  printErrorAndLogPath(err.message)
  process.exit(1)
})
