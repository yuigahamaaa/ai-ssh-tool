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
import { createReadStream, createWriteStream, statSync, existsSync, mkdirSync } from "fs"
import { basename, dirname, join, resolve as pathResolve } from "path"
import { tmpdir } from "os"
import { randomUUID } from "crypto"
import { remoteExec } from "./remote-shell.js"
import { log } from "./logger.js"

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
function convertLineEndings(content: Buffer, fromEol: string, toEol: string): Buffer {
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
  
  return Buffer.from(converted, "utf-8")
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

/** Convert encoding */
function convertEncoding(content: Buffer, fromEncoding: BufferEncoding, toEncoding: string): Buffer {
  if (fromEncoding === toEncoding as BufferEncoding) {
    return content
  }
  
  const text = content.toString(fromEncoding)
  return Buffer.from(text, toEncoding as BufferEncoding)
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

  const shouldUseStreaming = totalSize > fileSizeThreshold

  if (!shouldUseStreaming) {
    return uploadFileDirect(client, localPath, remotePath, options, statInfo)
  }

  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) {
        reject(new Error(`Failed to open SFTP: ${err.message}`))
        return
      }

      const readStream = createReadStream(localPath)
      const writeStream = sftp.createWriteStream(remotePath, {
        mode: options?.mode ?? statInfo.mode,
      })

      let transferred = 0

      writeStream.on("error", (streamErr: Error) => {
        readStream.destroy()
        reject(new Error(`Upload failed for ${localPath}: ${streamErr.message}`))
      })

      writeStream.on("close", () => {
        sftp.end()
        const duration = Date.now() - startTime
        log("transfer", `Upload (streaming) complete: ${localPath} -> ${remotePath} (${totalSize} bytes, ${duration}ms)`)
        resolve({
          success: true,
          path: remotePath,
          size: totalSize,
          duration,
        })
      })

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

      readStream.on("error", (streamErr: Error) => {
        writeStream.destroy()
        reject(new Error(`Failed to read local file ${localPath}: ${streamErr.message}`))
      })

      readStream.pipe(writeStream)
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

  const fs = await import("fs")
  let data = fs.readFileSync(localPath)

  if (options?.lineEnding || options?.encoding) {
    let lineEnding = options.lineEnding ?? "auto"
    let encoding = options.encoding ?? "auto"
    
    if (encoding !== "binary" && encoding !== "auto") {
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

      writeStream.on("error", (streamErr: Error) => {
        sftp.end()
        reject(new Error(`Upload failed for ${localPath}: ${streamErr.message}`))
      })

      writeStream.on("close", () => {
        sftp.end()
        const duration = Date.now() - startTime
        log("transfer", `Upload (direct) complete: ${localPath} -> ${remotePath} (${totalSize} bytes, ${duration}ms)`)
        resolve({
          success: true,
          path: remotePath,
          size: totalSize,
          duration,
        })
      })

      writeStream.end(data)
    })
  })
}

/**
 * Download a single file from remote server via SFTP streaming.
 * Small files (< threshold) are downloaded directly for better performance.
 */
export function downloadFile(
  client: Client,
  remotePath: string,
  localPath: string,
  options?: FileTransferOptions,
): Promise<TransferResult> {
  const startTime = Date.now()
  const fileSizeThreshold = options?.fileSizeThreshold ?? 10 * 1024 * 1024

  return new Promise((resolve, reject) => {
    const dir = dirname(localPath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    client.sftp((err, sftp) => {
      if (err) {
        reject(new Error(`Failed to open SFTP: ${err.message}`))
        return
      }

      sftp.stat(remotePath, (statErr, stats) => {
        if (statErr) {
          sftp.end()
          reject(new Error(`Failed to stat remote file ${remotePath}: ${statErr.message}`))
          return
        }

        const totalSize = Number(stats.size)
        
        if (options?.skipSymlinks) {
          const isSymlink = await remoteIsSymlink(client, remotePath)
          if (isSymlink) {
            log("transfer", `Skipping symbolic link: ${remotePath}`)
            sftp.end()
            return resolve({
              success: true,
              path: localPath,
              size: 0,
              duration: 0,
            })
          }
        }
        
        const shouldUseStreaming = totalSize > fileSizeThreshold

        if (!shouldUseStreaming) {
          return new Promise((resolve, reject) => {
            const readStream = sftp.createReadStream(remotePath)
            const chunks: Buffer[] = []

            readStream.on("data", (chunk: Buffer) => chunks.push(chunk))

            readStream.on("close", () => {
              sftp.end()
              const data = Buffer.concat(chunks)
              const fs = require("fs")
              fs.writeFileSync(localPath, data)
              const duration = Date.now() - startTime
              log("transfer", `Download (direct) complete: ${remotePath} -> ${localPath} (${totalSize} bytes, ${duration}ms)`)
              resolve({
                success: true,
                path: localPath,
                size: totalSize,
                duration,
              })
            })

            readStream.on("error", (err: Error) => {
              sftp.end()
              reject(new Error(`Failed to read remote file ${remotePath}: ${err.message}`))
            })
          })
        }

        let transferred = 0

        const readStream = sftp.createReadStream(remotePath)
        const writeStream = createWriteStream(localPath, {
          mode: options?.mode,
        })

        writeStream.on("error", (streamErr: Error) => {
          readStream.destroy()
          sftp.end()
          reject(new Error(`Download write failed for ${localPath}: ${streamErr.message}`))
        })

        writeStream.on("close", () => {
          sftp.end()
          const duration = Date.now() - startTime
          log("transfer", `Download (streaming) complete: ${remotePath} -> ${localPath} (${totalSize} bytes, ${duration}ms)`)
          resolve({
            success: true,
            path: localPath,
            size: totalSize,
            duration,
          })
        })

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

        readStream.on("error", (streamErr: Error) => {
          writeStream.destroy()
          sftp.end()
          reject(new Error(`Download read failed for ${remotePath}: ${streamErr.message}`))
        })

        readStream.pipe(writeStream)
      })
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

  try {
    // Step 1: Create remote parent directory
    await remoteExec(client, `mkdir -p ${JSON.stringify(remotePath)}`, { timeout: 10000 })

    // Step 2: Compress local folder using child_process (spawn for streaming)
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

    // Step 3: Upload compressed archive via streaming
    const uploadResult = await uploadFile(client, tmpFile, remoteTmp, {
      onProgress: options?.onProgress
        ? (p) => options.onProgress!({ ...p, filename: `${folderName}/ (uploading archive)` })
        : undefined,
      timeout,
    })

    // Step 4: Extract on remote
    const extractCmd = `tar -xzf ${JSON.stringify(remoteTmp)} -C ${JSON.stringify(remotePath)} ${options?.overwrite ? "--overwrite" : ""} && rm -f ${JSON.stringify(remoteTmp)}`
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
    return {
      success: false,
      path: remotePath,
      size: 0,
      duration: Date.now() - startTime,
      error: err.message,
    }
  } finally {
    // Cleanup local temp file
    try {
      const { unlinkSync } = await import("fs")
      if (existsSync(tmpFile)) unlinkSync(tmpFile)
    } catch {
      // ignore
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

  try {
    // Step 1: Verify remote path exists and is a directory
    const isDir = await remoteIsDir(client, remotePath)
    if (!isDir) {
      throw new Error(`Remote path is not a directory: ${remotePath}`)
    }

    // Step 2: Compress on remote
    const remoteParent = dirname(remotePath)
    
    let tarOptions = ""
    if (options?.skipSymlinks) {
      tarOptions = "--no-recursion --ignore-failed-read"
    } else if (options?.followSymlinks) {
      tarOptions = "--dereference"
    }
    
    const compressCmd = `tar -czf ${JSON.stringify(remoteTmp)} ${tarOptions} -C ${JSON.stringify(remoteParent)} ${JSON.stringify(folderName)}`
    await remoteExec(client, compressCmd, { timeout })

    // Get remote archive size
    const sizeResult = await remoteExec(client, `stat -c %s ${JSON.stringify(remoteTmp)} 2>/dev/null || wc -c < ${JSON.stringify(remoteTmp)}`, { timeout: 10000 })
    const remoteSize = parseInt(sizeResult.stdout.trim()) || 0
    log("transfer", `Compressed on remote: ${remotePath} -> ${remoteTmp} (${remoteSize} bytes)`)

    // Step 3: Download compressed archive via streaming
    const downloadResult = await downloadFile(client, remoteTmp, tmpFile, {
      onProgress: options?.onProgress
        ? (p) => options.onProgress!({ ...p, filename: `${folderName}/ (downloading archive)` })
        : undefined,
      timeout,
    })

    // Step 4: Extract locally
    if (!existsSync(localPath)) {
      mkdirSync(localPath, { recursive: true })
    }
    const { execSync } = await import("child_process")
    execSync(
      `tar -xzf ${JSON.stringify(tmpFile)} -C ${JSON.stringify(localPath)}`,
      { timeout, maxBuffer: 10 * 1024 * 1024 },
    )

    // Step 5: Cleanup remote temp file
    await remoteExec(client, `rm -f ${JSON.stringify(remoteTmp)}`, { timeout: 10000 }).catch(() => {})

    const duration = Date.now() - startTime
    log("transfer", `Folder download complete: ${remotePath} -> ${localPath} (${duration}ms)`)
    return {
      success: true,
      path: localPath,
      size: downloadResult.size,
      duration,
    }
  } catch (err: any) {
    return {
      success: false,
      path: localPath,
      size: 0,
      duration: Date.now() - startTime,
      error: err.message,
    }
  } finally {
    // Cleanup temp files
    try {
      const { unlinkSync } = await import("fs")
      if (existsSync(tmpFile)) unlinkSync(tmpFile)
    } catch {
      // ignore
    }
    await remoteExec(client, `rm -f ${JSON.stringify(remoteTmp)}`, { timeout: 10000 }).catch(() => {})
  }
}

/**
 * Smart transfer: automatically detects file vs folder and chooses the right method.
 * Upload if direction is "up", download if direction is "down".
 */
export async function transfer(
  client: Client,
  source: string,
  destination: string,
  direction: "up" | "down",
  options?: FolderTransferOptions,
): Promise<TransferResult> {
  if (direction === "up") {
    const isDir = statSync(source).isDirectory()
    if (isDir) {
      return uploadFolder(client, source, destination, options)
    }
    return uploadFile(client, source, destination, options)
  }

  const isDir = await remoteIsDir(client, source)
  if (isDir) {
    return downloadFolder(client, source, destination, options)
  }
  return downloadFile(client, source, destination, options)
}
