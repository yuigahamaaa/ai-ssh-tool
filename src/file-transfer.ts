/**
 * File Transfer - upload/download files and folders via SSH
 *
 * Supports:
 * - Single file streaming (large files, no full memory load)
 * - Folder: compress → transfer → decompress (tar + gzip)
 * - Progress callbacks
 * - Multiple files in one batch
 */

import type { Client } from "ssh2"
import { createReadStream, createWriteStream, statSync, lstatSync, existsSync, mkdirSync, writeFileSync, readFileSync, renameSync, unlinkSync } from "fs"
import { basename, dirname, join, posix as pathPosix } from "path"
import { tmpdir } from "os"
import { createHash, randomUUID } from "crypto"
import { Transform, pipeline } from "stream"
import { promisify } from "util"
import iconv from "iconv-lite"
import { remoteExec } from "./remote-shell.js"
import { log } from "./logger.js"
import { shellQuote } from "./shell-quote.js"

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
}

/** Check if a remote path is a directory */
async function remoteIsDir(client: Client, remotePath: string): Promise<boolean> {
  try {
    const result = await remoteExec(client, `test -d ${shellQuote(remotePath)} && echo "DIR" || echo "FILE"`, { timeout: 5000 })
    return result.stdout.trim() === "DIR"
  } catch {
    return false
  }
}

/** Check if a remote path exists */
async function remotePathExists(client: Client, remotePath: string): Promise<boolean> {
  try {
    const result = await remoteExec(client, `test -e ${shellQuote(remotePath)} && echo "YES" || echo "NO"`, { timeout: 5000 })
    return result.stdout.trim() === "YES"
  } catch {
    return false
  }
}

/** Check if a remote path is a symbolic link */
async function remoteIsSymlink(client: Client, remotePath: string): Promise<boolean> {
  try {
    const result = await remoteExec(client, `test -L ${shellQuote(remotePath)} && echo "YES" || echo "NO"`, { timeout: 5000 })
    return result.stdout.trim() === "YES"
  } catch {
    return false
  }
}

/** Convert line endings in text */
function convertLineEndings(content: Buffer, fromEol: string, toEol: string): Buffer<ArrayBufferLike> {
  if (fromEol === toEol || fromEol === "binary" || toEol === "binary") {
    return content
  }
  // 字节级操作，不经过 toString，避免非 utf-8 编码损坏。
  // \r = 0x0d, \n = 0x0a。gbk/latin1 中 0x0d/0x0a 不会出现在多字节序列内部，安全。
  // mixed 来源也走同一路径：任何来源都先归一化成纯 lf，再按目标转换。
  if (toEol === "lf") {
    // \r\n -> \n，孤立 \r（老 Mac CR）-> \n
    const noCrlf = replaceBytes(content, Buffer.from([0x0d, 0x0a]), Buffer.from([0x0a]))
    return replaceBytes(noCrlf, Buffer.from([0x0d]), Buffer.from([0x0a]))
  }
  if (toEol === "crlf") {
    // 先 \r\n -> \n，孤立 \r -> \n，再 \n -> \r\n
    const noCrlf = replaceBytes(content, Buffer.from([0x0d, 0x0a]), Buffer.from([0x0a]))
    const noCr = replaceBytes(noCrlf, Buffer.from([0x0d]), Buffer.from([0x0a]))
    return replaceBytes(noCr, Buffer.from([0x0a]), Buffer.from([0x0d, 0x0a]))
  }
  return content
}

/** 字节级替换 helper：把 content 中所有 from 序列替换为 to 序列 */
function replaceBytes(content: Buffer, from: Buffer, to: Buffer): Buffer {
  if (from.length === 0) return content
  const result: number[] = []
  let i = 0
  while (i < content.length) {
    let match = true
    for (let j = 0; j < from.length; j++) {
      if (content[i + j] !== from[j]) { match = false; break }
    }
    if (match) {
      for (let j = 0; j < to.length; j++) result.push(to[j])
      i += from.length
    } else {
      result.push(content[i])
      i++
    }
  }
  return Buffer.from(result)
}

/** Detect line ending style in text */
function detectLineEnding(content: Buffer): "lf" | "crlf" | "mixed" {
  // 字节级检测，避免 toString 对非 utf-8 编码的损坏。
  // i===0 时（行首 \n）走 else 分支算 lf-only，修了行首 \n 漏检。
  let crlfCount = 0
  let lfOnlyCount = 0
  for (let i = 0; i < content.length; i++) {
    if (content[i] === 0x0a) {
      if (i > 0 && content[i - 1] === 0x0d) crlfCount++
      else lfOnlyCount++
    }
  }
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

/** Transform stream for encoding and line ending conversion (true streaming) */
class FileTransformStream extends Transform {
  private lineEnding?: "auto" | "lf" | "crlf" | "binary"
  private encoding?: "auto" | "utf8" | "gbk" | "latin1"
  private sourceEncoding?: "auto" | "utf8" | "gbk" | "latin1"
  private targetLineEnding?: "lf" | "crlf" | "binary"
  private targetEncoding?: "utf8" | "gbk" | "latin1" | undefined
  private sourceEncodingResolved: "utf8" | "gbk" | "latin1" = "utf8"
  private detectedSourceLineEnding: "lf" | "crlf" | "mixed" | null = null
  private detectionSample: Buffer = Buffer.alloc(0)
  private readonly detectionSampleLimit = 256 * 1024
  private leftover: Buffer = Buffer.alloc(0)
  private needsConversion: boolean

  constructor(options?: {
    lineEnding?: "auto" | "lf" | "crlf" | "binary"
    encoding?: "auto" | "utf8" | "gbk" | "latin1"
    sourceEncoding?: "auto" | "utf8" | "gbk" | "latin1"
  }) {
    super()
    this.lineEnding = options?.lineEnding
    this.encoding = options?.encoding
    this.sourceEncoding = options?.sourceEncoding ?? "auto"
    if (this.lineEnding === "auto") {
      this.targetLineEnding = process.platform === "win32" ? "crlf" : "lf"
    } else {
      this.targetLineEnding = this.lineEnding
    }
    if (this.encoding && this.encoding !== "auto") {
      this.targetEncoding = this.encoding
    }
    if (this.sourceEncoding && this.sourceEncoding !== "auto") {
      this.sourceEncodingResolved = this.sourceEncoding
    }
    const hasTargetEncoding = this.targetEncoding !== undefined && this.targetEncoding !== "utf8"
    const hasTargetLineEnding = this.targetLineEnding !== undefined && this.targetLineEnding !== "binary"
    this.needsConversion = Boolean(hasTargetEncoding || hasTargetLineEnding)
  }

  _transform(chunk: Buffer, encoding: any, callback: any) {
    // If no conversion needed, just pass through (true streaming)
    if (!this.needsConversion) {
      this.push(chunk)
      callback()
      return
    }

    // 累积检测样本（前 256KB），用于更可靠地判定源换行符
    if (this.detectionSample.length < this.detectionSampleLimit) {
      const remaining = this.detectionSampleLimit - this.detectionSample.length
      this.detectionSample = Buffer.concat([this.detectionSample, chunk.slice(0, remaining)])
      // 每次累积后重新检测，crlf 优先于 lf（lf 可能是 crlf 被 chunk 切断的假象）
      const detected = detectLineEnding(this.detectionSample)
      if (detected === "crlf" || detected === "mixed") {
        // 一旦发现 crlf 或 mixed 就锁定，不再被后续 lf-only 干扰
        this.detectedSourceLineEnding = detected
      } else if (!this.detectedSourceLineEnding) {
        this.detectedSourceLineEnding = detected
      }
    }

    // 拼接 leftover + chunk，处理跨 chunk 的 \r\n
    let data = Buffer.concat([this.leftover, chunk])
    this.leftover = Buffer.alloc(0)

    // 缓冲末尾的 \r，避免 \r\n 被切断
    if (this.targetLineEnding && this.targetLineEnding !== "binary" && data.length > 0) {
      if (data[data.length - 1] === 0x0d) {
        this.leftover = Buffer.from([0x0d])
        data = data.slice(0, data.length - 1)
      }
    }

    let output: Buffer<ArrayBufferLike> = data

    // 先做 line ending 转换（字节级，在源编码字节上安全）
    if (this.detectedSourceLineEnding && this.targetLineEnding && this.targetLineEnding !== "binary") {
      output = convertLineEndings(output, this.detectedSourceLineEnding, this.targetLineEnding)
    }

    // 后做 encoding 转换（源编码 -> 目标编码）
    if (this.targetEncoding && this.targetEncoding !== "utf8") {
      output = convertEncoding(output, this.sourceEncodingResolved, this.targetEncoding)
    }

    this.push(output as unknown as Buffer)
    callback()
  }

  _flush(callback: any) {
    // Flush any remaining leftover
    if (this.leftover.length > 0) {
      let output: Buffer<ArrayBufferLike> = this.leftover
      // 先 line ending 后 encoding，与 _transform 保持一致
      if (this.detectedSourceLineEnding && this.targetLineEnding && this.targetLineEnding !== "binary") {
        output = convertLineEndings(output, this.detectedSourceLineEnding, this.targetLineEnding)
      }
      if (this.targetEncoding && this.targetEncoding !== "utf8") {
        output = convertEncoding(output, this.sourceEncodingResolved, this.targetEncoding)
      }
      this.push(output as unknown as Buffer)
    }
    callback()
  }
}

/** Check overwrite strategy and decide action */
async function checkOverwrite(
  client: Client,
  remotePath: string,
  options: FileTransferOptions | undefined
): Promise<OverwriteDecision> {
  const exists = await remotePathExists(client, remotePath)
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
      await remoteExec(client, `mv ${shellQuote(remotePath)} ${shellQuote(backupPath)}`, { timeout: 5000 })
      return { proceed: true, targetPath: remotePath, strategy, existed: true, backupPath }
    
    case "rename":
      let counter = 1
      let newPath: string
      do {
        newPath = `${remotePath}.${counter}`
        counter++
      } while (await remotePathExists(client, newPath))
      log("transfer", `Renaming to avoid overwrite: ${remotePath} -> ${newPath}`)
      return { proceed: true, targetPath: newPath, strategy, existed: true, renamed: true }
    
    case "ask":
    default:
      log("transfer", `File exists, defaulting to overwrite: ${remotePath}`)
      return { proceed: true, targetPath: remotePath, strategy, existed: true }
  }
}

async function resolveRemoteFileTarget(client: Client, localPath: string, remotePath: string): Promise<string> {
  if (remotePath.endsWith("/")) {
    return pathPosix.join(remotePath, basename(localPath))
  }
  if (await remoteIsDir(client, remotePath)) {
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

function checkLocalDirectoryOverwrite(directoryPath: string, options: FolderTransferOptions | undefined): LocalOverwriteDecision {
  return checkLocalOverwrite(directoryPath, options as FileTransferOptions | undefined)
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
  const targetRemotePath = await resolveRemoteFileTarget(client, localPath, remotePath)

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

      try {
        const readStream = createReadStream(localPath)
        let transformStream: Transform | null = null

        if (options?.lineEnding || options?.encoding) {
          transformStream = new FileTransformStream({
            lineEnding: options.lineEnding,
            encoding: options.encoding,
            sourceEncoding: options.sourceEncoding,
          })
        }

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

        if (transformStream) {
          await pipelineAsync(readStream, transformStream, writeStream)
        } else {
          await pipelineAsync(readStream, writeStream)
        }

        const duration = Date.now() - startTime
        log("transfer", `Upload (streaming) complete: ${localPath} -> ${finalRemotePath} (${totalSize} bytes, ${duration}ms)`)
        resolve({
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
          checksum: { algorithm: "sha256", source: await sha256File(localPath) },
          verification: { sizeMatched: transferred === totalSize },
          size: totalSize,
          duration,
        })
      } catch (pipelineErr: any) {
        reject(new Error(`Upload failed for ${localPath}: ${pipelineErr.message}`))
      } finally {
        // Always release the SFTP channel, even on success/error paths.
        // Wrapping in try/catch ensures a faulty end() can't mask the real failure.
        try { sftp.end() } catch { /* best-effort cleanup */ }
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
    let encoding = options.encoding ?? "auto"
    const sourceEncoding = options.sourceEncoding ?? "auto"

    // 先在原始字节上做 lineEnding 转换（字节级实现，对源编码安全）
    if (lineEnding === "auto") {
      lineEnding = process.platform === "win32" ? "crlf" : "lf"
    }
    if (lineEnding !== "binary") {
      data = convertLineEndings(data, detectLineEnding(data), lineEnding)
    }

    // 后做 encoding 转换（源编码 -> 目标编码）
    if (encoding !== "auto") {
      const fromEnc = sourceEncoding === "auto" ? "utf-8" : sourceEncoding
      data = convertEncoding(data, fromEnc, encoding)
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
        try { sftp.end() } catch { /* best-effort cleanup */ }
        fn()
      }

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
          const isSymlink = await remoteIsSymlink(client, remotePath)
          if (isSymlink) {
            log("transfer", `Skipping symbolic link: ${remotePath}`)
              return resolve({
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
              })
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
            let encoding = options.encoding ?? "auto"
            const sourceEncoding = options.sourceEncoding ?? "auto"

            if (lineEnding === "auto") {
              lineEnding = process.platform === "win32" ? "crlf" : "lf"
            }

            // 先做 lineEnding 转换（字节级，对源编码安全）
            if (lineEnding !== "binary") {
              data = convertLineEndings(data, detectLineEnding(data), lineEnding)
            }

            // 后做 encoding 转换（源编码 -> 目标编码）
            if (encoding !== "auto") {
              const fromEnc = sourceEncoding === "auto" ? "utf-8" : sourceEncoding
              data = convertEncoding(data, fromEnc, encoding)
            }
          }

          writeFileSync(targetLocalPath, data as unknown as Buffer, { mode: options?.mode ?? remoteMode })

          const duration = Date.now() - startTime
          log("transfer", `Download (direct) complete: ${remotePath} -> ${targetLocalPath} (${totalSize} bytes, ${duration}ms)`)
          return resolve({
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
          })
        }

        // Streaming download with pipeline for large files
        const readStream = sftp.createReadStream(remotePath)
        let transformStream: Transform | null = null

        if (options?.lineEnding || options?.encoding) {
          transformStream = new FileTransformStream({
            lineEnding: options.lineEnding,
            encoding: options.encoding,
            sourceEncoding: options.sourceEncoding,
          })
        }

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

        if (transformStream) {
          await pipelineAsync(readStream, transformStream, writeStream)
        } else {
          await pipelineAsync(readStream, writeStream)
        }

        const duration = Date.now() - startTime
        log("transfer", `Download (streaming) complete: ${remotePath} -> ${targetLocalPath} (${totalSize} bytes, ${duration}ms)`)
        resolve({
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
          checksum: { algorithm: "sha256", destination: await sha256File(targetLocalPath) },
          verification: { sizeMatched: transferred === totalSize },
          size: totalSize,
          duration,
        })
      } catch (error: any) {
        reject(new Error(`Download failed: ${error.message}`))
      } finally {
        // Always release the SFTP channel, even on success/error paths.
        // Wrapping in try/catch ensures a faulty end() can't mask the real failure.
        try { sftp.end() } catch { /* best-effort cleanup */ }
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
  const level = options?.compressionLevel ?? 6
  const timeout = options?.timeout ?? 5 * 60 * 1000

  if (!existsSync(localPath)) {
    throw new Error(`Local path does not exist: ${localPath}`)
  }

  const folderName = basename(localPath)
  const tmpFile = join(tmpdir(), `ssh-upload-${randomUUID().slice(0, 8)}.tar.gz`)
  const remoteTmp = `/tmp/ssh-upload-${randomUUID().slice(0, 8)}.tar.gz`
  let uploadResult: TransferResult | null = null
  let targetDecision: OverwriteDecision | undefined

  try {
    targetDecision = await checkOverwrite(client, remotePath, options)
    if (!targetDecision.proceed) {
      return {
        success: true,
        path: remotePath,
        finalPath: remotePath,
        requestedPath: remotePath,
        sourcePath: localPath,
        action: "skipped",
        targetType: "directory",
        overwriteStrategy: targetDecision.strategy,
        skipped: true,
        size: 0,
        duration: Date.now() - startTime,
      }
    }
    const finalRemotePath = targetDecision.targetPath

    await remoteExec(client, `mkdir -p ${shellQuote(finalRemotePath)}`, { timeout: 10000 })

    const { execSync } = await import("child_process")
    
    let tarOptions = ""
    if (options?.skipSymlinks) {
      tarOptions = "--no-recursion --ignore-failed-read"
    } else if (options?.followSymlinks) {
      tarOptions = "--dereference"
    }
    
    execSync(
      `tar -czf ${shellQuote(tmpFile)} ${tarOptions} -C ${shellQuote(localPath)} .`,
      { timeout, maxBuffer: 10 * 1024 * 1024 },
    )

    const localStat = statSync(tmpFile)
    const archiveChecksum = await sha256File(tmpFile)
    log("transfer", `Compressed ${localPath} -> ${tmpFile} (${localStat.size} bytes)`)

    uploadResult = await uploadFile(client, tmpFile, remoteTmp, {
      onProgress: options?.onProgress
        ? (p) => options.onProgress!({ ...p, filename: `${folderName}/ (uploading archive)` })
        : undefined,
      timeout,
    })

    const extractCmd = `tar -xzf ${shellQuote(remoteTmp)} -C ${shellQuote(finalRemotePath)} ${options?.overwrite ? "--overwrite" : ""}`
    await remoteExec(client, extractCmd, { timeout })

    const duration = Date.now() - startTime
    log("transfer", `Folder upload complete: ${localPath} -> ${finalRemotePath} (${duration}ms)`)
    return {
      success: true,
      path: finalRemotePath,
      finalPath: finalRemotePath,
      requestedPath: remotePath,
      sourcePath: localPath,
      action: "uploaded",
      targetType: "directory",
      overwriteStrategy: targetDecision.strategy,
      overwritten: targetDecision.existed && !targetDecision.renamed && !targetDecision.backupPath,
      renamed: targetDecision.renamed,
      backupPath: targetDecision.backupPath,
      sourceBytes: localStat.size,
      bytesTransferred: uploadResult.bytesTransferred ?? uploadResult.size,
      checksum: { algorithm: "sha256", source: archiveChecksum },
      verification: { sizeMatched: (uploadResult.bytesTransferred ?? uploadResult.size) === localStat.size },
      size: uploadResult.size,
      duration,
    }
  } catch (err: any) {
    log("transfer", `Folder upload failed: ${err.message}`)
    return {
      success: false,
      path: targetDecision?.targetPath ?? remotePath,
      finalPath: targetDecision?.targetPath ?? remotePath,
      requestedPath: remotePath,
      sourcePath: localPath,
      action: "failed",
      targetType: "directory",
      overwriteStrategy: targetDecision?.strategy ?? options?.overwrite,
      size: uploadResult?.size ?? 0,
      duration: Date.now() - startTime,
      error: err.message,
    }
  } finally {
    // 清理本地临时文件
    try {
      const { unlinkSync } = await import("fs")
      if (existsSync(tmpFile)) unlinkSync(tmpFile)
    } catch {
      // 忽略删除错误
    }
    
    // 清理远程临时文件
    try {
      await remoteExec(client, `rm -f ${shellQuote(remoteTmp)}`, { timeout: 10000 }).catch(() => {})
    } catch {
      // 忽略远程删除错误
    }
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

  const folderName = basename(remotePath)
  const remoteTmp = `/tmp/ssh-download-${randomUUID().slice(0, 8)}.tar.gz`
  const tmpFile = join(tmpdir(), `ssh-download-${randomUUID().slice(0, 8)}.tar.gz`)
  const requestedExtractPath = join(localPath, folderName)
  let finalExtractPath = requestedExtractPath
  let downloadResult: TransferResult | null = null
  let targetDecision: LocalOverwriteDecision | undefined

  try {
    const isDir = await remoteIsDir(client, remotePath)
    if (!isDir) {
      throw new Error(`Remote path is not a directory: ${remotePath}`)
    }

    targetDecision = checkLocalDirectoryOverwrite(requestedExtractPath, options)
    finalExtractPath = targetDecision.targetPath
    if (!targetDecision.proceed) {
      return {
        success: true,
        path: localPath,
        finalPath: finalExtractPath,
        requestedPath: localPath,
        sourcePath: remotePath,
        action: "skipped",
        targetType: "directory",
        overwriteStrategy: targetDecision.strategy,
        skipped: true,
        size: 0,
        duration: Date.now() - startTime,
      }
    }

    const remoteParent = dirname(remotePath)
    
    let tarOptions = ""
    if (options?.skipSymlinks) {
      tarOptions = "--no-recursion --ignore-failed-read"
    } else if (options?.followSymlinks) {
      tarOptions = "--dereference"
    }
    
    const compressCmd = `tar -czf ${shellQuote(remoteTmp)} ${tarOptions} -C ${shellQuote(remoteParent)} ${shellQuote(folderName)}`
    await remoteExec(client, compressCmd, { timeout })

    const sizeResult = await remoteExec(client, `stat -c %s ${shellQuote(remoteTmp)} 2>/dev/null || wc -c < ${shellQuote(remoteTmp)}`, { timeout: 10000 })
    const remoteSize = parseInt(sizeResult.stdout.trim()) || 0
    log("transfer", `Compressed on remote: ${remotePath} -> ${remoteTmp} (${remoteSize} bytes)`)

    downloadResult = await downloadFile(client, remoteTmp, tmpFile, {
      onProgress: options?.onProgress
        ? (p) => options.onProgress!({ ...p, filename: `${folderName}/ (downloading archive)` })
        : undefined,
      timeout,
    })
    const archiveChecksum = await sha256File(tmpFile)

    if (!existsSync(finalExtractPath)) {
      mkdirSync(finalExtractPath, { recursive: true })
    }
    const { execSync } = await import("child_process")
    execSync(
      `tar -xzf ${shellQuote(tmpFile)} -C ${shellQuote(finalExtractPath)} --strip-components=1`,
      { timeout, maxBuffer: 10 * 1024 * 1024 },
    )

    const duration = Date.now() - startTime
    log("transfer", `Folder download complete: ${remotePath} -> ${finalExtractPath} (${duration}ms)`)
    return {
      success: true,
      path: localPath,
      finalPath: finalExtractPath,
      requestedPath: localPath,
      sourcePath: remotePath,
      action: "downloaded",
      targetType: "directory",
      overwriteStrategy: targetDecision.strategy,
      overwritten: targetDecision.existed && !targetDecision.renamed && !targetDecision.backupPath,
      renamed: targetDecision.renamed,
      backupPath: targetDecision.backupPath,
      sourceBytes: remoteSize,
      bytesTransferred: downloadResult.size,
      checksum: { algorithm: "sha256", destination: archiveChecksum },
      verification: { sizeMatched: downloadResult.size === remoteSize },
      size: downloadResult.size,
      duration,
    }
  } catch (err: any) {
    log("transfer", `Folder download failed: ${err.message}`)
    return {
      success: false,
      path: localPath,
      finalPath: finalExtractPath,
      requestedPath: localPath,
      sourcePath: remotePath,
      action: "failed",
      targetType: "directory",
      overwriteStrategy: targetDecision?.strategy ?? options?.overwrite,
      renamed: targetDecision?.renamed,
      backupPath: targetDecision?.backupPath,
      size: downloadResult?.size ?? 0,
      duration: Date.now() - startTime,
      error: err.message,
    }
  } finally {
    // 清理本地临时文件
    try {
      const { unlinkSync } = await import("fs")
      if (existsSync(tmpFile)) unlinkSync(tmpFile)
    } catch {
      // 忽略删除错误
    }
    
    // 清理远程临时文件
    try {
      await remoteExec(client, `rm -f ${shellQuote(remoteTmp)}`, { timeout: 10000 }).catch(() => {})
    } catch {
      // 忽略远程删除错误
    }
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
  const isDir = await remoteIsDir(client, remotePath)
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
