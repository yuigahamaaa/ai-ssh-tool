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
    lineEnding = process.platform === "win32" ? "crlf" : "lf"
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
    const encoding = options.encoding ?? "auto"
    const sourceEncoding = options.sourceEncoding ?? "auto"

    if (lineEnding === "auto") {
      lineEnding = process.platform === "win32" ? "crlf" : "lf"
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
            const encoding = options.encoding ?? "auto"
            const sourceEncoding = options.sourceEncoding ?? "auto"

            if (lineEnding === "auto") {
              lineEnding = process.platform === "win32" ? "crlf" : "lf"
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
