/**
 * Remote Tools - opencode tool definitions that proxy operations to remote SSH sessions
 *
 * When connected to a remote session, these tools replace the local equivalents:
 * - File read/write → SFTP on remote
 * - Shell exec → ssh exec on remote
 * - File search → grep/find on remote
 *
 * This is the key integration that makes opencode's AI work on the remote machine
 * (similar to VS Code Remote SSH's approach).
 */

import type { Client } from "ssh2"
import { createRemoteFs, type RemoteFs } from "./remote-fs.js"
import { remoteExec, type ExecResult } from "./remote-shell.js"
import type { SecurityPolicy } from "./types.js"

export interface RemoteToolContext {
  sessionId: string
  client: Client
  cwd: string
}

// --- Security policy helpers ---

function validateCommand(command: string, policy?: SecurityPolicy): void {
  if (!policy) return

  if (policy.maxCommandLength && command.length > policy.maxCommandLength) {
    throw new Error(`Command exceeds maximum length (${policy.maxCommandLength})`)
  }

  // Extract base command: skip env var assignments (VAR=val ...) and cd prefixes
  let cmd = command.trim()
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(cmd)) {
    cmd = cmd.replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^ ]*)\s*/, "")
  }
  const baseCommand = cmd.split(/\s+/)[0]

  if (policy.commandWhitelist && policy.commandWhitelist.length > 0) {
    if (!policy.commandWhitelist.includes(baseCommand)) {
      throw new Error(`Command not in whitelist: ${baseCommand}`)
    }
  }

  if (policy.commandBlacklist && policy.commandBlacklist.length > 0) {
    if (policy.commandBlacklist.includes(baseCommand)) {
      throw new Error(`Command is blacklisted: ${baseCommand}`)
    }
  }
}

function checkReadOnly(operation: string, policy?: SecurityPolicy): void {
  if (policy?.readOnly) {
    throw new Error(`Operation "${operation}" is not allowed in read-only mode`)
  }
}

function checkBlockedPath(path: string, policy?: SecurityPolicy): void {
  if (!policy?.blockedPaths || policy.blockedPaths.length === 0) return
  for (const pattern of policy.blockedPaths) {
    const regex = new RegExp(
      "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
    )
    if (regex.test(path)) {
      throw new Error(`Path "${path}" is blocked by security policy`)
    }
  }
}

/**
 * Create tool implementations for a remote SSH session.
 * These mirror opencode's built-in tools but operate on the remote host.
 */
export async function createRemoteTools(ctx: RemoteToolContext, policy?: SecurityPolicy) {
  const fs = await createRemoteFs(ctx.client)
  let cwd = ctx.cwd

  return {
    /** Remote file read tool */
    readFile: {
      name: "remote_read_file",
      description: "Read a file from the remote server",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path on remote server" },
          offset: { type: "number", description: "Start line (0-based)" },
          limit: { type: "number", description: "Max lines to read" },
        },
        required: ["path"],
      },
      async execute(params: { path: string; offset?: number; limit?: number }) {
        const content = await fs.readFile(params.path, { encoding: "utf-8" })
        const lines = (content as string).split("\n")
        const start = params.offset ?? 0
        const end = params.limit ? start + params.limit : lines.length
        const selected = lines.slice(start, end)
        return selected
          .map((line, i) => `${start + i + 1}\t${line}`)
          .join("\n")
      },
    },

    /** Remote file write tool */
    writeFile: {
      name: "remote_write_file",
      description: "Write content to a file on the remote server",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path on remote server" },
          content: { type: "string", description: "Content to write" },
          mode: { type: "number", description: "File permissions (octal)" },
        },
        required: ["path", "content"],
      },
      async execute(params: { path: string; content: string; mode?: number }) {
        checkReadOnly("writeFile", policy)
        checkBlockedPath(params.path, policy)
        await fs.writeFile(params.path, params.content, { mode: params.mode })
        return `Written ${params.content.length} bytes to ${params.path}`
      },
    },

    /** Remote shell exec tool */
    exec: {
      name: "remote_exec",
      description: "Execute a shell command on the remote server",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Command to execute" },
          cwd: { type: "string", description: "Working directory" },
          timeout: { type: "number", description: "Timeout in ms (default: 30000)" },
          env: { type: "object", description: "Environment variables" },
        },
        required: ["command"],
      },
      async execute(params: {
        command: string
        cwd?: string
        timeout?: number
        env?: Record<string, string>
      }): Promise<ExecResult> {
        validateCommand(params.command, policy)
        const workDir = params.cwd ?? cwd
        return remoteExec(ctx.client, params.command, {
          timeout: params.timeout,
          cwd: workDir,
          env: params.env,
        })
      },
    },

    /** Remote directory listing tool */
    listDir: {
      name: "remote_list_dir",
      description: "List files and directories on the remote server",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path" },
          showHidden: { type: "boolean", description: "Show hidden files" },
        },
        required: ["path"],
      },
      async execute(params: { path: string; showHidden?: boolean }) {
        const entries = await fs.readdir(params.path)
        const filtered = params.showHidden
          ? entries
          : entries.filter((e) => !e.filename.startsWith("."))
        return filtered
          .map((e) => {
            const type = e.attrs.isDirectory ? "d" : e.attrs.isSymbolicLink ? "l" : "-"
            const size = String(e.attrs.size).padStart(10)
            return `${type} ${size} ${e.filename}`
          })
          .join("\n")
      },
    },

    /** Remote file exists check */
    exists: {
      name: "remote_exists",
      description: "Check if a file or directory exists on the remote server",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to check" },
        },
        required: ["path"],
      },
      async execute(params: { path: string }) {
        return fs.exists(params.path)
      },
    },

    /** Remote file stat */
    stat: {
      name: "remote_stat",
      description: "Get file stats from the remote server",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path" },
        },
        required: ["path"],
      },
      async execute(params: { path: string }) {
        return fs.stat(params.path)
      },
    },

    /** Remote grep (execute grep on remote) */
    grep: {
      name: "remote_grep",
      description: "Search for patterns in files on the remote server",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Search pattern (regex)" },
          path: { type: "string", description: "Directory or file to search" },
          glob: { type: "string", description: "File glob pattern" },
          caseInsensitive: { type: "boolean" },
        },
        required: ["pattern", "path"],
      },
      async execute(params: {
        pattern: string
        path: string
        glob?: string
        caseInsensitive?: boolean
      }) {
        validateCommand("grep", policy)
        let cmd = "grep -rn"
        if (params.caseInsensitive) cmd += "i"
        if (params.glob) cmd += ` --include=${JSON.stringify(params.glob)}`
        cmd += ` ${JSON.stringify(params.pattern)} ${JSON.stringify(params.path)}`
        const result = await remoteExec(ctx.client, cmd, { timeout: 15000 })
        return result.stdout || result.stderr || "(no matches)"
      },
    },

    /** Remote find */
    find: {
      name: "remote_find",
      description: "Find files on the remote server",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Start directory" },
          name: { type: "string", description: "Filename pattern" },
          type: { type: "string", enum: ["f", "d", "l"], description: "File type" },
          maxDepth: { type: "number" },
        },
        required: ["path"],
      },
      async execute(params: {
        path: string
        name?: string
        type?: string
        maxDepth?: number
      }) {
        validateCommand("find", policy)
        let cmd = `find ${JSON.stringify(params.path)}`
        if (params.maxDepth) cmd += ` -maxdepth ${params.maxDepth}`
        if (params.type) cmd += ` -type ${params.type}`
        if (params.name) cmd += ` -name ${JSON.stringify(params.name)}`
        const result = await remoteExec(ctx.client, cmd, { timeout: 15000 })
        return result.stdout || result.stderr || "(no results)"
      },
    },

    /** Change remote working directory */
    cd: {
      name: "remote_cd",
      description: "Change the remote working directory",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory to change to" },
        },
        required: ["path"],
      },
      async execute(params: { path: string }) {
        const resolved = await fs.resolvePath(params.path)
        // Verify directory exists
        const stat = await fs.stat(resolved)
        if (!stat.isDirectory) {
          throw new Error(`${resolved} is not a directory`)
        }
        cwd = resolved
        return `Changed directory to ${resolved}`
      },
    },

    /** Dispose / cleanup */
    dispose: () => {
      fs.close()
    },
  }
}

export type RemoteTools = Awaited<ReturnType<typeof createRemoteTools>>
