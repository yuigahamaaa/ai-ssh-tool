#!/usr/bin/env node

/**
 * SSH MCP Server - exposes SSH remote tools via Model Context Protocol
 *
 * Usage:
 *   node mcp-server.js --config <json-file>
 *   node mcp-server.js --config-json '<json>'
 *
 * Runs as a stdio-based MCP server for AI agents (Claude, etc.)
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
import { enableDebug, log, logError } from "./logger.js"
import { checkDeps } from "./check-deps.js"

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

function loadConfig(): SshConfig {
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

  throw new Error("Must provide --config <file> or --config-json '<json>'")
}

async function main() {
  checkDeps()

  const config = loadConfig()
  log("mcp", `Connecting to ${config.target.host}...`)

  const gw = new SSHGateway({
    connectionTimeout: config.timeout ?? 15000,
    maxSessions: 1,
  })

  const bgManager = new BackgroundExecManager()

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
    name: `mcp-${config.target.host}`,
  })

  const connection = gw.sessions.getConnection(session.id)
  if (!connection) throw new Error("Failed to establish SSH connection")
  const client = connection.getFinalClient()

  log("mcp", `Connected to ${config.target.host}, session: ${session.id.slice(0, 8)}`)

  const server = new McpServer({
    name: "ssh-tool",
    version: "2.0.0",
  })

  // --- Remote execution ---
  server.tool(
    "remote_exec",
    "Execute a shell command on the remote server. Returns stdout, stderr, and exit code.",
    {
      command: z.string().describe("Shell command to execute"),
      cwd: z.string().optional().describe("Working directory"),
      timeout: z.number().optional().describe("Timeout in ms (default: 30000)"),
    },
    async ({ command, cwd, timeout }) => {
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
    "remote_read_file",
    "Read a file from the remote server. Returns file content as text.",
    {
      path: z.string().describe("File path on remote server"),
      offset: z.number().optional().describe("Start line (0-based)"),
      limit: z.number().optional().describe("Max lines to read"),
    },
    async ({ path, offset, limit }) => {
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
    "remote_write_file",
    "Write content to a file on the remote server. Creates parent directories if needed.",
    {
      path: z.string().describe("File path on remote server"),
      content: z.string().describe("Content to write"),
      mode: z.string().optional().describe("File permissions (octal string, e.g. '644')"),
    },
    async ({ path, content, mode }) => {
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
    "remote_list_dir",
    "List files and directories on the remote server.",
    {
      path: z.string().describe("Directory path"),
      show_hidden: z.boolean().optional().describe("Show hidden files"),
    },
    async ({ path, show_hidden }) => {
      const flag = show_hidden ? "-la" : "-l"
      const result = await remoteExec(client, `ls ${flag} ${JSON.stringify(path)}`, { timeout: 15000 })
      if (result.code !== 0) {
        return { content: [{ type: "text" as const, text: `Error: ${result.stderr}` }] }
      }
      return { content: [{ type: "text" as const, text: result.stdout }] }
    },
  )

  server.tool(
    "remote_exists",
    "Check if a file or directory exists on the remote server.",
    {
      path: z.string().describe("Path to check"),
    },
    async ({ path }) => {
      const result = await remoteExec(client, `test -e ${JSON.stringify(path)} && echo "exists" || echo "not_found"`, { timeout: 5000 })
      return { content: [{ type: "text" as const, text: result.stdout.trim() }] }
    },
  )

  server.tool(
    "remote_stat",
    "Get file/directory stats (size, permissions, timestamps) on the remote server.",
    {
      path: z.string().describe("Path to stat"),
    },
    async ({ path }) => {
      const result = await remoteExec(client, `stat ${JSON.stringify(path)}`, { timeout: 10000 })
      if (result.code !== 0) {
        return { content: [{ type: "text" as const, text: `Error: ${result.stderr}` }] }
      }
      return { content: [{ type: "text" as const, text: result.stdout }] }
    },
  )

  server.tool(
    "remote_grep",
    "Search for patterns in files on the remote server using grep.",
    {
      pattern: z.string().describe("Search pattern (regex)"),
      path: z.string().describe("Directory or file to search"),
      glob: z.string().optional().describe("File glob pattern to filter"),
      case_insensitive: z.boolean().optional().describe("Case insensitive search"),
    },
    async ({ pattern, path, glob, case_insensitive }) => {
      let cmd = "grep -rn"
      if (case_insensitive) cmd += "i"
      if (glob) cmd += ` --include=${JSON.stringify(glob)}`
      cmd += ` ${JSON.stringify(pattern)} ${JSON.stringify(path)}`
      const result = await remoteExec(client, cmd, { timeout: 15000 })
      return { content: [{ type: "text" as const, text: result.stdout || result.stderr || "(no matches)" }] }
    },
  )

  server.tool(
    "remote_find",
    "Find files and directories on the remote server.",
    {
      path: z.string().describe("Start directory"),
      name: z.string().optional().describe("Filename pattern (glob)"),
      type: z.enum(["f", "d", "l"]).optional().describe("File type: f=file, d=directory, l=symlink"),
      max_depth: z.number().optional().describe("Maximum search depth"),
    },
    async ({ path, name, type, max_depth }) => {
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
    "upload_file",
    "Upload a local file to the remote server via SFTP streaming. Supports large files.",
    {
      local_path: z.string().describe("Local file path to upload"),
      remote_path: z.string().describe("Destination path on remote server"),
    },
    async ({ local_path, remote_path }) => {
      const result = await uploadFile(client, local_path, remote_path)
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] }
    },
  )

  server.tool(
    "download_file",
    "Download a remote file to local machine via SFTP streaming. Supports large files.",
    {
      remote_path: z.string().describe("Remote file path to download"),
      local_path: z.string().describe("Local destination path"),
    },
    async ({ remote_path, local_path }) => {
      const result = await downloadFile(client, remote_path, local_path)
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] }
    },
  )

  server.tool(
    "upload_folder",
    "Upload a local folder to the remote server. Compresses locally, transfers, then decompresses on remote.",
    {
      local_path: z.string().describe("Local folder path to upload"),
      remote_path: z.string().describe("Destination folder path on remote server"),
      compression_level: z.number().optional().describe("Compression level 1-9 (default: 6)"),
    },
    async ({ local_path, remote_path, compression_level }) => {
      const result = await uploadFolder(client, local_path, remote_path, { compressionLevel: compression_level })
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] }
    },
  )

  server.tool(
    "download_folder",
    "Download a remote folder to local machine. Compresses on remote, transfers, then decompresses locally.",
    {
      remote_path: z.string().describe("Remote folder path to download"),
      local_path: z.string().describe("Local destination folder path"),
    },
    async ({ remote_path, local_path }) => {
      const result = await downloadFolder(client, remote_path, local_path)
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] }
    },
  )

  // --- Background execution ---
  server.tool(
    "exec_background",
    "Start a command in the background on the remote server. Returns a task handle for status queries.",
    {
      command: z.string().describe("Command to execute in background"),
      cwd: z.string().optional().describe("Working directory"),
    },
    async ({ command, cwd }) => {
      const task = await bgManager.start(client, command, { cwd })
      return { content: [{ type: "text" as const, text: JSON.stringify({ taskId: task.id, status: task.status, pid: task.pid, command: task.command }) }] }
    },
  )

  server.tool(
    "exec_status",
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
    "exec_cancel",
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
    "list_tasks",
    "List all background tasks and their statuses.",
    {},
    async () => {
      const tasks = bgManager.list()
      return { content: [{ type: "text" as const, text: JSON.stringify(tasks) }] }
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
