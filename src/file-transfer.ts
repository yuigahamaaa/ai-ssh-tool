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
import { createReadStream, createWriteStream, statSync, existsSync, mkdirSync, writeFileSync, readFileSync } from "fs"
import { basename, dirname, join } from "path"
import { tmpdir } from "os"
import { randomUUID } from "crypto"
import { Transform, pipeline } from "stream"
import { promisify } from "util"
import iconv from "iconv-lite"
import { remoteExec } from "./remote-shell.js"
import { log } from "./logger.js"

const pipelineAsync = promisify(pipeline)

export interface TransferProgress {
  filename: string
  transferred: number
  total: number
  percent: number
}

export interface TransferResult {
  success: boolean
  path: string
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
}

export type OverwriteStrategy = boolean | "ask" | "skip" | "overwrite" | "rename" | "backup"

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
}

/** Check if a remote path is a directory */
async function remoteIsDir(client: Client, remotePath: string): Promise<boolean> {
  try {
    const result = await remoteExec(client, `test -d ${JSON.stringify(remotePath)} && echo "DIR" || echo "FILE"`, { timeout: 5000 })
    return result.stdout.trim() === "DIR"
  } catch {
    return false
  }
}

/** Check if a remote path exists */
async function remotePathExists(client: Client, remotePath: string): Promise<boolean> {
  try {
    const result = await remoteExec(client, `test -e ${JSON.stringify(remotePath)} && echo "YES" || echo "NO"`, { timeout: 5000 })
    return result.stdout.trim() === "YES"
  } catch {
    return false
  }
}

/** Check if a remote path is a symbolic link */
async function remoteIsSymlink(client: Client, remotePath: string): Promise<boolean> {
  try {
    const result = await remoteExec(client, `test -L ${JSON.stringify(remotePath)} && echo "YES" || echo "NO"`, { timeout: 5000 })
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
  
  const text = content.toString("utf-8")
  let converted: string
  
  if (fromEol === "crlf" && toEol === "lf") {
    converted = text.replace(/\r\n/g, "\n")
  } else if (fromEol === "lf" && toEol === "crlf") {
    converted = text.replace(/\n/g, "\r\n")
  } else {
    converted = text
  }
  
  const result = Buffer.alloc(converted.length * 2); result.write(converted, "utf-8"); return result.slice(0, result.length)
}

/** Detect line ending style in text */
function detectLineEnding(content: Buffer): "lf" | "crlf" | "mixed" {
  const text = content.toString("utf-8")
  const crlfCount = (text.match(/\r\n/g) || []).length
  const lfOnlyCount = (text.match(/[^\r]\n/g) || []).length
  
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
  private targetLineEnding?: "lf" | "crlf" | "binary"
  private targetEncoding?: "utf8" | "gbk" | "latin1" | undefined
  private detectedSourceLineEnding: "lf" | "crlf" | "mixed" | null = null
  private leftover: Buffer = Buffer.alloc(0)
  private needsConversion: boolean

  constructor(options?: {
    lineEnding?: "auto" | "lf" | "crlf" | "binary"
    encoding?: "auto" | "utf8" | "gbk" | "latin1"
  }) {
    super()
    this.lineEnding = options?.lineEnding
    this.encoding = options?.encoding
    
    if (this.lineEnding === "auto") {
      this.targetLineEnding = process.platform === "win32" ? "crlf" : "lf"
    } else {
      this.targetLineEnding = this.lineEnding
    }
    if (this.encoding && this.encoding !== "auto") {
      this.targetEncoding = this.encoding
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
    
    // Add leftover from previous chunk and prepend to current chunk
    let data = Buffer.concat([this.leftover, chunk])
    this.leftover = Buffer.alloc(0)
    
    // Check for a trailing \r (could be start of \r\n across chunk boundary)
    if (this.targetLineEnding && this.targetLineEnding !== "binary" && data.length > 0) {
      if (data[data.length - 1] === 0x0d) {
        this.leftover = Buffer.from([0x0d])
        data = data.slice(0, data.length - 1)
      }
    }
    
    let output: Buffer<ArrayBufferLike> = data
    
    // For line ending conversion, detect source line ending on first chunk
    if (!this.detectedSourceLineEnding && this.targetLineEnding && this.targetLineEnding !== "binary") {
      this.detectedSourceLineEnding = detectLineEnding(data)
    }
    
    // Encoding conversion (if needed)
    if (this.targetEncoding && this.targetEncoding !== "utf8") {
      output = convertEncoding(output, "utf-8", this.targetEncoding)
    }
    
    // Line ending conversion (if needed)
    if (this.detectedSourceLineEnding && this.targetLineEnding && this.targetLineEnding !== "binary") {
      output = convertLineEndings(output, this.detectedSourceLineEnding, this.targetLineEnding)
    }
    
    this.push(output as unknown as Buffer)
    callback()
  }

  _flush(callback: any) {
    // Flush any remaining leftover
    if (this.leftover.length > 0) {
      let output: Buffer<ArrayBufferLike> = this.leftover
      
      // Apply conversions to leftover
      if (this.targetEncoding && this.targetEncoding !== "utf8") {
        output = convertEncoding(output, "utf-8", this.targetEncoding)
      }
      
      if (this.detectedSourceLineEnding && this.targetLineEnding && this.targetLineEnding !== "binary") {
        output = convertLineEndings(output, this.detectedSourceLineEnding, this.targetLineEnding)
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
): Promise<{ proceed: boolean; targetPath: string }> {
  const exists = await remotePathExists(client, remotePath)
  if (!exists) {
    return { proceed: true, targetPath: remotePath }
  }

  const strategy = options?.overwrite ?? "overwrite"
  
  switch (strategy) {
    case true:
    case "overwrite":
      return { proceed: true, targetPath: remotePath }
    
    case false:
    case "skip":
      log("transfer", `Skipping existing file: ${remotePath}`)
      return { proceed: false, targetPath: remotePath }
    
    case "backup":
      const backupPath = `${remotePath}.bak`
      log("transfer", `Backing up existing file: ${remotePath} -> ${backupPath}`)
      await remoteExec(client, `mv ${JSON.stringify(remotePath)} ${JSON.stringify(backupPath)}`, { timeout: 5000 })
      return { proceed: true, targetPath: remotePath }
    
    case "rename":
      let counter = 1
      let newPath: string
      do {
        newPath = `${remotePath}.${counter}`
        counter++
      } while (await remotePathExists(client, newPath))
      log("transfer", `Renaming to avoid overwrite: ${remotePath} -> ${newPath}`)
      return { proceed: true, targetPath: newPath }
    
    case "ask":
    default:
      log("transfer", `File exists, defaulting to overwrite: ${remotePath}`)
      return { proceed: true, targetPath: remotePath }
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

  const statInfo = statSync(localPath)
  const totalSize = statInfo.size

  if (options?.skipSymlinks && statInfo.isSymbolicLink()) {
    log("transfer", `Skipping symbolic link: ${localPath}`)
    return {
      success: true,
      path: remotePath,
      size: 0,
      duration: 0,
    }
  }

  const checkResult = await checkOverwrite(client, remotePath, options)
  if (!checkResult.proceed) {
    return {
      success: true,
      path: remotePath,
      size: 0,
      duration: Date.now() - startTime,
    }
  }
  const finalRemotePath = checkResult.targetPath

  const shouldUseStreaming = totalSize > fileSizeThreshold

  if (!shouldUseStreaming) {
    return uploadFileDirect(client, localPath, finalRemotePath, options, statInfo)
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
): Promise<TransferResult> {
  const startTime = Date.now()
  const totalSize = Number(statInfo.size)

  let data: Buffer<ArrayBufferLike> = readFileSync(localPath)

  if (options?.lineEnding || options?.encoding) {
    let lineEnding = options.lineEnding ?? "auto"
    let encoding = options.encoding ?? "auto"
    
    if (encoding !== "auto") {
      data = convertEncoding(data, "utf-8", encoding)
    }
    
    if (lineEnding === "auto") {
      lineEnding = process.platform === "win32" ? "crlf" : "lf"
    }
    
    if (lineEnding !== "binary") {
      data = convertLineEndings(data, detectLineEnding(data), lineEnding)
    }
  }

  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) {
        reject(new Error(`Failed to open SFTP: ${err.message}`))
        return
      }

      const writeStream = sftp.createWriteStream(remotePath, {
        mode: options?.mode ?? statInfo.mode,
      })

      let settled = false
      const finishOnce = (fn: () => void) => {
        if (settled) return
        settled = true
        try { sftp.end() } catch { /* best-effort cleanup */ }
        fn()
      }

      writeStream.on("error", (streamErr: Error) => {
        finishOnce(() => reject(new Error(`Upload failed for ${localPath}: ${streamErr.message}`)))
      })

      writeStream.on("close", () => {
        const duration = Date.now() - startTime
        log("transfer", `Upload (direct) complete: ${localPath} -> ${remotePath} (${totalSize} bytes, ${duration}ms)`)
        finishOnce(() => resolve({
          success: true,
          path: remotePath,
          size: totalSize,
          duration,
        }))
      })

      writeStream.end(data)
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

  const dir = dirname(localPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  if (existsSync(localPath)) {
    const strategy = options?.overwrite ?? "overwrite"
    switch (strategy) {
      case false:
      case "skip":
        log("transfer", `Skipping existing file: ${localPath}`)
        return {
          success: true,
          path: localPath,
          size: 0,
          duration: Date.now() - startTime,
        }
      case "backup":
        const backupPath = `${localPath}.bak`
        log("transfer", `Backing up existing file: ${localPath} -> ${backupPath}`)
        try {
          if (existsSync(backupPath)) {
            const { unlinkSync } = await import("fs")
            unlinkSync(backupPath)
          }
          const { renameSync } = await import("fs")
          renameSync(localPath, backupPath)
        } catch (e) {
          log("transfer", `Backup failed, skipping: ${(e as Error).message}`)
        }
        break
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
              path: localPath,
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

            if (lineEnding === "auto") {
              lineEnding = process.platform === "win32" ? "crlf" : "lf"
            }

            if (encoding !== "auto") {
              data = convertEncoding(data, "utf-8", encoding)
            }

            if (lineEnding !== "binary") {
              data = convertLineEndings(data, detectLineEnding(data), lineEnding)
            }
          }

          writeFileSync(localPath, data as unknown as Buffer, { mode: options?.mode ?? remoteMode })

          const duration = Date.now() - startTime
          log("transfer", `Download (direct) complete: ${remotePath} -> ${localPath} (${totalSize} bytes, ${duration}ms)`)
          return resolve({
            success: true,
            path: localPath,
            size: totalSize,
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
          })
        }

        const writeStream = createWriteStream(localPath, {
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
        log("transfer", `Download (streaming) complete: ${remotePath} -> ${localPath} (${totalSize} bytes, ${duration}ms)`)
        resolve({
          success: true,
          path: localPath,
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

  try {
    await remoteExec(client, `mkdir -p ${JSON.stringify(remotePath)}`, { timeout: 10000 })

    const { execSync } = await import("child_process")
    const parentDir = dirname(localPath)
    
    let tarOptions = ""
    if (options?.skipSymlinks) {
      tarOptions = "--no-recursion --ignore-failed-read"
    } else if (options?.followSymlinks) {
      tarOptions = "--dereference"
    }
    
    execSync(
      `tar -czf ${JSON.stringify(tmpFile)} ${tarOptions} -C ${JSON.stringify(parentDir)} ${JSON.stringify(folderName)}`,
      { timeout, maxBuffer: 10 * 1024 * 1024 },
    )

    const localStat = statSync(tmpFile)
    log("transfer", `Compressed ${localPath} -> ${tmpFile} (${localStat.size} bytes)`)

    uploadResult = await uploadFile(client, tmpFile, remoteTmp, {
      onProgress: options?.onProgress
        ? (p) => options.onProgress!({ ...p, filename: `${folderName}/ (uploading archive)` })
        : undefined,
      timeout,
    })

    const extractCmd = `tar -xzf ${JSON.stringify(remoteTmp)} -C ${JSON.stringify(remotePath)} ${options?.overwrite ? "--overwrite" : ""}`
    await remoteExec(client, extractCmd, { timeout })

    const duration = Date.now() - startTime
    log("transfer", `Folder upload complete: ${localPath} -> ${remotePath} (${duration}ms)`)
    return {
      success: true,
      path: remotePath,
      size: uploadResult.size,
      duration,
    }
  } catch (err: any) {
    log("transfer", `Folder upload failed: ${err.message}`)
    return {
      success: false,
      path: remotePath,
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
      await remoteExec(client, `rm -f ${JSON.stringify(remoteTmp)}`, { timeout: 10000 }).catch(() => {})
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
  let downloadResult: TransferResult | null = null

  try {
    const isDir = await remoteIsDir(client, remotePath)
    if (!isDir) {
      throw new Error(`Remote path is not a directory: ${remotePath}`)
    }

    const remoteParent = dirname(remotePath)
    
    let tarOptions = ""
    if (options?.skipSymlinks) {
      tarOptions = "--no-recursion --ignore-failed-read"
    } else if (options?.followSymlinks) {
      tarOptions = "--dereference"
    }
    
    const compressCmd = `tar -czf ${JSON.stringify(remoteTmp)} ${tarOptions} -C ${JSON.stringify(remoteParent)} ${JSON.stringify(folderName)}`
    await remoteExec(client, compressCmd, { timeout })

    const sizeResult = await remoteExec(client, `stat -c %s ${JSON.stringify(remoteTmp)} 2>/dev/null || wc -c < ${JSON.stringify(remoteTmp)}`, { timeout: 10000 })
    const remoteSize = parseInt(sizeResult.stdout.trim()) || 0
    log("transfer", `Compressed on remote: ${remotePath} -> ${remoteTmp} (${remoteSize} bytes)`)

    downloadResult = await downloadFile(client, remoteTmp, tmpFile, {
      onProgress: options?.onProgress
        ? (p) => options.onProgress!({ ...p, filename: `${folderName}/ (downloading archive)` })
        : undefined,
      timeout,
    })

    if (!existsSync(localPath)) {
      mkdirSync(localPath, { recursive: true })
    }
    const { execSync } = await import("child_process")
    execSync(
      `tar -xzf ${JSON.stringify(tmpFile)} -C ${JSON.stringify(localPath)}`,
      { timeout, maxBuffer: 10 * 1024 * 1024 },
    )

    const duration = Date.now() - startTime
    log("transfer", `Folder download complete: ${remotePath} -> ${localPath} (${duration}ms)`)
    return {
      success: true,
      path: localPath,
      size: downloadResult.size,
      duration,
    }
  } catch (err: any) {
    log("transfer", `Folder download failed: ${err.message}`)
    return {
      success: false,
      path: localPath,
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
      await remoteExec(client, `rm -f ${JSON.stringify(remoteTmp)}`, { timeout: 10000 }).catch(() => {})
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
