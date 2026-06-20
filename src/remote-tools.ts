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
import { shellQuote } from "./shell-quote.js"
import {
  buildFindCommand,
  buildFindFallbackCommand,
  buildGrepCommand,
  buildGrepFallbackCommand,
  buildListDirFallbackCommand,
  buildListDirCommand,
  buildReadFileContentCommand,
  buildReadFileMetadataCommand,
  buildStatFallbackCommand,
  buildStatCommand,
  DEFAULT_READ_LINE_LIMIT,
  fallbackListDirFromEntries,
  fallbackStatFromRemoteStat,
  formatReadFileResult,
  parseFindOutput,
  parseGrepOutput,
  parseListDirOutput,
  parseReadFileMetadata,
  parseStatOutput,
} from "./remote-file-tools.js"

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
          binary: { type: "boolean", description: "Read as binary (base64 encoded)" },
        },
        required: ["path"],
      },
      async execute(params: { path: string; offset?: number; limit?: number; binary?: boolean }) {
        if (params.binary) {
          const buffer = await fs.readFile(params.path)
          return (buffer as Buffer).toString("base64")
        }
        const metadataResult = await remoteExec(ctx.client, buildReadFileMetadataCommand(params.path), { timeout: 10000 })
        if (metadataResult.code !== 0) {
          throw new Error(`Failed to read metadata for ${params.path}: ${metadataResult.stderr}`)
        }
        const metadata = parseReadFileMetadata(metadataResult.stdout)
        if (metadata.binaryDetected) {
          return formatReadFileResult({ path: params.path, metadata, offset: params.offset, limit: params.limit })
        }
        const contentResult = await remoteExec(
          ctx.client,
          buildReadFileContentCommand(params.path, params.offset ?? 0, params.limit ?? DEFAULT_READ_LINE_LIMIT),
          { timeout: 30000 },
        )
        if (contentResult.code !== 0) {
          throw new Error(`Failed to read ${params.path}: ${contentResult.stderr}`)
        }
        return formatReadFileResult({
          path: params.path,
          metadata,
          rawContent: contentResult.stdout,
          offset: params.offset,
          limit: params.limit,
        })
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
          content: { type: "string", description: "Content to write (text or base64 for binary)" },
          mode: { type: "number", description: "File permissions (octal)" },
          binary: { type: "boolean", description: "Content is base64 encoded binary" },
        },
        required: ["path", "content"],
      },
      async execute(params: { path: string; content: string; mode?: number; binary?: boolean }) {
        checkReadOnly("writeFile", policy)
        checkBlockedPath(params.path, policy)
        let data: string | Buffer = params.content
        if (params.binary) {
          data = Buffer.from(params.content, "base64")
        }
        await fs.writeFile(params.path, data, { mode: params.mode })
        const size = Buffer.isBuffer(data) ? data.length : data.length
        return `Written ${size} bytes to ${params.path}`
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
        const result = await remoteExec(ctx.client, buildListDirCommand(params.path, Boolean(params.showHidden)), { timeout: 15000 })
        if (result.code === 0) {
          return { ...parseListDirOutput(params.path, result.stdout), strategy: "gnu" as const }
        }
        const fallback = await remoteExec(ctx.client, buildListDirFallbackCommand(params.path, Boolean(params.showHidden)), { timeout: 15000 })
        if (fallback.code === 0) {
          return { ...parseListDirOutput(params.path, fallback.stdout), strategy: "shell" as const }
        }
        const entries = await fs.readdir(params.path)
        return fallbackListDirFromEntries(params.path, entries, Boolean(params.showHidden))
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
        const result = await remoteExec(ctx.client, buildStatCommand(params.path), { timeout: 10000 })
        if (result.code === 0) {
          return { ...parseStatOutput(result.stdout), raw: result.stdout, strategy: "gnu" as const }
        }
        const fallback = await remoteExec(ctx.client, buildStatFallbackCommand(params.path), { timeout: 10000 })
        if (fallback.code === 0) {
          return { ...parseStatOutput(fallback.stdout), raw: fallback.stdout, strategy: "shell" as const }
        }
        const stat = await fs.stat(params.path)
        return fallbackStatFromRemoteStat(params.path, stat)
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
        let result = await remoteExec(ctx.client, buildGrepCommand({
          pattern: params.pattern,
          path: params.path,
          glob: params.glob,
          caseInsensitive: Boolean(params.caseInsensitive),
        }), { timeout: 15000 })
        if (result.code > 1) {
          result = await remoteExec(ctx.client, buildGrepFallbackCommand({
            pattern: params.pattern,
            path: params.path,
            glob: params.glob,
            caseInsensitive: Boolean(params.caseInsensitive),
          }), { timeout: 15000 })
        }
        const raw = result.stdout || ""
        if (result.code > 1) {
          throw new Error(result.stderr || raw || "grep failed")
        }
        return {
          pattern: params.pattern,
          path: params.path,
          glob: params.glob,
          caseInsensitive: Boolean(params.caseInsensitive),
          ...parseGrepOutput(raw),
        }
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
        let result = await remoteExec(ctx.client, buildFindCommand({
          path: params.path,
          name: params.name,
          type: params.type as "f" | "d" | "l" | undefined,
          maxDepth: params.maxDepth,
        }), { timeout: 15000 })
        if (result.code !== 0) {
          result = await remoteExec(ctx.client, buildFindFallbackCommand({
            path: params.path,
            name: params.name,
            type: params.type as "f" | "d" | "l" | undefined,
            maxDepth: params.maxDepth,
          }), { timeout: 15000 })
        }
        if (result.code !== 0) {
          throw new Error(result.stderr || "find failed")
        }
        return {
          path: params.path,
          name: params.name,
          type: params.type,
          maxDepth: params.maxDepth,
          ...parseFindOutput(result.stdout),
        }
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
