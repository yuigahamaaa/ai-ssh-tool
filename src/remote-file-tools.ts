import { shellQuote } from "./shell-quote.js"
import type { DirEntry, RemoteFileStat } from "./remote-fs.js"

export type RemoteFileType = "file" | "directory" | "symlink" | "other"

export interface ReadFileMetadata {
  sizeBytes: number
  totalLines: number
  binaryDetected: boolean
  encoding: string
}

export interface ListDirEntry {
  name: string
  path: string
  type: RemoteFileType
  sizeBytes: number
  mode: string
  mtime: number
}

export interface StatResult {
  path: string
  type: RemoteFileType
  sizeBytes: number
  mode: string
  owner: string
  group: string
  mtime: number
}

export interface GrepMatch {
  file: string
  line: number
  text: string
}

export interface FindResult {
  path: string
  type: RemoteFileType
  sizeBytes: number
  mtime: number
}

export interface ReadFileResult extends ReadFileMetadata {
  path: string
  offset: number
  limit: number
  content: string
  raw: string
  contentBytes: number
  maxContentBytes: number
  truncated: boolean
  agentGuidance: string[]
}

export const DEFAULT_READ_LINE_LIMIT = 2000
export const MAX_READ_FILE_BYTES = 1024 * 1024

export function buildReadFileMetadataCommand(path: string): string {
  const q = shellQuote(path)
  return [
    `size_bytes=$(wc -c < ${q} 2>/dev/null || echo 0)`,
    `total_lines=$(wc -l < ${q} 2>/dev/null || echo 0)`,
    `if [ "$size_bytes" = "0" ]; then binary_detected=false; elif LC_ALL=C grep -Iq . ${q} 2>/dev/null; then binary_detected=false; else binary_detected=true; fi`,
    `printf 'size_bytes=%s\\ntotal_lines=%s\\nbinary_detected=%s\\nencoding=utf-8\\n' "$size_bytes" "$total_lines" "$binary_detected"`,
  ].join("; ")
}

export function buildReadFileContentCommand(path: string, offset = 0, limit = DEFAULT_READ_LINE_LIMIT): string {
  const startLine = Math.max(0, Math.floor(offset)) + 1
  const lineLimit = Math.max(1, Math.floor(limit))
  const endLine = startLine + lineLimit - 1
  return `sed -n '${startLine},${endLine}p' ${shellQuote(path)} | head -c ${MAX_READ_FILE_BYTES + 1}`
}

export function parseReadFileMetadata(raw: string): ReadFileMetadata {
  const values = new Map<string, string>()
  for (const line of raw.split(/\r?\n/)) {
    const idx = line.indexOf("=")
    if (idx > 0) values.set(line.slice(0, idx), line.slice(idx + 1))
  }

  return {
    sizeBytes: numberValue(values.get("size_bytes")),
    totalLines: numberValue(values.get("total_lines")),
    binaryDetected: values.get("binary_detected") === "true",
    encoding: values.get("encoding") || "utf-8",
  }
}

export function formatReadFileResult(params: {
  path: string
  metadata: ReadFileMetadata
  rawContent?: string
  offset?: number
  limit?: number
}): ReadFileResult {
  const offset = Math.max(0, Math.floor(params.offset ?? 0))
  const limit = Math.max(1, Math.floor(params.limit ?? DEFAULT_READ_LINE_LIMIT))

  if (params.metadata.binaryDetected) {
    return {
      path: params.path,
      offset,
      limit,
      content: "",
      raw: "",
      contentBytes: 0,
      maxContentBytes: MAX_READ_FILE_BYTES,
      truncated: false,
      ...params.metadata,
      agentGuidance: ["Binary file detected. Use ssh_download for lossless transfer instead of ssh_read_file or manual base64."],
    }
  }

  const rawContent = params.rawContent ?? ""
  const contentBytes = Buffer.byteLength(rawContent)
  const cappedContent = contentBytes > MAX_READ_FILE_BYTES
    ? rawContent.slice(0, MAX_READ_FILE_BYTES)
    : rawContent
  const lines = cappedContent.split("\n")
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  const content = lines.map((line, i) => `${offset + i + 1}\t${line}`).join("\n")
  const truncated = offset + lines.length < params.metadata.totalLines
    || contentBytes > MAX_READ_FILE_BYTES
    || params.metadata.sizeBytes > MAX_READ_FILE_BYTES

  return {
    path: params.path,
    offset,
    limit,
    content,
    raw: content,
    contentBytes: Math.min(contentBytes, MAX_READ_FILE_BYTES),
    maxContentBytes: MAX_READ_FILE_BYTES,
    truncated,
    ...params.metadata,
    agentGuidance: truncated
      ? ["Read result is partial. Increase offset/limit for another slice, or use ssh_download for the full file."]
      : [],
  }
}

export function buildListDirCommand(path: string, showHidden = false): string {
  const hiddenFilter = showHidden ? "" : " ! -name '.*'"
  return `find ${shellQuote(path)} -maxdepth 1 -mindepth 1${hiddenFilter} -printf '%f\\t%y\\t%s\\t%m\\t%T@\\t%p\\n'`
}

export function buildListDirFallbackCommand(path: string, showHidden = false): string {
  const q = shellQuote(path)
  const hiddenFilter = showHidden
    ? ""
    : `case "$name" in .*) continue ;; esac; `
  return `sh -c 'base=$1; shift; for item do [ "$item" = "$base/*" ] && continue; name=$(basename "$item"); ${hiddenFilter}out=$(ls -ldn "$item" 2>/dev/null) || continue; set -- $out; mode=$1; size=$5; type=o; case "$mode" in d*) type=d ;; l*) type=l ;; -*) type=f ;; esac; printf "%s\\t%s\\t%s\\t%s\\t0\\t%s\\n" "$name" "$type" "$size" "$mode" "$item"; done' sh ${q} ${q}/*`
}

export function parseListDirOutput(basePath: string, raw: string): { path: string; entries: ListDirEntry[]; raw: string } {
  const entries = raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => {
      const [name, type, size, mode, mtime, ...pathParts] = line.split("\t")
      return {
        name,
        path: pathParts.join("\t"),
        type: mapFindType(type),
        sizeBytes: numberValue(size),
        mode: normalizeMode(mode),
        mtime: numberValue(mtime),
      }
    })

  return { path: basePath, entries, raw }
}

export function fallbackListDirFromEntries(basePath: string, entries: DirEntry[], showHidden = false): { path: string; entries: ListDirEntry[]; raw: string; strategy: "sftp" } {
  const list = entries
    .filter(entry => showHidden || !entry.filename.startsWith("."))
    .map(entry => {
      const childPath = basePath.endsWith("/")
        ? `${basePath}${entry.filename}`
        : `${basePath}/${entry.filename}`
      return {
        name: entry.filename,
        path: childPath,
        type: remoteStatType(entry.attrs),
        sizeBytes: entry.attrs.size,
        mode: modeString(entry.attrs.mode),
        mtime: normalizeMtime(entry.attrs.mtime),
      }
    })
  const raw = list.map(entry => `${entry.name}\t${shortType(entry.type)}\t${entry.sizeBytes}\t${entry.mode}\t${entry.mtime}\t${entry.path}`).join("\n")
  return { path: basePath, entries: list, raw, strategy: "sftp" }
}

export function buildStatCommand(path: string): string {
  return `stat -c '%F\\t%s\\t%a\\t%U\\t%G\\t%Y\\t%n' ${shellQuote(path)}`
}

export function buildStatFallbackCommand(path: string): string {
  return `sh -c 'out=$(ls -ldn "$1" 2>/dev/null) || exit 1; set -- $out; mode=$1; size=$5; type=other; case "$mode" in d*) type=directory ;; l*) type=symlink ;; -*) type=file ;; esac; printf "%s\\t%s\\t%s\\t%s\\t%s\\t0\\t%s\\n" "$type" "$size" "$mode" "$3" "$4" "$1"' sh ${shellQuote(path)}`
}

export function parseStatOutput(raw: string): StatResult {
  const [fileType, size, mode, owner, group, mtime, ...pathParts] = raw.trimEnd().split("\t")
  return {
    path: pathParts.join("\t"),
    type: mapStatType(fileType),
    sizeBytes: numberValue(size),
    mode: normalizeMode(mode),
    owner,
    group,
    mtime: numberValue(mtime),
  }
}

export function fallbackStatFromRemoteStat(path: string, stat: RemoteFileStat): StatResult & { strategy: "sftp" } {
  return {
    path,
    type: remoteStatType(stat),
    sizeBytes: stat.size,
    mode: modeString(stat.mode),
    owner: String(stat.uid),
    group: String(stat.gid),
    mtime: normalizeMtime(stat.mtime),
    strategy: "sftp",
  }
}

export interface GrepCommandParams {
  pattern: string
  path: string
  glob?: string
  caseInsensitive?: boolean
}

export function buildGrepCommand(params: GrepCommandParams): string {
  let cmd = "grep -RInIZ"
  if (params.caseInsensitive) cmd += "i"
  if (params.glob) cmd += ` --include=${shellQuote(params.glob)}`
  return `${cmd} ${shellQuote(params.pattern)} ${shellQuote(params.path)}`
}

export function buildGrepFallbackCommand(params: GrepCommandParams): string {
  let cmd = "grep -RInI"
  if (params.caseInsensitive) cmd += "i"
  if (params.glob) cmd += ` --include=${shellQuote(params.glob)}`
  return `${cmd} ${shellQuote(params.pattern)} ${shellQuote(params.path)}`
}

export function parseGrepOutput(raw: string): { matches: GrepMatch[]; count: number; noMatches: boolean; raw: string } {
  const matches: GrepMatch[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue
    const parsed = parseGrepLine(line)
    if (parsed) matches.push(parsed)
  }
  return { matches, count: matches.length, noMatches: matches.length === 0, raw }
}

export interface FindCommandParams {
  path: string
  name?: string
  type?: "f" | "d" | "l"
  maxDepth?: number
}

export function buildFindCommand(params: FindCommandParams): string {
  let cmd = `find ${shellQuote(params.path)}`
  if (params.maxDepth !== undefined) cmd += ` -maxdepth ${Math.max(0, Math.floor(params.maxDepth))}`
  if (params.type) cmd += ` -type ${params.type}`
  if (params.name) cmd += ` -name ${shellQuote(params.name)}`
  return `${cmd} -printf '%p\\t%y\\t%s\\t%T@\\n'`
}

export function buildFindFallbackCommand(params: FindCommandParams): string {
  let cmd = `find ${shellQuote(params.path)}`
  if (params.maxDepth !== undefined) cmd += ` -maxdepth ${Math.max(0, Math.floor(params.maxDepth))}`
  if (params.type) cmd += ` -type ${params.type}`
  if (params.name) cmd += ` -name ${shellQuote(params.name)}`
  return `${cmd} -exec sh -c 'for item do out=$(ls -ldn "$item" 2>/dev/null) || continue; set -- $out; mode=$1; size=$5; type=o; case "$mode" in d*) type=d ;; l*) type=l ;; -*) type=f ;; esac; printf "%s\\t%s\\t%s\\t0\\n" "$item" "$type" "$size"; done' sh {} +`
}

export function parseFindOutput(raw: string): { results: FindResult[]; count: number; noResults: boolean; raw: string } {
  const results = raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => {
      const [path, type, size, mtime] = line.split("\t")
      return {
        path,
        type: mapFindType(type),
        sizeBytes: numberValue(size),
        mtime: numberValue(mtime),
      }
    })

  return { results, count: results.length, noResults: results.length === 0, raw }
}

function parseGrepLine(line: string): GrepMatch | undefined {
  const nulIndex = line.indexOf("\0")
  if (nulIndex >= 0) {
    const file = line.slice(0, nulIndex)
    const rest = line.slice(nulIndex + 1)
    const colonIndex = rest.indexOf(":")
    if (colonIndex <= 0) return undefined
    return {
      file,
      line: Number.parseInt(rest.slice(0, colonIndex), 10),
      text: rest.slice(colonIndex + 1),
    }
  }

  const lineMatch = line.match(/^(.*):([0-9]+):(.*)$/)
  if (!lineMatch) return undefined
  return {
    file: lineMatch[1],
    line: Number.parseInt(lineMatch[2], 10),
    text: lineMatch[3],
  }
}

function mapFindType(type: string): RemoteFileType {
  if (type === "f") return "file"
  if (type === "d") return "directory"
  if (type === "l") return "symlink"
  return "other"
}

function mapStatType(type: string): RemoteFileType {
  if (type.includes("directory")) return "directory"
  if (type.includes("symbolic link")) return "symlink"
  if (type.includes("regular file") || type === "file") return "file"
  return "other"
}

function remoteStatType(stat: RemoteFileStat): RemoteFileType {
  if (stat.isDirectory) return "directory"
  if (stat.isSymbolicLink) return "symlink"
  if (stat.isFile) return "file"
  return "other"
}

function shortType(type: RemoteFileType): string {
  if (type === "file") return "f"
  if (type === "directory") return "d"
  if (type === "symlink") return "l"
  return "o"
}

function modeString(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, "0")
}

function normalizeMode(mode: string): string {
  if (/^[0-7]{3,4}$/.test(mode)) return mode
  if (/^[dl-][rwx-]{9}/.test(mode)) return symbolicModeToOctal(mode)
  return mode
}

function symbolicModeToOctal(mode: string): string {
  const bits = mode.slice(1, 10)
  const digits = [bits.slice(0, 3), bits.slice(3, 6), bits.slice(6, 9)].map(part => {
    let value = 0
    if (part[0] === "r") value += 4
    if (part[1] === "w") value += 2
    if (part[2] === "x" || part[2] === "s" || part[2] === "t") value += 1
    return String(value)
  })
  return digits.join("")
}

function normalizeMtime(mtime: number): number {
  return mtime > 10_000_000_000 ? Math.floor(mtime / 1000) : mtime
}

function numberValue(value: string | undefined): number {
  if (!value) return 0
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}
