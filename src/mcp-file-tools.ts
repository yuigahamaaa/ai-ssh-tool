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
  formatReadFileResult,
  parseFindOutput,
  parseGrepOutput,
  parseListDirOutput,
  parseReadFileMetadata,
  parseStatOutput,
  type FindCommandParams,
} from "./remote-file-tools.js"
import { mcpEnvelope, mcpErrorEnvelope, type McpEnvelope } from "./mcp-response.js"
import type { Client } from "ssh2"
import type { ExecResult } from "./remote-shell.js"

export type RemoteExecLike = (client: Client, command: string, options?: { timeout?: number }) => Promise<ExecResult>

interface HandlerContext {
  client: Client
  remoteExec: RemoteExecLike
}

export async function handleMcpReadFile(ctx: HandlerContext & {
  path: string
  offset?: number
  limit?: number
}): Promise<McpEnvelope<ReturnType<typeof formatReadFileResult>>> {
  const metadataResult = await ctx.remoteExec(ctx.client, buildReadFileMetadataCommand(ctx.path), { timeout: 10000 })
  if (metadataResult.code !== 0) {
    return mcpErrorEnvelope("file_result", `Error reading file metadata: ${metadataResult.stderr}`)
  }

  const metadata = parseReadFileMetadata(metadataResult.stdout)
  if (metadata.binaryDetected) {
    const data = formatReadFileResult({
      path: ctx.path,
      metadata,
      offset: ctx.offset,
      limit: ctx.limit,
    })
    return mcpEnvelope("file_result", data, data.agentGuidance)
  }

  const contentResult = await ctx.remoteExec(
    ctx.client,
    buildReadFileContentCommand(ctx.path, ctx.offset ?? 0, ctx.limit ?? DEFAULT_READ_LINE_LIMIT),
    { timeout: 30000 },
  )
  if (contentResult.code !== 0) {
    return mcpErrorEnvelope("file_result", `Error reading file: ${contentResult.stderr}`)
  }

  const data = formatReadFileResult({
    path: ctx.path,
    metadata,
    rawContent: contentResult.stdout,
    offset: ctx.offset,
    limit: ctx.limit,
  })
  return mcpEnvelope("file_result", data, data.agentGuidance)
}

export async function handleMcpListDir(ctx: HandlerContext & {
  path: string
  showHidden?: boolean
}): Promise<McpEnvelope<ReturnType<typeof parseListDirOutput>>> {
  const result = await ctx.remoteExec(ctx.client, buildListDirCommand(ctx.path, Boolean(ctx.showHidden)), { timeout: 15000 })
  if (result.code === 0) {
    return mcpEnvelope("file_result", parseListDirOutput(ctx.path, result.stdout))
  }
  const fallback = await ctx.remoteExec(ctx.client, buildListDirFallbackCommand(ctx.path, Boolean(ctx.showHidden)), { timeout: 15000 })
  if (fallback.code !== 0) {
    return mcpErrorEnvelope("file_result", fallback.stderr || result.stderr)
  }
  return mcpEnvelope("file_result", parseListDirOutput(ctx.path, fallback.stdout))
}

export async function handleMcpStat(ctx: HandlerContext & {
  path: string
}): Promise<McpEnvelope<ReturnType<typeof parseStatOutput> & { raw: string }>> {
  const result = await ctx.remoteExec(ctx.client, buildStatCommand(ctx.path), { timeout: 10000 })
  if (result.code === 0) {
    return mcpEnvelope("file_result", { ...parseStatOutput(result.stdout), raw: result.stdout })
  }
  const fallback = await ctx.remoteExec(ctx.client, buildStatFallbackCommand(ctx.path), { timeout: 10000 })
  if (fallback.code !== 0) {
    return mcpErrorEnvelope("file_result", fallback.stderr || result.stderr)
  }
  return mcpEnvelope("file_result", { ...parseStatOutput(fallback.stdout), raw: fallback.stdout })
}

export async function handleMcpGrep(ctx: HandlerContext & {
  pattern: string
  path: string
  glob?: string
  caseInsensitive?: boolean
}): Promise<McpEnvelope<ReturnType<typeof parseGrepOutput> & {
  pattern: string
  path: string
  glob?: string
  caseInsensitive: boolean
}>> {
  let result = await ctx.remoteExec(ctx.client, buildGrepCommand({
    pattern: ctx.pattern,
    path: ctx.path,
    glob: ctx.glob,
    caseInsensitive: Boolean(ctx.caseInsensitive),
  }), { timeout: 15000 })
  if (result.code > 1) {
    result = await ctx.remoteExec(ctx.client, buildGrepFallbackCommand({
      pattern: ctx.pattern,
      path: ctx.path,
      glob: ctx.glob,
      caseInsensitive: Boolean(ctx.caseInsensitive),
    }), { timeout: 15000 })
  }
  const raw = result.stdout || ""
  if (result.code > 1) {
    return mcpErrorEnvelope("file_result", result.stderr || raw)
  }
  return mcpEnvelope("file_result", {
    pattern: ctx.pattern,
    path: ctx.path,
    glob: ctx.glob,
    caseInsensitive: Boolean(ctx.caseInsensitive),
    ...parseGrepOutput(raw),
  })
}

export async function handleMcpFind(ctx: HandlerContext & FindCommandParams): Promise<McpEnvelope<ReturnType<typeof parseFindOutput> & FindCommandParams>> {
  let result = await ctx.remoteExec(ctx.client, buildFindCommand(ctx), { timeout: 15000 })
  if (result.code !== 0) {
    result = await ctx.remoteExec(ctx.client, buildFindFallbackCommand(ctx), { timeout: 15000 })
  }
  if (result.code !== 0) {
    return mcpErrorEnvelope("file_result", result.stderr)
  }
  return mcpEnvelope("file_result", {
    path: ctx.path,
    name: ctx.name,
    type: ctx.type,
    maxDepth: ctx.maxDepth,
    ...parseFindOutput(result.stdout),
  })
}
