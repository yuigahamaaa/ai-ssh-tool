/**
 * File Transfer - upload/download files and folders via SSH
 *
 * Supports:
 * - Single file streaming (large files, no full memory load)
 * - Folder: compress → transfer → decompress (tar + gzip)
 * - Progress callbacks
 * - Multiple files in one batch
 */

import type { Client, SFTPWrapper } from "ssh2"
import { spawn } from "child_process"
import { createReadStream, createWriteStream, statSync, lstatSync, readdirSync, existsSync, mkdirSync, writeFileSync, readFileSync, renameSync, unlinkSync } from "fs"
import { basename, dirname, join, posix as pathPosix } from "path"
import { tmpdir } from "os"
import { createHash, randomUUID } from "crypto"
import { Transform, pipeline } from "stream"
import { promisify } from "util"
import iconv from "iconv-lite"
import { remoteExec } from "./remote-shell.js"
import { log } from "./logger.js"
import { shellQuote } from "./shell-quote.js"
import { getDialect } from "./remote-dialect/index.js"
import { psQuote } from "./remote-dialect/powershell.js"

const pipelineAsync = promisify(pipeline)

export interface TransferProgress {
  filename: string
  transferred: number
  total: number
  percent: number
}

export interface TransferResult {
  success: boolean
  /** Back-compatible final destination path. Prefer finalPath in new callers. */
  path: string
  /** The actual file/folder path that was written, skipped, renamed, or backed up. */
  finalPath?: string
  /** The caller-requested destination before directory basename resolution or rename. */
  requestedPath?: string
  /** Local or remote source path, depending on transfer direction. */
  sourcePath?: string
  /** What happened to the transfer. */
  action?: "uploaded" | "downloaded" | "skipped" | "failed"
  targetType?: "file" | "directory"
  overwriteStrategy?: OverwriteStrategy
  skipped?: boolean
  overwritten?: boolean
  renamed?: boolean
  backupPath?: string
  sourceBytes?: number
  bytesTransferred?: number
  checksum?: {
    algorithm: "sha256"
    source?: string
    destination?: string
  }
  verification?: {
    sizeMatched: boolean
    checksumMatched?: boolean
  }
  size: number
  duration: number
  error?: string
}

export interface FolderTransferOptions {
  onProgress?: (progress: TransferProgress) => void
  /** Compression level 1-9, default 6 */
  compressionLevel?: number
  /** Timeout for the entire operation in ms, default 5 minutes */
  timeout?: number
  /** Overwrite existing files on destination */
  overwrite?: OverwriteStrategy
  /** File size threshold for streaming vs direct read/write (default: 10MB) */
  fileSizeThreshold?: number
  /** Skip symbolic links */
  skipSymlinks?: boolean
  /** Follow symbolic links (resolve target) */
  followSymlinks?: boolean
  /** Line ending for text files: auto|lf|crlf|binary */
  lineEnding?: "auto" | "lf" | "crlf" | "binary"
  /** File encoding for text files: auto|utf8|gbk|latin1 */
  encoding?: "auto" | "utf8" | "gbk" | "latin1"
  /** Source file encoding (download: remote encoding; upload: local encoding). auto=utf-8 */
  sourceEncoding?: "auto" | "utf8" | "gbk" | "latin1"
  /** 远端方言缓存键（user@host:port），用于选择远端 shell 方言与推断换行符。 */
  sessionKey?: string
}

export type OverwriteStrategy = boolean | "ask" | "skip" | "overwrite" | "rename" | "backup"

type OverwriteDecision = {
  proceed: boolean
  targetPath: string
  strategy: OverwriteStrategy
  existed: boolean
  renamed?: boolean
  backupPath?: string
}

type LocalOverwriteDecision = OverwriteDecision & {
  requestedPath: string
}

export interface FileTransferOptions {
  onProgress?: (progress: TransferProgress) => void
  /** File permissions (octal), default: preserve source or 0o644 */
  mode?: number
  /** Timeout in ms, default 2 minutes */
  timeout?: number
  /** Overwrite strategy */
  overwrite?: OverwriteStrategy
  /** File size threshold for streaming vs direct read/write (default: 10MB) */
  fileSizeThreshold?: number
  /** Skip symbolic links */
  skipSymlinks?: boolean
  /** Line ending for text files: auto|lf|crlf|binary */
  lineEnding?: "auto" | "lf" | "crlf" | "binary"
  /** File encoding for text files: auto|utf8|gbk|latin1 */
  encoding?: "auto" | "utf8" | "gbk" | "latin1"
  /** Source file encoding (download: remote encoding; upload: local encoding). auto=utf-8 */
  sourceEncoding?: "auto" | "utf8" | "gbk" | "latin1"
  /** 远端方言缓存键（user@host:port），用于选择远端 shell 方言与推断换行符。 */
  sessionKey?: string
}

/** Check if a remote path is a directory */
async function remoteIsDir(client: Client, remotePath: string, sessionKey?: string): Promise<boolean> {
  const kind = getDialect(sessionKey).kind
  try {
    const command =
      kind === "powershell"
        ? `if (Test-Path -LiteralPath ${psQuote(remotePath)} -PathType Container) { 'DIR' } else { 'FILE' }`
        : kind === "cmd"
          ? `if exist "${remotePath}\\" (echo DIR) else (echo FILE)`
          : `test -d ${shellQuote(remotePath)} && echo "DIR" || echo "FILE"`
    const result = await remoteExec(client, command, { timeout: 5000, splitSemicolons: false, sessionKey })
    return result.stdout.trim() === "DIR"
  } catch {
    return false
  }
}

/** Check if a remote path exists */
async function remotePathExists(client: Client, remotePath: string, sessionKey?: string): Promise<boolean> {
  const kind = getDialect(sessionKey).kind
  try {
    const command =
      kind === "powershell"
        ? `if (Test-Path -LiteralPath ${psQuote(remotePath)}) { 'YES' } else { 'NO' }`
        : kind === "cmd"
          ? `if exist "${remotePath}" (echo YES) else (echo NO)`
          : `test -e ${shellQuote(remotePath)} && echo "YES" || echo "NO"`
    const result = await remoteExec(client, command, { timeout: 5000, splitSemicolons: false, sessionKey })
    return result.stdout.trim() === "YES"
  } catch {
    return false
  }
}

/** Check if a remote path is a symbolic link */
async function remoteIsSymlink(client: Client, remotePath: string, sessionKey?: string): Promise<boolean> {
  const kind = getDialect(sessionKey).kind
  try {
    if (kind === "cmd") return false // cmd 无可靠软链判定
    const command =
      kind === "powershell"
        ? `if ((Get-Item -LiteralPath ${psQuote(remotePath)} -ErrorAction SilentlyContinue).Attributes -band [IO.FileAttributes]::ReparsePoint) { 'YES' } else { 'NO' }`
        : `test -L ${shellQuote(remotePath)} && echo "YES" || echo "NO"`
    const result = await remoteExec(client, command, { timeout: 5000, splitSemicolons: false, sessionKey })
    return result.stdout.trim() === "YES"
  } catch {
    return false
  }
}

/** 在已 decode 的 Unicode 字符串上转换换行符（安全，无编码损坏风险） */
function convertLineEndingsString(text: string, fromEol: string, toEol: string): string {
  if (fromEol === toEol || fromEol === "binary" || toEol === "binary") {
    return text
  }
  // 任何来源都先归一化成纯 \n：\r\n -> \n，孤立 \r（老 Mac CR）-> \n
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  if (toEol === "lf") {
    return normalized
  }
  if (toEol === "crlf") {
    return normalized.replace(/\n/g, "\r\n")
  }
  return text
}

/** 检测文本的换行符风格，用于 direct 路径。接受 string 或 Buffer */
function detectLineEnding(content: Buffer | string): "lf" | "crlf" | "mixed" {
  const text = typeof content === "string" ? content : content.toString("utf-8")
  // (?<!\r)\n 用 lookbehind 统计真正的 lf-only，天然处理行首 \n
  const crlfCount = (text.match(/\r\n/g) || []).length
  const lfOnlyCount = (text.match(/(?<!\r)\n/g) || []).length
  if (crlfCount > 0 && lfOnlyCount > 0) return "mixed"
  if (crlfCount > lfOnlyCount) return "crlf"
  return "lf"
}

/** Convert encoding using iconv-lite */
function convertEncoding(content: Buffer, fromEncoding: string, toEncoding: string): Buffer<ArrayBufferLike> {
  if (fromEncoding === toEncoding) {
    return content
  }
  
  try {
    const decoded = iconv.decode(content, fromEncoding)
    return iconv.encode(decoded, toEncoding)
  } catch {
    return content
  }
}

/** string → string 的换行符转换 Transform，配合 iconv.decodeStream/encodeStream 使用 */
class LineEndingTransform extends Transform {
  private targetLineEnding: "lf" | "crlf" | "binary"
  private detectedSourceLineEnding: "lf" | "crlf" | "mixed" | null = null
  private detectionSample = ""
  private readonly detectionSampleLimit = 256 * 1024
  private leftover = ""
  private readonly needsConversion: boolean

  constructor(targetLineEnding: "lf" | "crlf" | "binary") {
    // iconv.decodeStream 输出 string，Transform 默认会把 string 输入 decode 成 Buffer。
    // 设置 decodeStrings: false 让 string chunk 保持原样传入 _transform。
    super({ objectMode: false, decodeStrings: false })
    this.targetLineEnding = targetLineEnding
    this.needsConversion = targetLineEnding !== "binary"
  }

  _transform(chunk: any, encoding: any, callback: any) {
    // iconv.decodeStream 输出 string chunk
    const str: string = typeof chunk === "string" ? chunk : chunk.toString("utf-8")
    if (!this.needsConversion) {
      this.push(str)
      callback()
      return
    }

    // 累积检测样本（前 256KB），crlf/mixed 一旦发现就锁定
    if (this.detectionSample.length < this.detectionSampleLimit) {
      const remaining = this.detectionSampleLimit - this.detectionSample.length
      this.detectionSample += str.slice(0, remaining)
      const detected = detectLineEnding(this.detectionSample)
      if (detected === "crlf" || detected === "mixed") {
        this.detectedSourceLineEnding = detected
      } else if (!this.detectedSourceLineEnding) {
        this.detectedSourceLineEnding = detected
      }
    }

    // 拼接 leftover + chunk，处理跨 chunk 的 \r\n（\r 在一个 chunk 末尾）
    let data = this.leftover + str
    this.leftover = ""
    if (data.length > 0 && data[data.length - 1] === "\r") {
      this.leftover = "\r"
      data = data.slice(0, -1)
    }

    if (this.detectedSourceLineEnding) {
      data = convertLineEndingsString(data, this.detectedSourceLineEnding, this.targetLineEnding)
    }
    this.push(data)
    callback()
  }

  _flush(callback: any) {
    if (this.leftover.length > 0 && this.detectedSourceLineEnding) {
      const output = convertLineEndingsString(this.leftover, this.detectedSourceLineEnding, this.targetLineEnding)
      this.push(output)
    }
    callback()
  }
}

/**
 * 根据转码选项构建 streaming transform 链。
 * 链路：[iconv.decodeStream(src)] → [LineEndingTransform] → [iconv.encodeStream(dst)]
 * 不需要的阶段跳过。返回 Transform 数组（可能为空，表示 passthrough）。
 */
function buildTransformChain(options?: FileTransferOptions): Transform[] {
  const chain: Transform[] = []
  if (!options?.lineEnding && !options?.encoding) {
    return chain
  }

  let lineEnding = options.lineEnding ?? "auto"
  const encoding = options.encoding ?? "auto"
  const sourceEncoding = options.sourceEncoding ?? "auto"

  if (lineEnding === "auto") {
    // 按远端方言推断换行符：Windows 系远端（PowerShell/cmd）文件为 CRLF
    lineEnding = getDialect(options?.sessionKey).kind !== "posix" ? "crlf" : "lf"
  }

  const srcEnc = sourceEncoding === "auto" ? "utf-8" : sourceEncoding
  const dstEnc = encoding === "auto" ? srcEnc : encoding
  const needEncodingConvert = srcEnc !== dstEnc
  const needLineEnding = lineEnding !== "binary"

  // 编码转换：如果需要把源编码 decode 成 string（用于换行符转换或目标编码不同）
  // 用 iconv.decodeStream。注意：即使只是换行符转换且源=目标=utf-8，我们也
  // 可以不 decode 直接在 Buffer 上做——但为统一走 string 路径，这里在
  // needLineEnding 或 needEncodingConvert 时都 decode。
  const needDecode = needEncodingConvert || needLineEnding
  if (needDecode) {
    // iconv 流的 TS 类型是 NodeJS.ReadWriteStream，运行时是 Transform 子类，需 cast。
    chain.push(iconv.decodeStream(srcEnc as any) as unknown as Transform)
  }
  if (needLineEnding) {
    chain.push(new LineEndingTransform(lineEnding as "lf" | "crlf" | "binary"))
  }
  if (needEncodingConvert) {
    chain.push(iconv.encodeStream(dstEnc as any) as unknown as Transform)
  } else if (needDecode && !needEncodingConvert) {
    // decode 了但不需要编码转换（源=目标），需要 encode 回原编码
    chain.push(iconv.encodeStream(srcEnc as any) as unknown as Transform)
  }
  return chain
}

/** 按远端方言构造移动/重命名命令 */
function remoteMoveCommand(src: string, dst: string, sessionKey?: string): string {
  const kind = getDialect(sessionKey).kind
  if (kind === "powershell") return `Move-Item -LiteralPath ${psQuote(src)} -Destination ${psQuote(dst)}`
  if (kind === "cmd") return `move /Y "${src}" "${dst}"`
  return `mv ${shellQuote(src)} ${shellQuote(dst)}`
}

/** 远端临时目录：仅 posix 需要远端 tar 临时文件；非 posix 走 SFTP 递归不产生 remoteTmp */
function remoteTempDir(sessionKey?: string): string {
  return getDialect(sessionKey).kind === "posix" ? "/tmp" : "."
}

/** Check overwrite strategy and decide action */
async function checkOverwrite(
  client: Client,
  remotePath: string,
  options: FileTransferOptions | undefined
): Promise<OverwriteDecision> {
  const exists = await remotePathExists(client, remotePath, options?.sessionKey)
  if (!exists) {
    return { proceed: true, targetPath: remotePath, strategy: options?.overwrite ?? "overwrite", existed: false }
  }

  const strategy = options?.overwrite ?? "overwrite"
  
  switch (strategy) {
    case true:
    case "overwrite":
      return { proceed: true, targetPath: remotePath, strategy, existed: true }
    
    case false:
    case "skip":
      log("transfer", `Skipping existing file: ${remotePath}`)
      return { proceed: false, targetPath: remotePath, strategy, existed: true }
    
    case "backup":
      const backupPath = `${remotePath}.bak`
      log("transfer", `Backing up existing file: ${remotePath} -> ${backupPath}`)
      await remoteExec(client, remoteMoveCommand(remotePath, backupPath, options?.sessionKey), { timeout: 5000, splitSemicolons: false, sessionKey: options?.sessionKey })
      return { proceed: true, targetPath: remotePath, strategy, existed: true, backupPath }
    
    case "rename":
      let counter = 1
      let newPath: string
      do {
        newPath = `${remotePath}.${counter}`
        counter++
      } while (await remotePathExists(client, newPath, options?.sessionKey))
      log("transfer", `Renaming to avoid overwrite: ${remotePath} -> ${newPath}`)
      return { proceed: true, targetPath: newPath, strategy, existed: true, renamed: true }
    
    case "ask":
    default:
      log("transfer", `File exists, defaulting to overwrite: ${remotePath}`)
      return { proceed: true, targetPath: remotePath, strategy, existed: true }
  }
}

async function resolveRemoteFileTarget(client: Client, localPath: string, remotePath: string, sessionKey?: string): Promise<string> {
  if (remotePath.endsWith("/")) {
    return pathPosix.join(remotePath, basename(localPath))
  }
  if (await remoteIsDir(client, remotePath, sessionKey)) {
    return pathPosix.join(remotePath, basename(localPath))
  }
  return remotePath
}

function resolveLocalFileTarget(remotePath: string, localPath: string): string {
  if (localPath.endsWith("/") || localPath.endsWith("\\")) {
    return join(localPath, basename(remotePath))
  }
  if (existsSync(localPath) && statSync(localPath).isDirectory()) {
    return join(localPath, basename(remotePath))
  }
  return localPath
}

function sha256Buffer(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex")
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256")
  await pipelineAsync(createReadStream(path), hash)
  return hash.digest("hex")
}

/**
 * Reject tar members that would escape the extract directory. Defends
 * against malicious/corrupt archives where a member uses `../`, an
 * absolute path, or normalizes outside the target dir. Pure function so
 * it is unit-testable without spawning tar.
 */
export function assertTarMembersWithin(members: string[], extractDir: string): void {
  const root = pathPosix.resolve(extractDir)
  for (const raw of members) {
    const member = raw.replace(/\r$/, "")
    if (member === "." || member === "") continue
    if (member.startsWith("/") || /^[A-Za-z]:/.test(member)) {
      throw new Error(`Archive member escapes target directory: ${member}`)
    }
    const joined = pathPosix.resolve(root, member)
    if (joined !== root && !joined.startsWith(root + "/")) {
      throw new Error(`Archive member escapes target directory: ${member}`)
    }
  }
}

interface TransferScope {
  localTempFiles: string[]
  remoteTempPaths: string[]
  childProcs: Set<import("child_process").ChildProcess>
  streams: Set<{ destroy: () => void }>
}

function createTransferScope(): TransferScope {
  return { localTempFiles: [], remoteTempPaths: [], childProcs: new Set(), streams: new Set() }
}

function cleanupTransferScope(scope: TransferScope, client: Client): Promise<void> {
  for (const child of scope.childProcs) {
    if (child.exitCode === null) {
      try { child.kill("SIGKILL") } catch { /* best-effort */ }
    }
  }
  scope.childProcs.clear()
  for (const stream of scope.streams) {
    try { stream.destroy() } catch { /* best-effort */ }
  }
  scope.streams.clear()
  for (const file of scope.localTempFiles) {
    try { if (existsSync(file)) unlinkSync(file) } catch { /* best-effort */ }
  }
  scope.localTempFiles = []
  const cleanups: Promise<unknown>[] = []
  for (const remote of scope.remoteTempPaths) {
    cleanups.push(remoteExec(client, `rm -f ${shellQuote(remote)}`, { timeout: 10000, splitSemicolons: false }).catch(() => {}))
  }
  scope.remoteTempPaths = []
  return Promise.allSettled(cleanups).then(() => {})
}

/** Subprocess spawner used for local tar operations. */
let tarSpawn: typeof spawn = spawn

/**
 * Test seam: replace the subprocess spawner used for local tar operations,
 * so tests can observe/hang/kill tar children deterministically. Passing
 * null restores the default `child_process.spawn`.
 */
export function setTarSpawn(spawnFn: typeof spawn | null): void {
  tarSpawn = spawnFn ?? spawn
}

/** Run tar asynchronously; kills the child on timeout. Resolves on exit. */
function runTar(args: string[], opts: { timeout: number; scope: TransferScope }): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = tarSpawn("tar", args, { stdio: ["ignore", "ignore", "pipe"] })
    opts.scope.childProcs.add(child)
    let stderr = ""
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString() })
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let killTimer: ReturnType<typeof setTimeout> | null = null
    const finish = (code: number): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      // Only cancel the SIGKILL backstop once the child has actually exited
      // (close/error path). On the timeout path (code 124) the child may still
      // be alive and needs the 500ms SIGKILL follow-up.
      if (code !== 124 && killTimer) clearTimeout(killTimer)
      opts.scope.childProcs.delete(child)
      resolve({ code, stderr })
    }
    timer = setTimeout(() => {
      try { child.kill("SIGTERM") } catch { /* best-effort */ }
      killTimer = setTimeout(() => { try { child.kill("SIGKILL") } catch { /* best-effort */ } }, 500)
      finish(124)
    }, opts.timeout)
    child.on("error", (err: Error) => {
      // stderr is often empty when the binary is missing; keep the OS error.
      if (!stderr) stderr = err.message
      finish(1)
    })
    child.on("close", (code: number | null) => finish(code ?? 1))
  })
}

/** Run tar and capture stdout lines (for `-tzf` listing). */
function runTarList(args: string[], opts: { timeout: number; scope: TransferScope }): Promise<{ code: number; stderr: string; members: string[] }> {
  return new Promise((resolve) => {
    const child = tarSpawn("tar", args, { stdio: ["ignore", "pipe", "pipe"] })
    opts.scope.childProcs.add(child)
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString() })
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString() })
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let killTimer: ReturnType<typeof setTimeout> | null = null
    const finish = (code: number): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      // Only cancel the SIGKILL backstop once the child has actually exited
      // (close/error path). On the timeout path (code 124) the child may still
      // be alive and needs the 500ms SIGKILL follow-up.
      if (code !== 124 && killTimer) clearTimeout(killTimer)
      opts.scope.childProcs.delete(child)
      resolve({ code, stderr, members: stdout.split("\n").filter((l) => l.trim() !== "") })
    }
    timer = setTimeout(() => {
      try { child.kill("SIGTERM") } catch { /* best-effort */ }
      killTimer = setTimeout(() => { try { child.kill("SIGKILL") } catch { /* best-effort */ } }, 500)
      finish(124)
    }, opts.timeout)
    child.on("error", (err: Error) => {
      // stderr is often empty when the binary is missing; keep the OS error.
      if (!stderr) stderr = err.message
      finish(1)
    })
    child.on("close", (code: number | null) => finish(code ?? 1))
  })
}

function checkLocalOverwrite(localPath: string, options: FileTransferOptions | undefined): LocalOverwriteDecision {
  const strategy = options?.overwrite ?? "overwrite"
  if (!existsSync(localPath)) {
    return { proceed: true, targetPath: localPath, requestedPath: localPath, strategy, existed: false }
  }

  switch (strategy) {
    case false:
    case "skip":
      log("transfer", `Skipping existing file: ${localPath}`)
      return { proceed: false, targetPath: localPath, requestedPath: localPath, strategy, existed: true }

    case "backup": {
      const backupPath = `${localPath}.bak`
      log("transfer", `Backing up existing file: ${localPath} -> ${backupPath}`)
      try {
        if (existsSync(backupPath)) {
          unlinkSync(backupPath)
        }
        renameSync(localPath, backupPath)
      } catch (e) {
        log("transfer", `Backup failed, continuing with overwrite: ${(e as Error).message}`)
      }
      return { proceed: true, targetPath: localPath, requestedPath: localPath, strategy, existed: true, backupPath }
    }

    case "rename": {
      let counter = 1
      let newPath: string
      do {
        newPath = `${localPath}.${counter}`
        counter++
      } while (existsSync(newPath))
      log("transfer", `Renaming local target to avoid overwrite: ${localPath} -> ${newPath}`)
      return { proceed: true, targetPath: newPath, requestedPath: localPath, strategy, existed: true, renamed: true }
    }

    case true:
    case "overwrite":
    case "ask":
    default:
      return { proceed: true, targetPath: localPath, requestedPath: localPath, strategy, existed: true }
  }
}

function validateCompressionLevel(level: number | undefined): number {
  const value = level ?? 6
  if (!Number.isInteger(value) || value < 1 || value > 9) {
    throw new Error(`compressionLevel must be an integer from 1 to 9 (got: ${level})`)
  }
  return value
}

function checkLocalDirectoryOverwrite(directoryPath: string, options: FolderTransferOptions | undefined): LocalOverwriteDecision {
  return checkLocalOverwrite(directoryPath, options as FileTransferOptions | undefined)
}

// --- 非 posix 方言的 SFTP 递归目录传输（替代远端 tar 链） ---

/** 归一化远端路径为 SFTP 友好的正斜杠形式（去尾部斜杠） */
function normalizeRemoteSftpPath(p: string): string {
  const normalized = p.replace(/\\/g, "/").replace(/\/+$/, "")
  return normalized || "/"
}

/** 打开 SFTP 会话 */
function openSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)))
  })
}

/** 递归 mkdir：逐级创建；已存在（stat 为目录）则忽略；盘符段（如 C:）跳过 */
async function sftpMkdirP(sftp: SFTPWrapper, dir: string): Promise<void> {
  const parts = dir.split("/").filter(Boolean)
  let cur = ""
  for (const part of parts) {
    if (/^[A-Za-z]:$/.test(part)) {
      cur = part
      continue
    }
    cur = cur ? `${cur}/${part}` : part
    await new Promise<void>((resolve, reject) => {
      ;(sftp.mkdir as any)(cur, (err: any) => {
        if (!err) return resolve()
        sftp.stat(cur, (statErr: any, st: any) => {
          if (!statErr && typeof st?.isDirectory === "function" && st.isDirectory()) return resolve()
          reject(err)
        })
      })
    })
  }
}

/** SFTP 递归列目录，返回相对路径列表（含子目录） */
async function sftpReadDirRecursive(sftp: SFTPWrapper, dir: string): Promise<string[]> {
  const list = await new Promise<Array<{ filename: string; attrs: { isDirectory(): boolean; isSymbolicLink(): boolean } }>>(
    (resolve, reject) => {
      sftp.readdir(dir, (err, entries) => (err ? reject(err) : resolve(entries as any)))
    },
  )
  const out: string[] = []
  for (const it of list) {
    if (it.attrs.isDirectory()) {
      const sub = await sftpReadDirRecursive(sftp, dir === "/" ? `/${it.filename}` : `${dir}/${it.filename}`)
      out.push(...sub.map((s) => `${it.filename}/${s}`))
    } else {
      out.push(it.filename)
    }
  }
  return out
}

/**
 * SFTP 递归上传（非 posix 方言分支）：本地目录 → 远端目录，逐文件复用 uploadFile
 * （转码/换行符/校验/进度行为与文件级一致）。
 */
async function uploadFolderSftp(
  client: Client,
  localPath: string,
  remotePath: string,
  options?: FolderTransferOptions,
): Promise<TransferResult> {
  const startTime = Date.now()
  const root = normalizeRemoteSftpPath(remotePath)

  const sftp = await openSftp(client)
  try {
    await sftpMkdirP(sftp, root)
  } finally {
    try { sftp.end() } catch { /* best-effort */ }
  }

  // 收集本地文件（相对路径 + 绝对路径 + 字节数），处理 skipSymlinks/followSymlinks
  const entries: Array<{ rel: string; abs: string; size: number }> = []
  const walk = (dir: string, rel: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, ent.name)
      const childRel = rel ? `${rel}/${ent.name}` : ent.name
      if (ent.isSymbolicLink()) {
        if (options?.followSymlinks) {
          const st = statSync(abs)
          if (st.isDirectory()) walk(abs, childRel)
          else entries.push({ rel: childRel, abs, size: st.size })
        }
        // skipSymlinks 或未 follow：跳过
        continue
      }
      if (ent.isDirectory()) walk(abs, childRel)
      else entries.push({ rel: childRel, abs, size: statSync(abs).size })
    }
  }
  walk(localPath, "")

  const total = entries.reduce((sum, e) => sum + e.size, 0)
  for (const e of entries) {
    const remoteTarget = `${root}/${e.rel}`
    const res = await uploadFile(client, e.abs, remoteTarget, {
      onProgress: options?.onProgress ? (p) => options.onProgress!({ ...p, filename: e.rel }) : undefined,
      timeout: options?.timeout,
      overwrite: options?.overwrite,
      fileSizeThreshold: options?.fileSizeThreshold,
      skipSymlinks: options?.skipSymlinks,
      lineEnding: options?.lineEnding,
      encoding: options?.encoding,
      sourceEncoding: options?.sourceEncoding,
      sessionKey: options?.sessionKey,
    })
    if (res.error) throw new Error(`Failed to upload ${e.rel}: ${res.error}`)
  }
  return {
    success: true,
    path: root,
    finalPath: root,
    requestedPath: remotePath,
    sourcePath: localPath,
    action: "uploaded",
    targetType: "directory",
    size: total,
    duration: Date.now() - startTime,
  }
}

/**
 * SFTP 递归下载（非 posix 方言分支）：远端目录 → 本地目录，逐文件复用 downloadFile。
 */
async function downloadFolderSftp(
  client: Client,
  remotePath: string,
  localPath: string,
  options?: FolderTransferOptions,
): Promise<TransferResult> {
  const startTime = Date.now()
  const root = normalizeRemoteSftpPath(remotePath)
  const folderName = basename(root)
  const requestedExtractPath = join(localPath, folderName)
  const targetDecision = checkLocalDirectoryOverwrite(requestedExtractPath, options)
  if (!targetDecision.proceed) {
    return {
      success: true, path: localPath, finalPath: targetDecision.targetPath, requestedPath: localPath,
      sourcePath: remotePath, action: "skipped", targetType: "directory",
      overwriteStrategy: targetDecision.strategy, skipped: true, size: 0,
      duration: Date.now() - startTime,
    }
  }
  const finalExtractPath = targetDecision.targetPath

  const sftp = await openSftp(client)
  let entries: string[]
  try {
    entries = await sftpReadDirRecursive(sftp, root)
  } finally {
    try { sftp.end() } catch { /* best-effort */ }
  }

  for (const rel of entries) {
    const remoteSrc = `${root}/${rel}`
    const localTarget = join(finalExtractPath, ...rel.split("/"))
    mkdirSync(dirname(localTarget), { recursive: true })
    const res = await downloadFile(client, remoteSrc, localTarget, {
      onProgress: options?.onProgress ? (p) => options.onProgress!({ ...p, filename: rel }) : undefined,
      timeout: options?.timeout,
      overwrite: options?.overwrite,
      fileSizeThreshold: options?.fileSizeThreshold,
      skipSymlinks: options?.skipSymlinks,
      lineEnding: options?.lineEnding,
      encoding: options?.encoding,
      sourceEncoding: options?.sourceEncoding,
      sessionKey: options?.sessionKey,
    })
    if (res.error) throw new Error(`Failed to download ${rel}: ${res.error}`)
  }
  return {
    success: true,
    path: finalExtractPath,
    finalPath: finalExtractPath,
    requestedPath: requestedExtractPath,
    sourcePath: remotePath,
    action: "downloaded",
    targetType: "directory",
    size: 0,
    duration: Date.now() - startTime,
  }
}

/**
 * Upload a single file to remote server via SFTP streaming.
 * Uses streaming for large files - never loads entire file into memory.
 * Small files (< threshold) are read directly for better performance.
 */
export async function uploadFile(
  client: Client,
  localPath: string,
  remotePath: string,
  options?: FileTransferOptions,
): Promise<TransferResult> {
  const startTime = Date.now()
  const fileSizeThreshold = options?.fileSizeThreshold ?? 10 * 1024 * 1024

  const linkStat = lstatSync(localPath)

  if (options?.skipSymlinks && linkStat.isSymbolicLink()) {
    log("transfer", `Skipping symbolic link: ${localPath}`)
    return {
      success: true,
      path: remotePath,
      finalPath: remotePath,
      requestedPath: remotePath,
      sourcePath: localPath,
      action: "skipped",
      targetType: "file",
      overwriteStrategy: options?.overwrite,
      skipped: true,
      size: 0,
      duration: 0,
    }
  }

  const statInfo = statSync(localPath)
  const totalSize = statInfo.size
  const targetRemotePath = await resolveRemoteFileTarget(client, localPath, remotePath, options?.sessionKey)

  const checkResult = await checkOverwrite(client, targetRemotePath, options)
  if (!checkResult.proceed) {
    return {
      success: true,
      path: targetRemotePath,
      finalPath: targetRemotePath,
      requestedPath: remotePath,
      sourcePath: localPath,
      action: "skipped",
      targetType: "file",
      overwriteStrategy: checkResult.strategy,
      skipped: true,
      size: 0,
      duration: Date.now() - startTime,
    }
  }
  const finalRemotePath = checkResult.targetPath

  const shouldUseStreaming = totalSize > fileSizeThreshold

  if (!shouldUseStreaming) {
    return uploadFileDirect(client, localPath, finalRemotePath, options, statInfo, {
      ...checkResult,
      requestedPath: remotePath,
    })
  }

  // Use streaming with pipeline for better error handling
  return new Promise((resolve, reject) => {
    client.sftp(async (err, sftp) => {
      if (err) {
        reject(new Error(`Failed to open SFTP: ${err.message}`))
        return
      }

      const timeoutMs = options?.timeout
      let settled = false
      const finishOnce = (fn: () => void): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        fn()
      }
      // Overall transfer deadline. Without it a half-open SFTP session
      // (server stopped responding, channel never closes) would hold the
      // promise + file descriptor + SSH channel forever, even though the
      // FileTransferOptions.timeout contract promises a bounded operation.
      const timer = timeoutMs ? setTimeout(() => {
        finishOnce(() => {
          try { sftp.end() } catch { /* best-effort */ }
          reject(new Error(`Upload timed out after ${timeoutMs}ms: ${localPath}`))
        })
      }, timeoutMs) : null

      try {
        const readStream = createReadStream(localPath)
        const chain = buildTransformChain(options)

        const writeStream = sftp.createWriteStream(finalRemotePath, {
          mode: options?.mode ?? statInfo.mode,
        })

        let transferred = 0

        // Track progress
        readStream.on("data", (chunk: string | Buffer) => {
          transferred += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length
          if (options?.onProgress && totalSize > 0) {
            options.onProgress({
              filename: basename(localPath),
              transferred,
              total: totalSize,
              percent: Math.round((transferred / totalSize) * 100),
            })
          }
        })

        if (chain.length > 0) {
          // promisify(pipeline) 的 TS overload 对 spread 不友好，cast 成 any 调用
          await (pipelineAsync as any)(readStream, ...chain, writeStream)
        } else {
          await pipelineAsync(readStream, writeStream)
        }

        const duration = Date.now() - startTime
        log("transfer", `Upload (streaming) complete: ${localPath} -> ${finalRemotePath} (${totalSize} bytes, ${duration}ms)`)
        const sourceChecksum = await sha256File(localPath)
        finishOnce(() => resolve({
          success: true,
          path: finalRemotePath,
          finalPath: finalRemotePath,
          requestedPath: remotePath,
          sourcePath: localPath,
          action: "uploaded",
          targetType: "file",
          overwriteStrategy: checkResult.strategy,
          overwritten: checkResult.existed && !checkResult.renamed && !checkResult.backupPath,
          renamed: checkResult.renamed,
          backupPath: checkResult.backupPath,
          sourceBytes: totalSize,
          bytesTransferred: transferred,
          checksum: { algorithm: "sha256", source: sourceChecksum },
          verification: { sizeMatched: transferred === totalSize },
          size: totalSize,
          duration,
        }))
      } catch (pipelineErr: any) {
        finishOnce(() => reject(new Error(`Upload failed for ${localPath}: ${pipelineErr.message}`)))
      } finally {
        // Always release the SFTP channel, even on success/error paths.
        // Wrapping in try/catch ensures a faulty end() can't mask the real failure.
        if (!settled) { try { sftp.end() } catch { /* best-effort cleanup */ } }
      }
    })
  })
}

/**
 * Direct file upload for small files (< threshold)
 * Reads entire file into memory for better performance on small files
 */
async function uploadFileDirect(
  client: Client,
  localPath: string,
  remotePath: string,
  options: FileTransferOptions | undefined,
  statInfo: { size: number; mode: number },
  transferMeta?: OverwriteDecision & { requestedPath?: string },
): Promise<TransferResult> {
  const startTime = Date.now()
  const totalSize = Number(statInfo.size)

  let data: Buffer<ArrayBufferLike> = readFileSync(localPath)

  if (options?.lineEnding || options?.encoding) {
    let lineEnding = options.lineEnding ?? "auto"
    const encoding = options.encoding ?? "auto"
    const sourceEncoding = options.sourceEncoding ?? "auto"

    if (lineEnding === "auto") {
      // 按远端方言推断换行符：Windows 系远端（PowerShell/cmd）文件为 CRLF
      lineEnding = getDialect(options.sessionKey).kind !== "posix" ? "crlf" : "lf"
    }

    const srcEnc = sourceEncoding === "auto" ? "utf-8" : sourceEncoding
    const dstEnc = encoding === "auto" ? srcEnc : encoding

    // 先 decode 成 string 做换行符转换（绝对安全），再 encode 成目标编码
    if (lineEnding !== "binary") {
      const text = iconv.decode(data, srcEnc as any)
      const converted = convertLineEndingsString(text, detectLineEnding(text), lineEnding)
      data = iconv.encode(converted, dstEnc as any)
    } else if (srcEnc !== dstEnc) {
      data = convertEncoding(data, srcEnc, dstEnc)
    }
  }

  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) {
        reject(new Error(`Failed to open SFTP: ${err.message}`))
        return
      }

      let settled = false
      const finishOnce = (fn: () => void) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        try { sftp.end() } catch { /* best-effort cleanup */ }
        fn()
      }
      const timeoutMs = options?.timeout
      const timer = timeoutMs ? setTimeout(() => {
        finishOnce(() => reject(new Error(`Upload timed out after ${timeoutMs}ms: ${localPath}`)))
      }, timeoutMs) : null

      try {
        const writeStream = sftp.createWriteStream(remotePath, {
          mode: options?.mode ?? statInfo.mode,
        })

        writeStream.on("error", (streamErr: Error) => {
          finishOnce(() => reject(new Error(`Upload failed for ${localPath}: ${streamErr.message}`)))
        })

        writeStream.on("close", () => {
          const duration = Date.now() - startTime
          if (options?.onProgress && totalSize > 0) {
            options.onProgress({
              filename: basename(localPath),
              transferred: totalSize,
              total: totalSize,
              percent: 100,
            })
          }
          log("transfer", `Upload (direct) complete: ${localPath} -> ${remotePath} (${totalSize} bytes, ${duration}ms)`)
          finishOnce(() => resolve({
            success: true,
            path: remotePath,
            finalPath: remotePath,
            requestedPath: transferMeta?.requestedPath ?? remotePath,
            sourcePath: localPath,
            action: "uploaded",
            targetType: "file",
            overwriteStrategy: transferMeta?.strategy,
            overwritten: transferMeta ? transferMeta.existed && !transferMeta.renamed && !transferMeta.backupPath : undefined,
            renamed: transferMeta?.renamed,
            backupPath: transferMeta?.backupPath,
            sourceBytes: totalSize,
            bytesTransferred: data.length,
            checksum: { algorithm: "sha256", source: sha256Buffer(data as unknown as Buffer) },
            verification: { sizeMatched: !options?.lineEnding && !options?.encoding ? data.length === totalSize : data.length > 0 },
            size: totalSize,
            duration,
          }))
        })

        writeStream.end(data)
      } catch (streamErr: any) {
        finishOnce(() => reject(new Error(`Upload failed for ${localPath}: ${streamErr.message}`)))
      }
    })
  })
}

/**
 * Download a single file from remote server via SFTP streaming.
 * Small files (< threshold) are downloaded directly for better performance.
 */
export async function downloadFile(
  client: Client,
  remotePath: string,
  localPath: string,
  options?: FileTransferOptions,
): Promise<TransferResult> {
  const startTime = Date.now()
  const fileSizeThreshold = options?.fileSizeThreshold ?? 10 * 1024 * 1024
  const requestedLocalPath = resolveLocalFileTarget(remotePath, localPath)
  const localDecision = checkLocalOverwrite(requestedLocalPath, options)
  const targetLocalPath = localDecision.targetPath

  const dir = dirname(targetLocalPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  if (!localDecision.proceed) {
    return {
      success: true,
      path: targetLocalPath,
      finalPath: targetLocalPath,
      requestedPath: localPath,
      sourcePath: remotePath,
      action: "skipped",
      targetType: "file",
      overwriteStrategy: localDecision.strategy,
      skipped: true,
      size: 0,
      duration: Date.now() - startTime,
    }
  }

  return new Promise((resolve, reject) => {
    client.sftp(async (err, sftp) => {
      if (err) {
        reject(new Error(`Failed to open SFTP: ${err.message}`))
        return
      }

      let settled = false
      const finishOnce = (fn: () => void): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        try { sftp.end() } catch { /* best-effort cleanup */ }
        fn()
      }
      const timeoutMs = options?.timeout
      // Overall transfer deadline — mirrors uploadFile. Without it a stuck
      // SFTP channel (server stopped responding) would hold the promise and
      // the SSH channel forever despite the documented timeout contract.
      const timer = timeoutMs ? setTimeout(() => {
        finishOnce(() => reject(new Error(`Download timed out after ${timeoutMs}ms: ${remotePath}`)))
      }, timeoutMs) : null

      try {
        const stats = await new Promise<{ size: number; mode?: number }>((resolve, reject) => {
          sftp.stat(remotePath, (statErr, stats) => {
            if (statErr) {
              reject(new Error(`Failed to stat remote file ${remotePath}: ${statErr.message}`))
            } else {
              resolve(stats as any)
            }
          })
        })

        const totalSize = Number(stats.size)
        const remoteMode = stats.mode ? ((stats.mode as number) & 0o777) : 0o644

        if (options?.skipSymlinks) {
          const isSymlink = await remoteIsSymlink(client, remotePath, options?.sessionKey)
          if (isSymlink) {
            log("transfer", `Skipping symbolic link: ${remotePath}`)
              return finishOnce(() => resolve({
                success: true,
                path: targetLocalPath,
                finalPath: targetLocalPath,
                requestedPath: localPath,
                sourcePath: remotePath,
                action: "skipped",
                targetType: "file",
                overwriteStrategy: options?.overwrite,
                skipped: true,
                size: 0,
                duration: Date.now() - startTime,
              }))
          }
        }

        const shouldUseStreaming = totalSize > fileSizeThreshold

        if (!shouldUseStreaming) {
          // Direct download for small files
          const chunks: Buffer[] = []
          const readStream = sftp.createReadStream(remotePath)

          await new Promise<void>((resolve, reject) => {
            readStream.on("data", (chunk: Buffer) => chunks.push(chunk))
            readStream.on("close", resolve)
            readStream.on("error", reject)
          })

          let data: Buffer<ArrayBufferLike> = Buffer.concat(chunks)

          if (options?.lineEnding || options?.encoding) {
            let lineEnding = options.lineEnding ?? "auto"
            const encoding = options.encoding ?? "auto"
            const sourceEncoding = options.sourceEncoding ?? "auto"

            if (lineEnding === "auto") {
              // 按远端方言推断换行符：Windows 系远端（PowerShell/cmd）文件为 CRLF
              lineEnding = getDialect(options.sessionKey).kind !== "posix" ? "crlf" : "lf"
            }

            const srcEnc = sourceEncoding === "auto" ? "utf-8" : sourceEncoding
            const dstEnc = encoding === "auto" ? srcEnc : encoding

            // 先 decode 成 string 做换行符转换（绝对安全），再 encode 成目标编码
            if (lineEnding !== "binary") {
              const text = iconv.decode(data, srcEnc as any)
              const converted = convertLineEndingsString(text, detectLineEnding(text), lineEnding)
              data = iconv.encode(converted, dstEnc as any)
            } else if (srcEnc !== dstEnc) {
              data = convertEncoding(data, srcEnc, dstEnc)
            }
          }

          writeFileSync(targetLocalPath, data as unknown as Buffer, { mode: options?.mode ?? remoteMode })

          const duration = Date.now() - startTime
          log("transfer", `Download (direct) complete: ${remotePath} -> ${targetLocalPath} (${totalSize} bytes, ${duration}ms)`)
          return finishOnce(() => resolve({
            success: true,
            path: targetLocalPath,
            finalPath: targetLocalPath,
            requestedPath: localPath,
            sourcePath: remotePath,
            action: "downloaded",
            targetType: "file",
            size: totalSize,
            overwriteStrategy: localDecision.strategy,
            overwritten: localDecision.existed && !localDecision.renamed && !localDecision.backupPath,
            renamed: localDecision.renamed,
            backupPath: localDecision.backupPath,
            sourceBytes: totalSize,
            bytesTransferred: data.length,
            checksum: { algorithm: "sha256", destination: sha256Buffer(data as unknown as Buffer) },
            verification: { sizeMatched: !options?.lineEnding && !options?.encoding ? data.length === totalSize : data.length > 0 },
            duration,
          }))
        }

        // Streaming download with pipeline for large files
        const readStream = sftp.createReadStream(remotePath)
        const chain = buildTransformChain(options)

        const writeStream = createWriteStream(targetLocalPath, {
          mode: options?.mode ?? remoteMode,
        })

        let transferred = 0

        // Track progress
        readStream.on("data", (chunk: string | Buffer) => {
          transferred += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length
          if (options?.onProgress && totalSize > 0) {
            options.onProgress({
              filename: basename(remotePath),
              transferred,
              total: totalSize,
              percent: Math.round((transferred / totalSize) * 100),
            })
          }
        })

        if (chain.length > 0) {
          // promisify(pipeline) 的 TS overload 对 spread 不友好，cast 成 any 调用
          await (pipelineAsync as any)(readStream, ...chain, writeStream)
        } else {
          await pipelineAsync(readStream, writeStream)
        }

        const duration = Date.now() - startTime
        log("transfer", `Download (streaming) complete: ${remotePath} -> ${targetLocalPath} (${totalSize} bytes, ${duration}ms)`)
        const destinationChecksum = await sha256File(targetLocalPath)
        finishOnce(() => resolve({
          success: true,
          path: targetLocalPath,
          finalPath: targetLocalPath,
          requestedPath: localPath,
          sourcePath: remotePath,
          action: "downloaded",
          targetType: "file",
          overwriteStrategy: localDecision.strategy,
          overwritten: localDecision.existed && !localDecision.renamed && !localDecision.backupPath,
          renamed: localDecision.renamed,
          backupPath: localDecision.backupPath,
          sourceBytes: totalSize,
          bytesTransferred: transferred,
          checksum: { algorithm: "sha256", destination: destinationChecksum },
          verification: { sizeMatched: transferred === totalSize },
          size: totalSize,
          duration,
        }))
      } catch (error: any) {
        finishOnce(() => reject(new Error(`Download failed: ${error.message}`)))
      } finally {
        // Always release the SFTP channel, even on success/error paths.
        // Wrapping in try/catch ensures a faulty end() can't mask the real failure.
        if (!settled) { try { sftp.end() } catch { /* best-effort cleanup */ } }
      }
    })
  })
}

/**
 * Upload a folder to remote server.
 * Strategy: compress local folder → upload tar.gz → decompress on remote.
 */
export async function uploadFolder(
  client: Client,
  localPath: string,
  remotePath: string,
  options?: FolderTransferOptions,
): Promise<TransferResult> {
  const startTime = Date.now()
  const timeout = options?.timeout ?? 5 * 60 * 1000
  const compressionLevel = validateCompressionLevel(options?.compressionLevel)

  if (!existsSync(localPath)) {
    throw new Error(`Local path does not exist: ${localPath}`)
  }

  // 非 posix 方言：走 SFTP 递归（远端无可靠 tar 链）
  if (getDialect(options?.sessionKey).kind !== "posix") {
    return uploadFolderSftp(client, localPath, remotePath, options)
  }

  const folderName = basename(localPath)
  const tmpFile = join(tmpdir(), `ssh-upload-${randomUUID().slice(0, 8)}.tar.gz`)
  const remoteTmp = `${remoteTempDir(options?.sessionKey)}/ssh-upload-${randomUUID().slice(0, 8)}.tar.gz`
  const scope = createTransferScope()
  scope.localTempFiles.push(tmpFile)
  scope.remoteTempPaths.push(remoteTmp)
  let uploadResult: TransferResult | null = null
  let targetDecision: OverwriteDecision | undefined

  try {
    targetDecision = await checkOverwrite(client, remotePath, options)
    if (!targetDecision.proceed) {
      return {
        success: true, path: remotePath, finalPath: remotePath, requestedPath: remotePath,
        sourcePath: localPath, action: "skipped", targetType: "directory",
        overwriteStrategy: targetDecision.strategy, skipped: true, size: 0,
        duration: Date.now() - startTime,
      }
    }
    const finalRemotePath = targetDecision.targetPath

    const mkdirResult = await remoteExec(client, `mkdir -p ${shellQuote(finalRemotePath)}`, { timeout: 10000, splitSemicolons: false, sessionKey: options?.sessionKey })
    if (mkdirResult.code !== 0) {
      throw new Error(`Failed to create remote directory ${finalRemotePath}: ${mkdirResult.stderr.trim() || `exit code ${mkdirResult.code}`}`)
    }

    let tarOptions: string[] = []
    if (options?.skipSymlinks) tarOptions = ["--no-recursion", "--ignore-failed-read"]
    else if (options?.followSymlinks) tarOptions = ["--dereference"]

    const compress = await runTar(
      ["-I", `gzip -${compressionLevel}`, "-cf", tmpFile, ...tarOptions, "-C", localPath, "."],
      { timeout, scope },
    )
    if (compress.code !== 0) {
      throw new Error(`Failed to compress ${localPath}: ${compress.stderr.trim()}`)
    }

    const localStat = statSync(tmpFile)
    const archiveChecksum = await sha256File(tmpFile)
    log("transfer", `Compressed ${localPath} -> ${tmpFile} (${localStat.size} bytes)`)

    // Validate archive members before shipping to the remote host, so a
    // tar/OS quirk cannot produce a path that escapes on the remote.
    const list = await runTarList(["-tzf", tmpFile], { timeout: 30000, scope })
    if (list.code !== 0) {
      throw new Error(`Failed to inspect archive members: ${list.stderr.trim()}`)
    }
    assertTarMembersWithin(list.members, finalRemotePath)

    uploadResult = await uploadFile(client, tmpFile, remoteTmp, {
      onProgress: options?.onProgress
        ? (p) => options.onProgress!({ ...p, filename: `${folderName}/ (uploading archive)` })
        : undefined,
      timeout,
      sessionKey: options?.sessionKey,
    })

    // GNU tar --overwrite 不可用时（BSD/busybox）降级：清空目标子项后 -xzpf 解压
    let extractCmd = `tar -xzf ${shellQuote(remoteTmp)} -C ${shellQuote(finalRemotePath)} ${options?.overwrite ? "--overwrite" : ""}`
    let extractResult = await remoteExec(client, extractCmd, { timeout, splitSemicolons: false, sessionKey: options?.sessionKey })
    if (extractResult.code !== 0 && options?.overwrite && finalRemotePath && finalRemotePath !== "/") {
      await remoteExec(client, `rm -rf ${shellQuote(pathPosix.join(finalRemotePath, "*"))}`, { timeout: 10000, splitSemicolons: false, sessionKey: options?.sessionKey })
      extractCmd = `tar -xzpf ${shellQuote(remoteTmp)} -C ${shellQuote(finalRemotePath)}`
      extractResult = await remoteExec(client, extractCmd, { timeout, splitSemicolons: false, sessionKey: options?.sessionKey })
    }
    if (extractResult.code !== 0) {
      throw new Error(`Failed to extract ${remoteTmp}: ${extractResult.stderr.trim() || `exit code ${extractResult.code}`}`)
    }

    const duration = Date.now() - startTime
    log("transfer", `Folder upload complete: ${localPath} -> ${finalRemotePath} (${duration}ms)`)
    return {
      success: true, path: finalRemotePath, finalPath: finalRemotePath, requestedPath: remotePath,
      sourcePath: localPath, action: "uploaded", targetType: "directory",
      overwriteStrategy: targetDecision.strategy,
      overwritten: targetDecision.existed && !targetDecision.renamed && !targetDecision.backupPath,
      renamed: targetDecision.renamed, backupPath: targetDecision.backupPath,
      sourceBytes: localStat.size, bytesTransferred: uploadResult.bytesTransferred ?? uploadResult.size,
      checksum: { algorithm: "sha256", source: archiveChecksum },
      verification: { sizeMatched: (uploadResult.bytesTransferred ?? uploadResult.size) === localStat.size },
      size: uploadResult.size, duration,
    }
  } catch (err: any) {
    log("transfer", `Folder upload failed: ${err.message}`)
    return {
      success: false, path: targetDecision?.targetPath ?? remotePath,
      finalPath: targetDecision?.targetPath ?? remotePath, requestedPath: remotePath,
      sourcePath: localPath, action: "failed", targetType: "directory",
      overwriteStrategy: targetDecision?.strategy ?? options?.overwrite,
      size: uploadResult?.size ?? 0, duration: Date.now() - startTime, error: err.message,
    }
  } finally {
    await cleanupTransferScope(scope, client)
  }
}

/**
 * Download a folder from remote server.
 * Strategy: compress on remote → download tar.gz → decompress locally.
 */
export async function downloadFolder(
  client: Client,
  remotePath: string,
  localPath: string,
  options?: FolderTransferOptions,
): Promise<TransferResult> {
  const startTime = Date.now()
  const timeout = options?.timeout ?? 5 * 60 * 1000
  const compressionLevel = validateCompressionLevel(options?.compressionLevel)

  // 非 posix 方言：走 SFTP 递归（远端无可靠 tar 链）
  if (getDialect(options?.sessionKey).kind !== "posix") {
    return downloadFolderSftp(client, remotePath, localPath, options)
  }

  const folderName = basename(remotePath)
  const remoteTmp = `${remoteTempDir(options?.sessionKey)}/ssh-download-${randomUUID().slice(0, 8)}.tar.gz`
  const tmpFile = join(tmpdir(), `ssh-download-${randomUUID().slice(0, 8)}.tar.gz`)
  const scope = createTransferScope()
  scope.localTempFiles.push(tmpFile)
  scope.remoteTempPaths.push(remoteTmp)
  const requestedExtractPath = join(localPath, folderName)
  let finalExtractPath = requestedExtractPath
  let downloadResult: TransferResult | null = null
  let targetDecision: LocalOverwriteDecision | undefined

  try {
    const isDir = await remoteIsDir(client, remotePath, options?.sessionKey)
    if (!isDir) {
      throw new Error(`Remote path is not a directory: ${remotePath}`)
    }

    targetDecision = checkLocalDirectoryOverwrite(requestedExtractPath, options)
    finalExtractPath = targetDecision.targetPath
    if (!targetDecision.proceed) {
      return {
        success: true, path: localPath, finalPath: finalExtractPath, requestedPath: localPath,
        sourcePath: remotePath, action: "skipped", targetType: "directory",
        overwriteStrategy: targetDecision.strategy, skipped: true, size: 0,
        duration: Date.now() - startTime,
      }
    }

    const remoteParent = dirname(remotePath)

    let tarOptions: string[] = []
    if (options?.skipSymlinks) tarOptions = ["--no-recursion", "--ignore-failed-read"]
    else if (options?.followSymlinks) tarOptions = ["--dereference"]

    // GNU tar -I gzip -N 不可用时（BSD/busybox）降级为 -czf（默认压缩级别）
    let compressCmd = `tar -I ${shellQuote(`gzip -${compressionLevel}`)} -cf ${shellQuote(remoteTmp)} ${tarOptions.join(" ")} -C ${shellQuote(remoteParent)} ${shellQuote(folderName)}`
    let compressResult = await remoteExec(client, compressCmd, { timeout, splitSemicolons: false, sessionKey: options?.sessionKey })
    if (compressResult.code !== 0) {
      compressCmd = `tar -czf ${shellQuote(remoteTmp)} ${tarOptions.join(" ")} -C ${shellQuote(remoteParent)} ${shellQuote(folderName)}`
      compressResult = await remoteExec(client, compressCmd, { timeout, splitSemicolons: false, sessionKey: options?.sessionKey })
    }
    if (compressResult.code !== 0) {
      throw new Error(`Failed to compress ${remotePath}: ${compressResult.stderr.trim() || `exit code ${compressResult.code}`}`)
    }

    const sizeResult = await remoteExec(client, `stat -c %s ${shellQuote(remoteTmp)} 2>/dev/null || wc -c < ${shellQuote(remoteTmp)}`, { timeout: 10000, splitSemicolons: false, sessionKey: options?.sessionKey })
    if (sizeResult.code !== 0) {
      throw new Error(`Failed to determine archive size ${remoteTmp}: ${sizeResult.stderr.trim() || `exit code ${sizeResult.code}`}`)
    }
    const remoteSize = parseInt(sizeResult.stdout.trim()) || 0
    if (remoteSize <= 0) {
      throw new Error(`Remote archive is empty: ${remoteTmp}`)
    }
    log("transfer", `Compressed on remote: ${remotePath} -> ${remoteTmp} (${remoteSize} bytes)`)

    downloadResult = await downloadFile(client, remoteTmp, tmpFile, {
      onProgress: options?.onProgress
        ? (p) => options.onProgress!({ ...p, filename: `${folderName}/ (downloading archive)` })
        : undefined,
      timeout,
      sessionKey: options?.sessionKey,
    })
    const archiveChecksum = await sha256File(tmpFile)

    // Validate archive members before extracting locally.
    const list = await runTarList(["-tzf", tmpFile], { timeout: 30000, scope })
    if (list.code !== 0) {
      throw new Error(`Failed to inspect archive members: ${list.stderr.trim()}`)
    }
    assertTarMembersWithin(list.members, finalExtractPath)

    if (!existsSync(finalExtractPath)) {
      mkdirSync(finalExtractPath, { recursive: true })
    }
    const extract = await runTar(
      ["-xzf", tmpFile, "-C", finalExtractPath, "--strip-components=1"],
      { timeout, scope },
    )
    if (extract.code !== 0) {
      throw new Error(`Failed to extract ${tmpFile}: ${extract.stderr.trim()}`)
    }

    const duration = Date.now() - startTime
    log("transfer", `Folder download complete: ${remotePath} -> ${finalExtractPath} (${duration}ms)`)
    return {
      success: true, path: localPath, finalPath: finalExtractPath, requestedPath: localPath,
      sourcePath: remotePath, action: "downloaded", targetType: "directory",
      overwriteStrategy: targetDecision.strategy,
      overwritten: targetDecision.existed && !targetDecision.renamed && !targetDecision.backupPath,
      renamed: targetDecision.renamed, backupPath: targetDecision.backupPath,
      sourceBytes: remoteSize, bytesTransferred: downloadResult.size,
      checksum: { algorithm: "sha256", destination: archiveChecksum },
      verification: { sizeMatched: downloadResult.size === remoteSize },
      size: downloadResult.size, duration,
    }
  } catch (err: any) {
    log("transfer", `Folder download failed: ${err.message}`)
    return {
      success: false, path: localPath, finalPath: finalExtractPath, requestedPath: localPath,
      sourcePath: remotePath, action: "failed", targetType: "directory",
      overwriteStrategy: targetDecision?.strategy ?? options?.overwrite,
      renamed: targetDecision?.renamed, backupPath: targetDecision?.backupPath,
      size: downloadResult?.size ?? 0, duration: Date.now() - startTime, error: err.message,
    }
  } finally {
    await cleanupTransferScope(scope, client)
  }
}

/**
 * Smart upload: automatically detects whether local path is a file or a folder,
 * and dispatches to the right underlying method.
 *
 * - File  → streaming SFTP upload (large files) or direct read/write (small files)
 * - Folder → tar+gzip local → upload archive → untar on remote
 */
export async function upload(
  client: Client,
  localPath: string,
  remotePath: string,
  options?: FolderTransferOptions,
): Promise<TransferResult> {
  if (!existsSync(localPath)) {
    throw new Error(`Local path does not exist: ${localPath}`)
  }
  const statInfo = statSync(localPath)
  if (statInfo.isDirectory()) {
    return uploadFolder(client, localPath, remotePath, options)
  }
  const fileOptions: FileTransferOptions = {
    onProgress: options?.onProgress,
    mode: undefined,
    timeout: options?.timeout,
    overwrite: options?.overwrite,
    fileSizeThreshold: options?.fileSizeThreshold,
    skipSymlinks: options?.skipSymlinks,
    lineEnding: options?.lineEnding,
    encoding: options?.encoding,
    sourceEncoding: options?.sourceEncoding,
    sessionKey: options?.sessionKey,
  }
  return uploadFile(client, localPath, remotePath, fileOptions)
}

/**
 * Smart download: automatically detects whether remote path is a file or a folder,
 * and dispatches to the right underlying method.
 *
 * - File  → streaming SFTP download
 * - Folder → tar+gzip on remote → download archive → untar locally
 */
export async function download(
  client: Client,
  remotePath: string,
  localPath: string,
  options?: FolderTransferOptions,
): Promise<TransferResult> {
  const isDir = await remoteIsDir(client, remotePath, options?.sessionKey)
  if (isDir) {
    return downloadFolder(client, remotePath, localPath, options)
  }
  const fileOptions: FileTransferOptions = {
    onProgress: options?.onProgress,
    mode: undefined,
    timeout: options?.timeout,
    overwrite: options?.overwrite,
    fileSizeThreshold: options?.fileSizeThreshold,
    skipSymlinks: options?.skipSymlinks,
    lineEnding: options?.lineEnding,
    encoding: options?.encoding,
    sourceEncoding: options?.sourceEncoding,
    sessionKey: options?.sessionKey,
  }
  return downloadFile(client, remotePath, localPath, fileOptions)
}

/**
 * Generic smart transfer: automatically detects file vs folder.
 * Provided for back-compat with existing callers that pass an explicit direction.
 */
export async function transfer(
  client: Client,
  source: string,
  destination: string,
  direction: "up" | "down",
  options?: FolderTransferOptions,
): Promise<TransferResult> {
  if (direction === "up") {
    return upload(client, source, destination, options)
  }
  return download(client, source, destination, options)
}
