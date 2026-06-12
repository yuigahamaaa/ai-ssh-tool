#!/usr/bin/env node

/**
 * SSH MCP Server - exposes SSH remote tools via Model Context Protocol
 *
 * Usage:
 *   node mcp-server.js --config <json-file>
 *   node mcp-server.js --config-json '<json>'
 *
 * Runs as a stdio-based MCP server for AI agents (Claude, etc.)
 *
 * Features:
 * - Dynamic profile switching: each tool call can specify a profile
 * - Session reuse: maintains connections for performance
 * - All tools support profile parameter
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { readFileSync } from "fs"
import { resolve } from "path"
import { SSHGateway } from "./gateway.js"
import { remoteExec } from "./remote-shell.js"
import { upload, download } from "./file-transfer.js"
import { PortForwardManager } from "./port-forwarding.js"
import { ProfileManager } from "./profile-manager.js"
import { enableDebug, log } from "./logger.js"
import { checkDeps } from "./check-deps.js"
import type { SSHProfile, SSHHostConfig } from "./types.js"
import { DaemonClient } from "./daemon-client.js"
import type { AgentIdentity, HostIdentity, TaskIntent, TaskCost, TaskUrgency, ScheduleDecision } from "./scheduler/types.js"
import { createMcpScheduleRequest, profileToLegacyConfigJson } from "./mcp-scheduler-contract.js"
import {
  guidanceForTaskStatus,
  guidanceForWaitResult,
  jsonText,
  mcpEnvelope,
  mcpErrorEnvelope,
  scheduleDecisionEnvelope,
} from "./mcp-response.js"
import { randomUUID } from "crypto"

interface HostConfig {
  host: string
  port?: number
  username: string
  password?: string
  privateKey?: string
}

interface SshConfig {
  gateways?: HostConfig[]
  target: HostConfig
  timeout?: number
}

function loadConfig(): SshConfig | null {
  const args = process.argv.slice(2)
  let configPath: string | undefined
  let configJson: string | undefined

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config" && i + 1 < args.length) {
      configPath = args[++i]
    } else if (args[i] === "--config-json" && i + 1 < args.length) {
      configJson = args[++i]
    } else if (args[i] === "--debug") {
      enableDebug({ label: "mcp-server" })
    }
  }

  if (configJson) {
    const config = JSON.parse(configJson) as SshConfig
    if (!config.target?.host || !config.target?.username) {
      throw new Error("Config must have target.host and target.username")
    }
    return config
  }

  if (configPath) {
    const raw = readFileSync(resolve(configPath), "utf-8")
    const config = JSON.parse(raw) as SshConfig
    if (!config.target?.host || !config.target?.username) {
      throw new Error("Config file must have target.host and target.username")
    }
    return config
  }

  return null // No default config, require profile parameter
}

// Type for client cache entry
interface ClientCacheEntry {
  client: any
  forwardManager: PortForwardManager
}

const MCP_AGENT_ID = `mcp-${randomUUID().slice(0, 8)}`

async function main() {
  checkDeps()

  const initialConfig = loadConfig()

  const gw = new SSHGateway({
    connectionTimeout: initialConfig?.timeout ?? 15000,
    maxSessions: 10, // Allow more concurrent sessions
  })

  const profileManager = new ProfileManager()
  profileManager.load()

  // Client cache: profile name -> { client, forwardManager }
  const clientCache = new Map<string, ClientCacheEntry>()

  // Helper: Get or create SSH connection for a profile
  async function getClientForProfile(
    profileName: string | undefined,
    profileJson: string | undefined,
    profileFile: string | undefined,
  ): Promise<{ client: any; forwardManager: PortForwardManager }> {
    let profile: SSHProfile | undefined

    if (profileName) {
      profile = profileManager.getByName(profileName)
      if (!profile) {
        // 尝试按 alias 查找
        profile = profileManager.getByAlias(profileName)
      }
      if (!profile) {
        // 尝试从 profiles/ 目录加载配置文件
        const fileName = profileName.endsWith(".json") ? profileName : `${profileName}.json`
        profile = profileManager.loadFromFile(fileName)
      }
      if (!profile) {
        throw new Error(`Profile not found: ${profileName}`)
      }
      profileManager.markUsed(profile.id!)
    } else if (profileFile) {
      profile = profileManager.loadFromFile(profileFile)
      if (!profile) {
        throw new Error(`Profile file not found: ${profileFile}. Searched in: current dir profiles/, project root profiles/, ~/.ssh-tool/profiles/`)
      }
    } else if (profileJson) {
      profile = JSON.parse(profileJson) as SSHProfile
    } else if (initialConfig) {
      profile = {
        id: "default",
        name: "default",
        chain: [
          ...(initialConfig.gateways || []).map((g: HostConfig) => ({
            name: g.host,
            host: g.host,
            port: g.port ?? 22,
            auth: {
              username: g.username,
              password: g.password,
              privateKey: g.privateKey,
            },
          })),
          {
            name: initialConfig.target.host,
            host: initialConfig.target.host,
            port: initialConfig.target.port ?? 22,
            auth: {
              username: initialConfig.target.username,
              password: initialConfig.target.password,
              privateKey: initialConfig.target.privateKey,
            },
          },
        ],
      } as SSHProfile
    } else {
      throw new Error("Must provide either profile_name, profile_file, profile_json, or initial config")
    }

    const cacheKey = profileName || JSON.stringify(profile)

    if (clientCache.has(cacheKey)) {
      const cached = clientCache.get(cacheKey)!
      return cached
    }

    const currentProfile = profile
    const jumpHosts = currentProfile.chain.slice(0, -1).map((h) => ({
      host: h.host,
      port: h.port ?? 22,
      username: h.auth.username,
      password: h.auth.password,
      privateKey: h.auth.privateKey,
    }))

    const targetHost = currentProfile.chain[currentProfile.chain.length - 1]
    const session = await gw.connectSimple({
      host: targetHost.host,
      port: targetHost.port ?? 22,
      username: targetHost.auth.username,
      password: targetHost.auth.password,
      privateKey: targetHost.auth.privateKey,
      jumpHosts,
      name: `mcp-${currentProfile.name}`,
    })

    const connection = gw.sessions.getConnection(session.id)
    if (!connection) throw new Error("Failed to establish SSH connection")
    const client = connection.getFinalClient()

    const forwardManager = new PortForwardManager(client)
    log("mcp", `Connected to ${targetHost.host} (profile: ${currentProfile.name})`)

    clientCache.set(cacheKey, { client, forwardManager })
    return { client, forwardManager }
  }

  const daemonClient = new DaemonClient()
  let handlingFatal = false
  // P2-8: wrapTool converts uncaught handler errors into a structured MCP
  // error envelope so the agent sees a real error response (not a hung
  // request) and the daemon logs the stack for post-mortem debugging.
  // Tools that already return a friendly error text don't need changes
  // — wrapTool only fires when the handler *throws*.
  const wrapTool = <Args, Ret extends { content: Array<{ type: "text"; text: string }> }>(
    name: string,
    fn: (args: Args) => Promise<Ret>,
  ) => {
    return async (args: Args): Promise<Ret | (Ret & { isError: true })> => {
      try {
        return await fn(args)
      } catch (e) {
        const err = e as Error
        const detail = (err.stack ?? err.message).split("\n").slice(0, 4).join("\n")
        log("mcp", `Tool ${name} threw: ${err.message}\n${detail}`)
        return {
          isError: true,
          content: [{
            type: "text" as const,
            text: `[${name}] ${err.message}`,
          }],
        } as Ret & { isError: true }
      }
    }
  }
  const handleFatal = (err: Error) => {
    if (handlingFatal) {
      console.error(`[ssh-mcp] Fatal during fatal handling: ${err.message}`)
      process.exit(1)
    }
    handlingFatal = true
    void (async () => {
      console.error(`[ssh-mcp] Fatal error: ${err.message}`)
      log("mcp", "Fatal error: " + err.message)
      try {
        await daemonClient.abortActiveTasks(`MCP server fatal error: ${err.message}`)
      } catch (abortErr: any) {
        log("mcp", "Failed to abort daemon tasks after fatal error: " + abortErr.message)
      }
      try {
        await gw.disconnectAll()
      } catch (disconnectErr: any) {
        log("mcp", "Failed to disconnect MCP SSH sessions after fatal error: " + disconnectErr.message)
      }
      daemonClient.disconnect()
      process.exit(1)
    })()
  }
  process.on("uncaughtException", handleFatal)
  process.on("unhandledRejection", (err) => {
    handleFatal(err instanceof Error ? err : new Error(String(err)))
  })

  async function scheduleCommand(params: {
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
    profile_name?: string
    profile_json?: string
    profile_file?: string
  }): Promise<ScheduleDecision> {
    const profile = await getProfileForScheduler(params.profile_name, params.profile_json, params.profile_file)
    await daemonClient.ensureDaemon()

    const configJson = profileToLegacyConfigJson(profile)
    const connectResp = await daemonClient.connectHostJson(configJson)
    if (!connectResp.ok) {
      throw new Error(`Connection failed: ${(connectResp as any).error}`)
    }
    const { sessionId, configHash } = connectResp.data as any

    const scheduleReq = createMcpScheduleRequest({
      profile,
      sessionId,
      configHash,
      agentId: MCP_AGENT_ID,
      command: params.command,
      cwd: params.cwd,
      reason: params.reason,
      intent: params.intent,
      cost: params.cost,
      urgency: params.urgency,
      if_busy: params.if_busy,
      scheduler: params.scheduler ?? "auto",
      timeout: params.timeout,
      force: params.force,
      background: params.background,
    })

    const resp = await daemonClient.schedule(scheduleReq as unknown as Record<string, unknown>)
    if (!resp.ok) {
      throw new Error(`Schedule failed: ${(resp as any).error}`)
    }
    return resp.data as ScheduleDecision
  }

  function formatScheduleDecisionForAgent(decision: ScheduleDecision): string {
    return jsonText(scheduleDecisionEnvelope(decision))
  }

  async function getProfileForScheduler(
    profileName?: string,
    profileJson?: string,
    profileFile?: string,
  ): Promise<SSHProfile> {
    let profile: SSHProfile | undefined
    if (profileName) {
      profile = profileManager.getByName(profileName) ?? profileManager.getByAlias(profileName)
      if (!profile) {
        const fileName = profileName.endsWith(".json") ? profileName : `${profileName}.json`
        profile = profileManager.loadFromFile(fileName)
      }
      if (!profile) throw new Error(`Profile not found: ${profileName}`)
      profileManager.markUsed(profile.id)
    } else if (profileFile) {
      profile = profileManager.loadFromFile(profileFile)
      if (!profile) throw new Error(`Profile file not found: ${profileFile}`)
    } else if (profileJson) {
      profile = JSON.parse(profileJson) as SSHProfile
    } else if (initialConfig) {
      profile = {
        id: "default",
        name: "default",
        chain: [
          ...(initialConfig.gateways || []).map((g: HostConfig) => ({
            name: g.host,
            host: g.host,
            port: g.port ?? 22,
            auth: { username: g.username, password: g.password, privateKey: g.privateKey },
          })),
          {
            name: initialConfig.target.host,
            host: initialConfig.target.host,
            port: initialConfig.target.port ?? 22,
            auth: { username: initialConfig.target.username, password: initialConfig.target.password, privateKey: initialConfig.target.privateKey },
          },
        ],
      } as SSHProfile
    } else {
      throw new Error("Must provide profile_name, profile_file, profile_json, or initial config")
    }
    return profile
  }

  const server = new McpServer({
    name: "ssh-tool",
    version: "2.0.0",
  })

  // --- Remote execution ---
  server.tool(
    "ssh_exec",
    "Execute a shell command on the remote server via the shared scheduler. Default behavior: scripts, tests, builds, installs, and unknown medium+ commands are serial on the same host and may queue. If action=queued, do not rerun; use taskId with ssh_wait_task/ssh_queue_status and do unrelated work. If result.truncated=true, returned output is only a tail; read stdoutPath/stderrPath for full logs. Only use if_busy=run_anyway or scheduler=bypass when you are certain concurrency is safe.",
    {
      command: z.string().describe("Shell command to execute"),
      cwd: z.string().optional().describe("Working directory"),
      timeout: z.number().optional().describe("Timeout in ms (default: 30000)"),
      scheduler: z.enum(["auto", "bypass"]).optional().describe("Scheduler mode: auto (default, through scheduler) or bypass (skip queue, still registered)"),
      reason: z.string().optional().describe("Why you are running this command (for other AI agents to see)"),
      intent: z.string().optional().describe("Command intent: inspect, search, test, build, install, server, deploy, migration, cleanup, custom"),
      cost: z.string().optional().describe("Estimated cost: tiny, small, medium, large, exclusive"),
      urgency: z.enum(["low", "normal", "high", "urgent"]).optional().describe("Urgency level"),
      if_busy: z.enum(["run_anyway", "wait", "queue", "fail"]).optional().describe("When host is busy: queue (default for heavy), wait, fail, or run_anyway to bypass serial queue -- only use run_anyway when tasks are truly independent"),
      force: z.boolean().optional().describe("Force execution of risky commands"),
      profile_name: z.string().optional().describe("Name or alias of the SSH profile to use"),
      profile_json: z.string().optional().describe("JSON string of SSH profile (alternative to profile_name)"),
      profile_file: z.string().optional().describe("Path to a JSON file containing SSH profile (alternative to profile_name/profile_json)"),
    },
    wrapTool("ssh_exec", async (params) => {
      const decision = await scheduleCommand({
        command: params.command,
        cwd: params.cwd,
        scheduler: params.scheduler,
        reason: params.reason,
        intent: params.intent as TaskIntent | undefined,
        cost: params.cost as TaskCost | undefined,
        urgency: params.urgency as TaskUrgency | undefined,
        if_busy: params.if_busy,
        force: params.force,
        timeout: params.timeout,
        profile_name: params.profile_name,
        profile_json: params.profile_json,
        profile_file: params.profile_file,
      })
      return {
        content: [{
          type: "text" as const,
          text: formatScheduleDecisionForAgent(decision),
        }],
      }
    },
  ))

  // --- File operations ---
  server.tool(
    "ssh_read_file",
    "Read a file from the remote server. Returns file content as text.",
    {
      path: z.string().describe("File path on remote server"),
      offset: z.number().optional().describe("Start line (0-based)"),
      limit: z.number().optional().describe("Max lines to read"),
      profile_name: z.string().optional().describe("Name or alias of the SSH profile to use"),
      profile_json: z.string().optional().describe("JSON string of SSH profile"),
      profile_file: z.string().optional().describe("Path to a JSON file containing SSH profile"),
    },
    wrapTool("ssh_read_file", async ({ path, offset, limit, profile_name, profile_json, profile_file }) => {
      const { client } = await getClientForProfile(profile_name, profile_json, profile_file)
      const result = await remoteExec(client, `cat ${JSON.stringify(path)}`, { timeout: 30000 })
      if (result.code !== 0) {
        return { content: [{ type: "text" as const, text: `Error reading file: ${result.stderr}` }] }
      }
      const lines = result.stdout.split("\n")
      const start = offset ?? 0
      const end = limit ? start + limit : lines.length
      const selected = lines.slice(start, end)
      const output = selected.map((line, i) => `${start + i + 1}\t${line}`).join("\n")
      return { content: [{ type: "text" as const, text: output }] }
    },
  ))

  server.tool(
    "ssh_write_file",
    "Write content to a file on the remote server. Creates parent directories if needed.",
    {
      path: z.string().describe("File path on remote server"),
      content: z.string().describe("Content to write"),
      mode: z.string().optional().describe("File permissions (octal string, e.g. '644')"),
      profile_name: z.string().optional().describe("Name or alias of the SSH profile to use"),
      profile_json: z.string().optional().describe("JSON string of SSH profile"),
      profile_file: z.string().optional().describe("Path to a JSON file containing SSH profile"),
    },
    wrapTool("ssh_write_file", async ({ path, content, mode, profile_name, profile_json, profile_file }) => {
      const { client } = await getClientForProfile(profile_name, profile_json, profile_file)
      const dirCmd = `mkdir -p ${JSON.stringify(path.replace(/\/[^\/]*$/, ""))}`
      await remoteExec(client, dirCmd, { timeout: 10000 })
      const b64 = Buffer.from(content).toString("base64")
      const writeCmd = mode
        ? `echo ${b64} | base64 -d > ${JSON.stringify(path)} && chmod ${mode} ${JSON.stringify(path)}`
        : `echo ${b64} | base64 -d > ${JSON.stringify(path)}`
      const result = await remoteExec(client, writeCmd, { timeout: 30000 })
      if (result.code !== 0) {
        return { content: [{ type: "text" as const, text: `Error writing file: ${result.stderr}` }] }
      }
      return { content: [{ type: "text" as const, text: `Written ${content.length} bytes to ${path}` }] }
    },
  ))

  server.tool(
    "ssh_list_dir",
    "List files and directories on the remote server.",
    {
      path: z.string().describe("Directory path"),
      show_hidden: z.boolean().optional().describe("Show hidden files"),
      profile_name: z.string().optional().describe("Name or alias of the SSH profile to use"),
      profile_json: z.string().optional().describe("JSON string of SSH profile"),
      profile_file: z.string().optional().describe("Path to a JSON file containing SSH profile"),
    },
    wrapTool("ssh_list_dir", async ({ path, show_hidden, profile_name, profile_json, profile_file }) => {
      const { client } = await getClientForProfile(profile_name, profile_json, profile_file)
      const flag = show_hidden ? "-la" : "-l"
      const result = await remoteExec(client, `ls ${flag} ${JSON.stringify(path)}`, { timeout: 15000 })
      if (result.code !== 0) {
        return { content: [{ type: "text" as const, text: `Error: ${result.stderr}` }] }
      }
      return { content: [{ type: "text" as const, text: result.stdout }] }
    },
  ))

  server.tool(
    "ssh_exists",
    "Check if a file or directory exists on the remote server.",
    {
      path: z.string().describe("Path to check"),
      profile_name: z.string().optional().describe("Name or alias of the SSH profile to use"),
      profile_json: z.string().optional().describe("JSON string of SSH profile"),
      profile_file: z.string().optional().describe("Path to a JSON file containing SSH profile"),
    },
    wrapTool("ssh_exists", async ({ path, profile_name, profile_json, profile_file }) => {
      const { client } = await getClientForProfile(profile_name, profile_json, profile_file)
      const result = await remoteExec(client, `test -e ${JSON.stringify(path)} && echo "exists" || echo "not_found"`, { timeout: 5000 })
      return { content: [{ type: "text" as const, text: result.stdout.trim() }] }
    },
  ))

  server.tool(
    "ssh_stat",
    "Get file/directory stats (size, permissions, timestamps) on the remote server.",
    {
      path: z.string().describe("Path to stat"),
      profile_name: z.string().optional().describe("Name or alias of the SSH profile to use"),
      profile_json: z.string().optional().describe("JSON string of SSH profile"),
      profile_file: z.string().optional().describe("Path to a JSON file containing SSH profile"),
    },
    wrapTool("ssh_stat", async ({ path, profile_name, profile_json, profile_file }) => {
      const { client } = await getClientForProfile(profile_name, profile_json, profile_file)
      const result = await remoteExec(client, `stat ${JSON.stringify(path)}`, { timeout: 10000 })
      if (result.code !== 0) {
        return { content: [{ type: "text" as const, text: `Error: ${result.stderr}` }] }
      }
      return { content: [{ type: "text" as const, text: result.stdout }] }
    },
  ))

  server.tool(
    "ssh_grep",
    "Search for patterns in files on the remote server using grep.",
    {
      pattern: z.string().describe("Search pattern (regex)"),
      path: z.string().describe("Directory or file to search"),
      glob: z.string().optional().describe("File glob pattern to filter"),
      case_insensitive: z.boolean().optional().describe("Case insensitive search"),
      profile_name: z.string().optional().describe("Name or alias of the SSH profile to use"),
      profile_json: z.string().optional().describe("JSON string of SSH profile"),
      profile_file: z.string().optional().describe("Path to a JSON file containing SSH profile"),
    },
    wrapTool("ssh_grep", async ({ pattern, path, glob, case_insensitive, profile_name, profile_json, profile_file }) => {
      const { client } = await getClientForProfile(profile_name, profile_json, profile_file)
      let cmd = "grep -rn"
      if (case_insensitive) cmd += "i"
      if (glob) cmd += ` --include=${JSON.stringify(glob)}`
      cmd += ` ${JSON.stringify(pattern)} ${JSON.stringify(path)}`
      const result = await remoteExec(client, cmd, { timeout: 15000 })
      return { content: [{ type: "text" as const, text: result.stdout || result.stderr || "(no matches)" }] }
    },
  ))

  server.tool(
    "ssh_find",
    "Find files and directories on the remote server.",
    {
      path: z.string().describe("Start directory"),
      name: z.string().optional().describe("Filename pattern (glob)"),
      type: z.enum(["f", "d", "l"]).optional().describe("File type: f=file, d=directory, l=symlink"),
      max_depth: z.number().optional().describe("Maximum search depth"),
      profile_name: z.string().optional().describe("Name or alias of the SSH profile to use"),
      profile_json: z.string().optional().describe("JSON string of SSH profile"),
      profile_file: z.string().optional().describe("Path to a JSON file containing SSH profile"),
    },
    wrapTool("ssh_find", async ({ path, name, type, max_depth, profile_name, profile_json, profile_file }) => {
      const { client } = await getClientForProfile(profile_name, profile_json, profile_file)
      let cmd = `find ${JSON.stringify(path)}`
      if (max_depth) cmd += ` -maxdepth ${max_depth}`
      if (type) cmd += ` -type ${type}`
      if (name) cmd += ` -name ${JSON.stringify(name)}`
      const result = await remoteExec(client, cmd, { timeout: 15000 })
      return { content: [{ type: "text" as const, text: result.stdout || result.stderr || "(no results)" }] }
    },
  ))

  // --- File transfer ---
  server.tool(
    "ssh_upload",
    "Upload a local file or folder to the remote server. Automatically detects file/folder type.",
    {
      local_path: z.string().describe("Local file/folder path to upload"),
      remote_path: z.string().describe("Destination path on remote server"),
      compression_level: z.number().optional().describe("Compression level 1-9 (default: 6)"),
      overwrite: z.enum(["ask", "skip", "overwrite", "rename", "backup"]).optional().describe("Overwrite strategy (default: overwrite)"),
      skip_symlinks: z.boolean().optional().describe("Skip symbolic links (default: false)"),
      line_ending: z.enum(["auto", "lf", "crlf", "binary"]).optional().describe("Line ending conversion: auto (platform), lf (Unix), crlf (Windows), binary (no conversion)"),
      encoding: z.enum(["auto", "utf8", "gbk", "latin1"]).optional().describe("File encoding: auto, utf8, gbk, latin1. Converts between encodings during transfer."),
      profile_name: z.string().optional().describe("Name or alias of the SSH profile to use"),
      profile_json: z.string().optional().describe("JSON string of SSH profile"),
      profile_file: z.string().optional().describe("Path to a JSON file containing SSH profile"),
    },
    wrapTool("ssh_upload", async ({ local_path, remote_path, compression_level, overwrite, skip_symlinks, line_ending, encoding, profile_name, profile_json, profile_file }) => {
      const { client } = await getClientForProfile(profile_name, profile_json, profile_file)
      const result = await upload(client, local_path, remote_path, {
        compressionLevel: compression_level,
        overwrite: overwrite as any,
        skipSymlinks: skip_symlinks,
        lineEnding: line_ending as any,
        encoding: encoding as any,
      })
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] }
    },
  ))

  server.tool(
    "ssh_download",
    "Download a remote file or folder to the local machine. Automatically detects file/folder type.",
    {
      remote_path: z.string().describe("Remote file/folder path to download"),
      local_path: z.string().describe("Local destination path"),
      compression_level: z.number().optional().describe("Compression level 1-9 (default: 6)"),
      overwrite: z.enum(["ask", "skip", "overwrite", "rename", "backup"]).optional().describe("Overwrite strategy (default: overwrite)"),
      skip_symlinks: z.boolean().optional().describe("Skip symbolic links (default: false)"),
      line_ending: z.enum(["auto", "lf", "crlf", "binary"]).optional().describe("Line ending conversion: auto (platform), lf (Unix), crlf (Windows), binary (no conversion)"),
      encoding: z.enum(["auto", "utf8", "gbk", "latin1"]).optional().describe("File encoding: auto, utf8, gbk, latin1. Converts between encodings during transfer."),
      profile_name: z.string().optional().describe("Name or alias of the SSH profile to use"),
      profile_json: z.string().optional().describe("JSON string of SSH profile"),
      profile_file: z.string().optional().describe("Path to a JSON file containing SSH profile"),
    },
    wrapTool("ssh_download", async ({ remote_path, local_path, compression_level, overwrite, skip_symlinks, line_ending, encoding, profile_name, profile_json, profile_file }) => {
      const { client } = await getClientForProfile(profile_name, profile_json, profile_file)
      const result = await download(client, remote_path, local_path, {
        compressionLevel: compression_level,
        overwrite: overwrite as any,
        skipSymlinks: skip_symlinks,
        lineEnding: line_ending as any,
        encoding: encoding as any,
      })
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] }
    },
  ))

  // --- Background execution ---
  server.tool(
    "ssh_exec_background",
    "Start a command in the background on the remote server. It is registered in the shared scheduler and subject to the same serial/queuing rules as ssh_exec. Use ssh_exec_status with the returned taskId; do not start duplicate background jobs if action=queued.",
    {
      command: z.string().describe("Command to execute in background"),
      cwd: z.string().optional().describe("Working directory"),
      profile_name: z.string().optional().describe("Name or alias of the SSH profile to use"),
      profile_json: z.string().optional().describe("JSON string of SSH profile"),
      profile_file: z.string().optional().describe("Path to a JSON file containing SSH profile"),
    },
    wrapTool("ssh_exec_background", async ({ command, cwd, profile_name, profile_json, profile_file }) => {
      const decision = await scheduleCommand({
        command,
        cwd,
        scheduler: "auto",
        background: true,
        profile_name,
        profile_json,
        profile_file,
      })
      return { content: [{ type: "text" as const, text: formatScheduleDecisionForAgent(decision) }] }
    },
  ))

  server.tool(
    "ssh_exec_status",
    "Get exact status and output for a scheduler task. Default mode returns a bounded tail plus stdoutPath/stderrPath metadata; use mode=full only when you truly need the full output inline.",
    {
      task_id: z.string().describe("Task ID from exec_background"),
      mode: z.enum(["tail", "full"]).optional().describe("Output mode: tail (default) or full"),
    },
    wrapTool("ssh_exec_status", async ({ task_id, mode }) => {
      await daemonClient.ensureDaemon()
      const statusResp = await daemonClient.getTaskStatus(task_id)
      if (!statusResp.ok) {
        return { content: [{ type: "text" as const, text: jsonText(mcpErrorEnvelope("task_status", (statusResp as any).error)) }] }
      }

      const outputResp = await daemonClient.getTaskOutput(task_id, mode)
      if (!outputResp.ok) {
        return { content: [{ type: "text" as const, text: jsonText(mcpErrorEnvelope("task_status", (outputResp as any).error)) }] }
      }

      const result = {
        task: statusResp.data as any,
        output: outputResp.data as any,
      }
      return {
        content: [{
          type: "text" as const,
          text: jsonText(mcpEnvelope("task_status", result, guidanceForTaskStatus(result.task, result.output))),
        }],
      }
    },
  ))

  server.tool(
    "ssh_exec_cancel",
    "Cancel a running background task.",
    {
      task_id: z.string().describe("Task ID to cancel"),
    },
    wrapTool("ssh_exec_cancel", async ({ task_id }) => {
      await daemonClient.ensureDaemon()
      const resp = await daemonClient.cancelTask(task_id)
      if (!resp.ok) {
        return { content: [{ type: "text" as const, text: jsonText(mcpErrorEnvelope("cancel_result", (resp as any).error)) }] }
      }
      const cancelled = (resp.data as any)?.cancelled
      return {
        content: [{
          type: "text" as const,
          text: jsonText(mcpEnvelope(
            "cancel_result",
            { taskId: task_id, cancelled },
            cancelled
              ? ["Task was cancelled. Check ssh_queue_status before starting replacement heavy work."]
              : ["Task was not cancelled. It may be missing, already finished, or the running process could not be cancelled; call ssh_exec_status for the same taskId when unsure."],
          )),
        }],
      }
    },
  ))

  server.tool(
    "ssh_cleanup_outputs",
    "Clean old scheduler output files. Running and queued task outputs are protected.",
    {},
    wrapTool("ssh_cleanup_outputs", async () => {
      await daemonClient.ensureDaemon()
      const resp = await daemonClient.cleanupOutputs()
      if (!resp.ok) {
        return { content: [{ type: "text" as const, text: jsonText(mcpErrorEnvelope("cleanup_result", (resp as any).error)) }] }
      }
      return { content: [{ type: "text" as const, text: jsonText(mcpEnvelope("cleanup_result", resp.data)) }] }
    },
  ))

  server.tool(
    "ssh_list_tasks",
    "List all SSH tasks (both regular exec and background tasks).",
    {
      hostname: z.string().optional().describe("Filter tasks by remote hostname"),
    },
    wrapTool("ssh_list_tasks", async ({ hostname }) => {
      await daemonClient.ensureDaemon()
      const resp = await daemonClient.queueStatus({ hostId: hostname })
      if (!resp.ok) {
        return { content: [{ type: "text" as const, text: jsonText(mcpErrorEnvelope("queue_status", (resp as any).error)) }] }
      }
      return { content: [{ type: "text" as const, text: jsonText(mcpEnvelope("queue_status", resp.data)) }] }
    },
  ))

  // --- Host load monitoring ---
  server.tool(
    "ssh_get_host_load",
    "Get current load information for a remote machine, including CPU load average, memory usage, process count, and scheduler state (running/queued/recent tasks).",
    {
      profile_name: z.string().optional().describe("Name or alias of the SSH profile to use"),
      profile_json: z.string().optional().describe("JSON string of SSH profile"),
      profile_file: z.string().optional().describe("Path to a JSON file containing SSH profile"),
    },
    wrapTool("ssh_get_host_load", async ({ profile_name, profile_json, profile_file }) => {
      const entry = await getClientForProfile(profile_name, profile_json, profile_file)
      const clientObj = entry.client as Record<string, unknown>
      const innerClient = clientObj._client as Record<string, unknown> | undefined
      const config = innerClient?._config as Record<string, unknown> | undefined
      const hostname = config?.host as string | undefined
      
      const uptimeResult = await remoteExec(entry.client, "uptime", { timeout: 10000 })
      const memResult = await remoteExec(entry.client, "free -h", { timeout: 10000 })
      const procResult = await remoteExec(entry.client, "ps aux --no-headers | wc -l", { timeout: 10000 })
      const queueResp = await daemonClient.queueStatus({ hostId: hostname })
      const loadInfo = {
        hostname: hostname ?? "unknown",
        uptime: uptimeResult.stdout.trim(),
        memory: memResult.stdout.trim(),
        processCount: procResult.stdout.trim(),
        scheduler: queueResp.ok ? queueResp.data : { error: (queueResp as any).error },
      }
      return { content: [{ type: "text", text: jsonText(mcpEnvelope("host_load", loadInfo)) }] }
    },
  ))

  // --- Port forwarding ---
  server.tool(
    "ssh_local_forward",
    "Start local port forwarding (like ssh -L). Maps a remote service to localhost. Useful for accessing remote databases, APIs, or web UIs that are only available on the internal network.",
    {
      local_port: z.number().describe("Local port to listen on"),
      remote_host: z.string().describe("Remote host to connect to (e.g., 'db-server' or '127.0.0.1')"),
      remote_port: z.number().describe("Remote port to connect to"),
      local_addr: z.string().optional().describe("Local address to bind (default: 127.0.0.1)"),
      profile_name: z.string().optional().describe("Name or alias of the SSH profile to use"),
      profile_json: z.string().optional().describe("JSON string of SSH profile"),
      profile_file: z.string().optional().describe("Path to a JSON file containing SSH profile"),
    },
    wrapTool("ssh_local_forward", async ({ local_port, remote_host, remote_port, local_addr, profile_name, profile_json, profile_file }) => {
      const { forwardManager } = await getClientForProfile(profile_name, profile_json, profile_file)
      const forward = await forwardManager.localForward(local_addr ?? "127.0.0.1", local_port, remote_host, remote_port)
      return { content: [{ type: "text" as const, text: JSON.stringify(forward) }] }
    },
  ))

  server.tool(
    "ssh_remote_forward",
    "Start remote port forwarding (like ssh -R). Exposes a local service to the remote server. Useful for exposing local dev servers to remote machines.",
    {
      remote_port: z.number().describe("Port to listen on remote server"),
      local_host: z.string().describe("Local host to forward to (e.g., '127.0.0.1')"),
      local_port: z.number().describe("Local port to forward to"),
      remote_addr: z.string().optional().describe("Remote address to bind (default: 127.0.0.1)"),
      profile_name: z.string().optional().describe("Name or alias of the SSH profile to use"),
      profile_json: z.string().optional().describe("JSON string of SSH profile"),
      profile_file: z.string().optional().describe("Path to a JSON file containing SSH profile"),
    },
    wrapTool("ssh_remote_forward", async ({ remote_port, local_host, local_port, remote_addr, profile_name, profile_json, profile_file }) => {
      const { forwardManager } = await getClientForProfile(profile_name, profile_json, profile_file)
      const forward = await forwardManager.remoteForward(remote_addr ?? "127.0.0.1", remote_port, local_host, local_port)
      return { content: [{ type: "text" as const, text: JSON.stringify(forward) }] }
    },
  ))

  server.tool(
    "ssh_stop_forward",
    "Stop a port forward by its ID.",
    {
      forward_id: z.string().describe("Forward ID to stop"),
      profile_name: z.string().optional().describe("Name or alias of the SSH profile to use"),
      profile_json: z.string().optional().describe("JSON string of SSH profile"),
      profile_file: z.string().optional().describe("Path to a JSON file containing SSH profile"),
    },
    wrapTool("ssh_stop_forward", async ({ forward_id, profile_name, profile_json, profile_file }) => {
      const { forwardManager } = await getClientForProfile(profile_name, profile_json, profile_file)
      const stopped = await forwardManager.stop(forward_id)
      return { content: [{ type: "text" as const, text: stopped ? `Forward ${forward_id} stopped` : `Forward ${forward_id} not found` }] }
    },
  ))

  server.tool(
    "ssh_list_forwards",
    "List all active port forwards.",
    {
      profile_name: z.string().optional().describe("Name or alias of the SSH profile to use"),
      profile_json: z.string().optional().describe("JSON string of SSH profile"),
      profile_file: z.string().optional().describe("Path to a JSON file containing SSH profile"),
    },
    wrapTool("ssh_list_forwards", async ({ profile_name, profile_json, profile_file }) => {
      const { forwardManager } = await getClientForProfile(profile_name, profile_json, profile_file)
      const forwards = forwardManager.list()
      return { content: [{ type: "text" as const, text: JSON.stringify(forwards) }] }
    },
  ))

  // --- Profile management ---
  server.tool(
    "ssh_list_profiles",
    "List all available SSH profiles.",
    {},
    wrapTool("ssh_list_profiles", async () => {
      const profiles = profileManager.list()
      return { content: [{ type: "text" as const, text: JSON.stringify(profiles) }] }
    },
  ))

  server.tool(
    "ssh_add_profile",
    "Add a new SSH profile. This allows dynamic registration of SSH connections. The profile will be saved to disk.",
    {
      name: z.string().describe("Profile name (display name)"),
      alias: z.string().optional().describe("Short alias for quick reference"),
      chain: z.string().describe("JSON string of SSH connection chain. Example: [{\"host\":\"gateway.example.com\",\"port\":22,\"username\":\"user\",\"privateKey\":\"...\"},{\"host\":\"target.example.com\",\"port\":22,\"username\":\"deploy\",\"privateKey\":\"...\"}]"),
      tags: z.array(z.string()).optional().describe("Array of tags for organization"),
    },
    wrapTool("ssh_add_profile", async ({ name, alias, chain, tags }) => {
      try {
        const chainArray = JSON.parse(chain) as Omit<SSHHostConfig, "id">[]
        const profile = profileManager.add({
          name,
          alias,
          chain: chainArray,
          tags,
        })
        return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, profileId: profile.id, message: `Profile '${name}' added successfully` }) }] }
      } catch (err) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: (err as Error).message }) }] }
      }
    },
  ))

  server.tool(
    "ssh_remove_profile",
    "Remove an existing SSH profile by ID or name.",
    {
      profile_id: z.string().optional().describe("Profile ID to remove"),
      profile_name: z.string().optional().describe("Profile name to remove (alternative to profile_id)"),
    },
    wrapTool("ssh_remove_profile", async ({ profile_id, profile_name }) => {
      if (!profile_id && !profile_name) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: "Must provide profile_id or profile_name" }) }] }
      }

      let removed = false
      if (profile_id) {
        removed = profileManager.delete(profile_id)
      } else if (profile_name) {
        const profile = profileManager.getByName(profile_name)
        if (profile) {
          removed = profileManager.delete(profile.id)
        }
      }

      if (removed) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, message: "Profile removed successfully" }) }] }
      } else {
        return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: "Profile not found" }) }] }
      }
    },
  ))

  server.tool(
    "ssh_get_profile",
    "Get a specific SSH profile by ID, name, or alias.",
    {
      profile_id: z.string().optional().describe("Profile ID"),
      profile_name: z.string().optional().describe("Profile name"),
      profile_alias: z.string().optional().describe("Profile alias"),
    },
    wrapTool("ssh_get_profile", async ({ profile_id, profile_name, profile_alias }) => {
      let profile: SSHProfile | undefined

      if (profile_id) {
        profile = profileManager.get(profile_id)
      } else if (profile_name) {
        profile = profileManager.getByName(profile_name)
      } else if (profile_alias) {
        profile = profileManager.getByAlias(profile_alias)
      }

      if (profile) {
        return { content: [{ type: "text" as const, text: JSON.stringify(profile) }] }
      } else {
        return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: "Profile not found" }) }] }
      }
    },
  ))

  // --- Session management ---
  server.tool(
    "ssh_list_sessions",
    "List all active SSH sessions managed by this MCP server. Shows session ID, name, status, hops, and idle time.",
    {},
    wrapTool("ssh_list_sessions", async () => {
      const sessions = gw.sessions.listSessions()
      const sessionList = sessions.map((s: any) => ({
        id: s.id,
        name: s.name,
        status: s.status,
        hops: s.hops,
        chainSummary: s.chainSummary,
        createdAt: s.createdAt,
        lastActivity: s.lastActivity,
        idleSeconds: Math.floor((Date.now() - s.lastActivity) / 1000)
      }))
      return { content: [{ type: "text" as const, text: JSON.stringify(sessionList, null, 2) }] }
    },
  ))

  server.tool(
    "ssh_disconnect",
    "Disconnect a specific SSH session by its ID. Use ssh_list_sessions to find session IDs.",
    {
      session_id: z.string().describe("Session ID to disconnect"),
    },
    wrapTool("ssh_disconnect", async ({ session_id }) => {
      const session = gw.sessions.getSession(session_id)
      if (!session) {
        return { content: [{ type: "text" as const, text: `Session ${session_id} not found` }] }
      }
      await gw.sessions.disconnect(session_id)
      return { content: [{ type: "text" as const, text: `Session ${session_id} disconnected` }] }
    },
  ))

  server.tool(
    "ssh_cd",
    "Set a virtual working directory for this AI session on the target host. This is NOT a persistent remote shell cd: it only stores cwd for agentId+hostId and is applied to later ssh_exec/ssh_schedule calls that omit cwd. It does not affect other AI agents or shared SSH sessions.",
    {
      path: z.string().describe("Directory path to store as this AI session's virtual cwd"),
      profile_name: z.string().optional().describe("Name or alias of the SSH profile to use"),
      profile_json: z.string().optional().describe("JSON string of SSH profile"),
      profile_file: z.string().optional().describe("Path to a JSON file containing SSH profile"),
    },
    wrapTool("ssh_cd", async ({ path, profile_name, profile_json, profile_file }) => {
      const profile = await getProfileForScheduler(profile_name, profile_json, profile_file)
      await daemonClient.ensureDaemon()
      const configJson = profileToLegacyConfigJson(profile)
      const connectResp = await daemonClient.connectHostJson(configJson)
      if (!connectResp.ok) {
        return { content: [{ type: "text" as const, text: jsonText(mcpErrorEnvelope("cwd_result", `Connection failed: ${(connectResp as any).error}`)) }] }
      }
      const { sessionId, configHash } = connectResp.data as any
      const agentIdentity: AgentIdentity = { id: MCP_AGENT_ID, name: "mcp-server", clientType: "mcp" }
      const hostIdentity: HostIdentity = {
        id: configHash ?? sessionId.slice(0, 16),
        profileKey: configHash ?? sessionId.slice(0, 16),
        targetHost: profile.chain[profile.chain.length - 1].host,
        targetUser: profile.chain[profile.chain.length - 1].auth.username,
        displayName: profile.name,
      }
      const resp = await daemonClient.setCwd(agentIdentity, hostIdentity, path)
      if (!resp.ok) {
        return { content: [{ type: "text" as const, text: jsonText(mcpErrorEnvelope("cwd_result", (resp as any).error)) }] }
      }
      const data = resp.data as any
      return {
        content: [{
          type: "text" as const,
          text: jsonText(mcpEnvelope("cwd_result", {
            success: true,
            cwd: data.cwd,
            message: "已设置当前 AI 会话在该 host 上的虚拟 cwd；这不是远端 shell 的持久 cd，不会影响其他 AI 或共享 SSH 会话。",
          })),
        }],
      }
    },
  ))

  // --- Scheduler tools ---
  server.tool(
    "ssh_schedule",
    "Submit a command to the shared VM scheduler. Heavy commands (tests, builds, installs, scripts) default to serial and may queue behind running heavy work. If queued, keep the taskId and do other useful work; later call ssh_wait_task or ssh_queue_status. Use if_busy=run_anyway only for truly independent work.",
    {
      command: z.string().describe("Command to execute"),
      cwd: z.string().optional().describe("Working directory"),
      reason: z.string().optional().describe("Why you are running this command"),
      intent: z.string().optional().describe("Command intent"),
      cost: z.string().optional().describe("Estimated cost"),
      urgency: z.enum(["low", "normal", "high", "urgent"]).optional().describe("Urgency"),
      if_busy: z.enum(["run_anyway", "wait", "queue", "fail"]).optional().describe("When host is busy: queue (default for heavy), wait, fail, or run_anyway to bypass serial queue -- only use run_anyway when tasks are truly independent"),
      force: z.boolean().optional().describe("Force risky commands"),
      timeout: z.number().optional().describe("Timeout in ms"),
      profile_name: z.string().optional().describe("Profile name"),
      profile_json: z.string().optional().describe("Profile JSON"),
      profile_file: z.string().optional().describe("Profile file path"),
    },
    wrapTool("ssh_schedule", async (params) => {
      const decision = await scheduleCommand({
        command: params.command,
        cwd: params.cwd,
        scheduler: "auto",
        reason: params.reason,
        intent: params.intent as TaskIntent | undefined,
        cost: params.cost as TaskCost | undefined,
        urgency: params.urgency as TaskUrgency | undefined,
        if_busy: params.if_busy,
        force: params.force,
        timeout: params.timeout,
        profile_name: params.profile_name,
        profile_json: params.profile_json,
        profile_file: params.profile_file,
      })
      return {
        content: [{ type: "text" as const, text: formatScheduleDecisionForAgent(decision) }],
      }
    },
  ))

  server.tool(
    "ssh_queue_status",
    "Show running tasks, queued tasks, locks, recent completions, and this AI session's virtual cwd on the shared VM. Use this before starting heavy work when unsure whether the VM is busy.",
    {
      host_id: z.string().optional().describe("Filter by host ID"),
      limit: z.number().optional().describe("Max results (default 20)"),
    },
    wrapTool("ssh_queue_status", async ({ host_id, limit }) => {
      await daemonClient.ensureDaemon()
      const resp = await daemonClient.queueStatus({ agent: { id: MCP_AGENT_ID, clientType: "mcp" }, hostId: host_id, limit })
      if (!resp.ok) {
        return { content: [{ type: "text" as const, text: jsonText(mcpErrorEnvelope("queue_status", (resp as any).error)) }] }
      }
      return {
        content: [{
          type: "text" as const,
          text: jsonText(mcpEnvelope("queue_status", resp.data, [
            "Use running/queued/recent to decide whether to wait, queue, or run independent read-only work. Do not duplicate queued taskIds.",
          ])),
        }],
      }
    },
  ))

  server.tool(
    "ssh_wait_task",
    "Wait for a scheduled task to complete, or until timeout.",
    {
      task_id: z.string().describe("Task ID to wait for"),
      timeout: z.number().optional().describe("Timeout in ms (default 30000)"),
    },
    wrapTool("ssh_wait_task", async ({ task_id, timeout }) => {
      await daemonClient.ensureDaemon()
      const resp = await daemonClient.waitTask(task_id, timeout)
      if (!resp.ok) {
        return { content: [{ type: "text" as const, text: jsonText(mcpErrorEnvelope("wait_result", (resp as any).error)) }] }
      }
      const task = resp.data as any
      const waitTimedOut = task.status === "queued" || task.status === "running"
      let output: any | undefined
      if (!waitTimedOut) {
        const outputResp = await daemonClient.getTaskOutput(task_id, "tail")
        if (outputResp.ok) output = outputResp.data
      }
      const data = { task, output, waitTimedOut }
      return {
        content: [{
          type: "text" as const,
          text: jsonText(mcpEnvelope("wait_result", data, guidanceForWaitResult(task, waitTimedOut, output))),
        }],
      }
    },
  ))

  server.tool(
    "ssh_dequeue_task",
    "Remove a queued task from the scheduler before it starts.",
    {
      task_id: z.string().describe("Task ID to dequeue"),
    },
    wrapTool("ssh_dequeue_task", async ({ task_id }) => {
      await daemonClient.ensureDaemon()
      const resp = await daemonClient.dequeueTask(task_id, { id: MCP_AGENT_ID, clientType: "mcp" })
      if (!resp.ok) {
        return { content: [{ type: "text" as const, text: jsonText(mcpErrorEnvelope("dequeue_result", (resp as any).error)) }] }
      }
      return { content: [{ type: "text" as const, text: jsonText(mcpEnvelope("dequeue_result", resp.data)) }] }
    },
  ))

  // Start MCP server via stdio
  const transport = new StdioServerTransport()
  await server.connect(transport)
  log("mcp", "MCP server started on stdio")

  // Graceful shutdown
  process.on("SIGTERM", async () => {
    log("mcp", "Shutting down...")
    await gw.disconnectAll()
    process.exit(0)
  })
  process.on("SIGINT", async () => {
    log("mcp", "Shutting down...")
    await gw.disconnectAll()
    process.exit(0)
  })
}

main().catch((err) => {
  console.error(`[ssh-mcp] Fatal error: ${err.message}`)
  process.exit(1)
})
