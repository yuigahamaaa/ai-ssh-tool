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
import { BackgroundExecManager } from "./background-exec.js"
import { uploadFile, downloadFile, uploadFolder, downloadFolder } from "./file-transfer.js"
import { PortForwardManager } from "./port-forwarding.js"
import { ProfileManager } from "./profile-manager.js"
import { enableDebug, log, logError } from "./logger.js"
import { checkDeps } from "./check-deps.js"
import type { SSHProfile, SSHHostConfig } from "./types.js"

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

async function main() {
  checkDeps()

  const initialConfig = loadConfig()

  const gw = new SSHGateway({
    connectionTimeout: initialConfig?.timeout ?? 15000,
    maxSessions: 10, // Allow more concurrent sessions
  })

  const profileManager = new ProfileManager()
  profileManager.load()

  const bgManager = new BackgroundExecManager()

  // Client cache: profile name -> { client, forwardManager }
  const clientCache = new Map<string, ClientCacheEntry>()

  // Helper: Get or create SSH connection for a profile
  async function getClientForProfile(
    profileName: string | undefined,
    profileJson: string | undefined,
  ): Promise<{ client: any; forwardManager: PortForwardManager }> {
    let profile: SSHProfile | undefined

    if (profileName) {
      profile = profileManager.getByName(profileName)
      if (!profile) {
        throw new Error(`Profile not found: ${profileName}`)
      }
      profileManager.markUsed(profile.id!)
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
      throw new Error("Must provide either profile_name, profile_json, or initial config")
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

  const server = new McpServer({
    name: "ssh-tool",
    version: "2.0.0",
  })

  // --- Remote execution ---
  server.tool(
    "ssh_exec",
    "Execute a shell command on the remote server. Returns stdout, stderr, and exit code.",
    {
      command: z.string().describe("Shell command to execute"),
      cwd: z.string().optional().describe("Working directory"),
      timeout: z.number().optional().describe("Timeout in ms (default: 30000)"),
      profile_name: z.string().optional().describe("Name of the SSH profile to use"),
      profile_json: z.string().optional().describe("JSON string of SSH profile to use (if not using a named profile)"),
    },
    async ({ command, cwd, timeout, profile_name, profile_json }) => {
      const { client } = await getClientForProfile(profile_name, profile_json)
      const result = await remoteExec(client, command, { timeout: timeout ?? 30000, cwd })
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ exitCode: result.code, stdout: result.stdout, stderr: result.stderr }),
        }],
      }
    },
  )

  // --- File operations ---
  server.tool(
    "ssh_read_file",
    "Read a file from the remote server. Returns file content as text.",
    {
      path: z.string().describe("File path on remote server"),
      offset: z.number().optional().describe("Start line (0-based)"),
      limit: z.number().optional().describe("Max lines to read"),
      profile_name: z.string().optional().describe("Name of the SSH profile to use"),
      profile_json: z.string().optional().describe("JSON string of SSH profile to use (if not using a named profile)"),
    },
    async ({ path, offset, limit, profile_name, profile_json }) => {
      const { client } = await getClientForProfile(profile_name, profile_json)
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
  )

  server.tool(
    "ssh_write_file",
    "Write content to a file on the remote server. Creates parent directories if needed.",
    {
      path: z.string().describe("File path on remote server"),
      content: z.string().describe("Content to write"),
      mode: z.string().optional().describe("File permissions (octal string, e.g. '644')"),
      profile_name: z.string().optional().describe("Name of the SSH profile to use"),
      profile_json: z.string().optional().describe("JSON string of SSH profile to use (if not using a named profile)"),
    },
    async ({ path, content, mode, profile_name, profile_json }) => {
      const { client } = await getClientForProfile(profile_name, profile_json)
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
  )

  server.tool(
    "ssh_list_dir",
    "List files and directories on the remote server.",
    {
      path: z.string().describe("Directory path"),
      show_hidden: z.boolean().optional().describe("Show hidden files"),
      profile_name: z.string().optional().describe("Name of the SSH profile to use"),
      profile_json: z.string().optional().describe("JSON string of SSH profile to use (if not using a named profile)"),
    },
    async ({ path, show_hidden, profile_name, profile_json }) => {
      const { client } = await getClientForProfile(profile_name, profile_json)
      const flag = show_hidden ? "-la" : "-l"
      const result = await remoteExec(client, `ls ${flag} ${JSON.stringify(path)}`, { timeout: 15000 })
      if (result.code !== 0) {
        return { content: [{ type: "text" as const, text: `Error: ${result.stderr}` }] }
      }
      return { content: [{ type: "text" as const, text: result.stdout }] }
    },
  )

  server.tool(
    "ssh_exists",
    "Check if a file or directory exists on the remote server.",
    {
      path: z.string().describe("Path to check"),
      profile_name: z.string().optional().describe("Name of the SSH profile to use"),
      profile_json: z.string().optional().describe("JSON string of SSH profile to use (if not using a named profile)"),
    },
    async ({ path, profile_name, profile_json }) => {
      const { client } = await getClientForProfile(profile_name, profile_json)
      const result = await remoteExec(client, `test -e ${JSON.stringify(path)} && echo "exists" || echo "not_found"`, { timeout: 5000 })
      return { content: [{ type: "text" as const, text: result.stdout.trim() }] }
    },
  )

  server.tool(
    "ssh_stat",
    "Get file/directory stats (size, permissions, timestamps) on the remote server.",
    {
      path: z.string().describe("Path to stat"),
      profile_name: z.string().optional().describe("Name of the SSH profile to use"),
      profile_json: z.string().optional().describe("JSON string of SSH profile to use (if not using a named profile)"),
    },
    async ({ path, profile_name, profile_json }) => {
      const { client } = await getClientForProfile(profile_name, profile_json)
      const result = await remoteExec(client, `stat ${JSON.stringify(path)}`, { timeout: 10000 })
      if (result.code !== 0) {
        return { content: [{ type: "text" as const, text: `Error: ${result.stderr}` }] }
      }
      return { content: [{ type: "text" as const, text: result.stdout }] }
    },
  )

  server.tool(
    "ssh_grep",
    "Search for patterns in files on the remote server using grep.",
    {
      pattern: z.string().describe("Search pattern (regex)"),
      path: z.string().describe("Directory or file to search"),
      glob: z.string().optional().describe("File glob pattern to filter"),
      case_insensitive: z.boolean().optional().describe("Case insensitive search"),
      profile_name: z.string().optional().describe("Name of the SSH profile to use"),
      profile_json: z.string().optional().describe("JSON string of SSH profile to use (if not using a named profile)"),
    },
    async ({ pattern, path, glob, case_insensitive, profile_name, profile_json }) => {
      const { client } = await getClientForProfile(profile_name, profile_json)
      let cmd = "grep -rn"
      if (case_insensitive) cmd += "i"
      if (glob) cmd += ` --include=${JSON.stringify(glob)}`
      cmd += ` ${JSON.stringify(pattern)} ${JSON.stringify(path)}`
      const result = await remoteExec(client, cmd, { timeout: 15000 })
      return { content: [{ type: "text" as const, text: result.stdout || result.stderr || "(no matches)" }] }
    },
  )

  server.tool(
    "ssh_find",
    "Find files and directories on the remote server.",
    {
      path: z.string().describe("Start directory"),
      name: z.string().optional().describe("Filename pattern (glob)"),
      type: z.enum(["f", "d", "l"]).optional().describe("File type: f=file, d=directory, l=symlink"),
      max_depth: z.number().optional().describe("Maximum search depth"),
      profile_name: z.string().optional().describe("Name of the SSH profile to use"),
      profile_json: z.string().optional().describe("JSON string of SSH profile to use (if not using a named profile)"),
    },
    async ({ path, name, type, max_depth, profile_name, profile_json }) => {
      const { client } = await getClientForProfile(profile_name, profile_json)
      let cmd = `find ${JSON.stringify(path)}`
      if (max_depth) cmd += ` -maxdepth ${max_depth}`
      if (type) cmd += ` -type ${type}`
      if (name) cmd += ` -name ${JSON.stringify(name)}`
      const result = await remoteExec(client, cmd, { timeout: 15000 })
      return { content: [{ type: "text" as const, text: result.stdout || result.stderr || "(no results)" }] }
    },
  )

  // --- File transfer ---
  server.tool(
    "ssh_upload_file",
    "Upload a local file to the remote server via SFTP streaming. Supports large files.",
    {
      local_path: z.string().describe("Local file path to upload"),
      remote_path: z.string().describe("Destination path on remote server"),
      profile_name: z.string().optional().describe("Name of the SSH profile to use"),
      profile_json: z.string().optional().describe("JSON string of SSH profile to use (if not using a named profile)"),
    },
    async ({ local_path, remote_path, profile_name, profile_json }) => {
      const { client } = await getClientForProfile(profile_name, profile_json)
      const result = await uploadFile(client, local_path, remote_path)
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] }
    },
  )

  server.tool(
    "ssh_download_file",
    "Download a remote file to local machine via SFTP streaming. Supports large files.",
    {
      remote_path: z.string().describe("Remote file path to download"),
      local_path: z.string().describe("Local destination path"),
      profile_name: z.string().optional().describe("Name of the SSH profile to use"),
      profile_json: z.string().optional().describe("JSON string of SSH profile to use (if not using a named profile)"),
    },
    async ({ remote_path, local_path, profile_name, profile_json }) => {
      const { client } = await getClientForProfile(profile_name, profile_json)
      const result = await downloadFile(client, remote_path, local_path)
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] }
    },
  )

  server.tool(
    "ssh_upload_folder",
    "Upload a local folder to the remote server. Compresses locally, transfers, then decompresses on remote.",
    {
      local_path: z.string().describe("Local folder path to upload"),
      remote_path: z.string().describe("Destination folder path on remote server"),
      compression_level: z.number().optional().describe("Compression level 1-9 (default: 6)"),
      profile_name: z.string().optional().describe("Name of the SSH profile to use"),
      profile_json: z.string().optional().describe("JSON string of SSH profile to use (if not using a named profile)"),
    },
    async ({ local_path, remote_path, compression_level, profile_name, profile_json }) => {
      const { client } = await getClientForProfile(profile_name, profile_json)
      const result = await uploadFolder(client, local_path, remote_path, { compressionLevel: compression_level })
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] }
    },
  )

  server.tool(
    "ssh_download_folder",
    "Download a remote folder to local machine. Compresses on remote, transfers, then decompresses locally.",
    {
      remote_path: z.string().describe("Remote folder path to download"),
      local_path: z.string().describe("Local destination folder path"),
      profile_name: z.string().optional().describe("Name of the SSH profile to use"),
      profile_json: z.string().optional().describe("JSON string of SSH profile to use (if not using a named profile)"),
    },
    async ({ remote_path, local_path, profile_name, profile_json }) => {
      const { client } = await getClientForProfile(profile_name, profile_json)
      const result = await downloadFolder(client, remote_path, local_path)
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] }
    },
  )

  // --- Background execution ---
  server.tool(
    "ssh_exec_background",
    "Start a command in the background on the remote server. Returns a task handle for status queries.",
    {
      command: z.string().describe("Command to execute in background"),
      cwd: z.string().optional().describe("Working directory"),
      profile_name: z.string().optional().describe("Name of the SSH profile to use"),
      profile_json: z.string().optional().describe("JSON string of SSH profile to use (if not using a named profile)"),
    },
    async ({ command, cwd, profile_name, profile_json }) => {
      const { client } = await getClientForProfile(profile_name, profile_json)
      const task = await bgManager.start(client, command, { cwd })
      return { content: [{ type: "text" as const, text: JSON.stringify({ taskId: task.id, status: task.status, pid: task.pid, command: task.command }) }] }
    },
  )

  server.tool(
    "ssh_exec_status",
    "Get the status and output of a background task.",
    {
      task_id: z.string().describe("Task ID from exec_background"),
      stdout_offset: z.number().optional().describe("Read stdout from this byte offset (default: 0, returns all)"),
      stderr_offset: z.number().optional().describe("Read stderr from this byte offset (default: 0, returns all)"),
    },
    async ({ task_id, stdout_offset, stderr_offset }) => {
      const task = bgManager.getStatus(task_id)
      if (!task) {
        return { content: [{ type: "text" as const, text: `Task ${task_id} not found` }] }
      }
      if (stdout_offset || stderr_offset) {
        const partial = bgManager.getOutputSince(task_id, stdout_offset ?? 0, stderr_offset ?? 0)
        return { content: [{ type: "text" as const, text: JSON.stringify({ ...task, ...partial }) }] }
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(task) }] }
    },
  )

  server.tool(
    "ssh_exec_cancel",
    "Cancel a running background task.",
    {
      task_id: z.string().describe("Task ID to cancel"),
    },
    async ({ task_id }) => {
      const cancelled = bgManager.cancel(task_id)
      return { content: [{ type: "text" as const, text: cancelled ? `Task ${task_id} cancelled` : `Task ${task_id} not found or already finished` }] }
    },
  )

  server.tool(
    "ssh_list_tasks",
    "List all background tasks and their statuses.",
    {},
    async () => {
      const tasks = bgManager.list()
      return { content: [{ type: "text" as const, text: JSON.stringify(tasks) }] }
    },
  )

  // --- Port forwarding ---
  server.tool(
    "ssh_local_forward",
    "Start local port forwarding (like ssh -L). Maps a remote service to localhost. Useful for accessing remote databases, APIs, or web UIs that are only available on the internal network.",
    {
      local_port: z.number().describe("Local port to listen on"),
      remote_host: z.string().describe("Remote host to connect to (e.g., 'db-server' or '127.0.0.1')"),
      remote_port: z.number().describe("Remote port to connect to"),
      local_addr: z.string().optional().describe("Local address to bind (default: 127.0.0.1)"),
      profile_name: z.string().optional().describe("Name of the SSH profile to use"),
      profile_json: z.string().optional().describe("JSON string of SSH profile to use (if not using a named profile)"),
    },
    async ({ local_port, remote_host, remote_port, local_addr, profile_name, profile_json }) => {
      const { forwardManager } = await getClientForProfile(profile_name, profile_json)
      const forward = await forwardManager.localForward(local_addr ?? "127.0.0.1", local_port, remote_host, remote_port)
      return { content: [{ type: "text" as const, text: JSON.stringify(forward) }] }
    },
  )

  server.tool(
    "ssh_remote_forward",
    "Start remote port forwarding (like ssh -R). Exposes a local service to the remote server. Useful for exposing local dev servers to remote machines.",
    {
      remote_port: z.number().describe("Port to listen on remote server"),
      local_host: z.string().describe("Local host to forward to (e.g., '127.0.0.1')"),
      local_port: z.number().describe("Local port to forward to"),
      remote_addr: z.string().optional().describe("Remote address to bind (default: 127.0.0.1)"),
      profile_name: z.string().optional().describe("Name of the SSH profile to use"),
      profile_json: z.string().optional().describe("JSON string of SSH profile to use (if not using a named profile)"),
    },
    async ({ remote_port, local_host, local_port, remote_addr, profile_name, profile_json }) => {
      const { forwardManager } = await getClientForProfile(profile_name, profile_json)
      const forward = await forwardManager.remoteForward(remote_addr ?? "127.0.0.1", remote_port, local_host, local_port)
      return { content: [{ type: "text" as const, text: JSON.stringify(forward) }] }
    },
  )

  server.tool(
    "ssh_stop_forward",
    "Stop a port forward by its ID.",
    {
      forward_id: z.string().describe("Forward ID to stop"),
      profile_name: z.string().optional().describe("Name of the SSH profile to use"),
      profile_json: z.string().optional().describe("JSON string of SSH profile to use (if not using a named profile)"),
    },
    async ({ forward_id, profile_name, profile_json }) => {
      const { forwardManager } = await getClientForProfile(profile_name, profile_json)
      const stopped = await forwardManager.stop(forward_id)
      return { content: [{ type: "text" as const, text: stopped ? `Forward ${forward_id} stopped` : `Forward ${forward_id} not found` }] }
    },
  )

  server.tool(
    "ssh_list_forwards",
    "List all active port forwards.",
    {
      profile_name: z.string().optional().describe("Name of the SSH profile to use"),
      profile_json: z.string().optional().describe("JSON string of SSH profile to use (if not using a named profile)"),
    },
    async ({ profile_name, profile_json }) => {
      const { forwardManager } = await getClientForProfile(profile_name, profile_json)
      const forwards = forwardManager.list()
      return { content: [{ type: "text" as const, text: JSON.stringify(forwards) }] }
    },
  )

  // --- Profile management ---
  server.tool(
    "ssh_list_profiles",
    "List all available SSH profiles.",
    {},
    async () => {
      const profiles = profileManager.list()
      return { content: [{ type: "text" as const, text: JSON.stringify(profiles) }] }
    },
  )

  // --- Session management ---
  server.tool(
    "ssh_list_sessions",
    "List all active SSH sessions managed by this MCP server. Shows session ID, name, status, hops, and idle time.",
    {},
    async () => {
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
  )

  server.tool(
    "ssh_disconnect",
    "Disconnect a specific SSH session by its ID. Use ssh_list_sessions to find session IDs.",
    {
      session_id: z.string().describe("Session ID to disconnect"),
    },
    async ({ session_id }) => {
      const session = gw.sessions.getSession(session_id)
      if (!session) {
        return { content: [{ type: "text" as const, text: `Session ${session_id} not found` }] }
      }
      await gw.sessions.disconnect(session_id)
      return { content: [{ type: "text" as const, text: `Session ${session_id} disconnected` }] }
    },
  )

  server.tool(
    "ssh_cd",
    "Change the working directory for subsequent commands. Creates the directory if it doesn't exist.",
    {
      path: z.string().describe("Directory path to change to"),
      profile_name: z.string().optional().describe("Name of the SSH profile to use"),
      profile_json: z.string().optional().describe("JSON string of SSH profile to use (if not using a named profile)"),
    },
    async ({ path, profile_name, profile_json }) => {
      const { client } = await getClientForProfile(profile_name, profile_json)
      const mkdirResult = await remoteExec(client, `mkdir -p ${JSON.stringify(path)} && cd ${JSON.stringify(path)} && pwd`, { timeout: 10000 })
      if (mkdirResult.code !== 0) {
        return { content: [{ type: "text" as const, text: `Failed to change directory: ${mkdirResult.stderr}` }] }
      }
      const cwd = mkdirResult.stdout.trim()
      return { content: [{ type: "text" as const, text: `Changed directory to: ${cwd}` }] }
    },
  )

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
