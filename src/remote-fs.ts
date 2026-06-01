/**
 * Remote Filesystem - read/write files on remote SSH sessions via SFTP
 * Enables opencode's AI to edit files directly on the remote machine
 */

import type { Client, SFTPWrapper } from "ssh2"

export interface RemoteFileStat {
  size: number
  uid: number
  gid: number
  mode: number
  atime: number
  mtime: number
  isFile: boolean
  isDirectory: boolean
  isSymbolicLink: boolean
}

export interface ReadFileOptions {
  encoding?: BufferEncoding
  /** Skip symlinks (return error for symlinks) */
  skipSymlinks?: boolean
}

export interface WriteFileOptions {
  encoding?: BufferEncoding
  mode?: number
  /** Create backup before overwriting */
  backup?: boolean
}

export interface DirEntry {
  filename: string
  longname: string
  attrs: RemoteFileStat
}

export interface RemoteFs {
  /** Read a file from the remote host */
  readFile(path: string, options?: ReadFileOptions): Promise<string | Buffer>
  /** Write a file to the remote host */
  writeFile(path: string, data: string | Buffer, options?: WriteFileOptions): Promise<void>
  /** Check if a file/directory exists */
  exists(path: string): Promise<boolean>
  /** Get file/directory stats */
  stat(path: string): Promise<RemoteFileStat>
  /** List directory contents */
  readdir(path: string, options?: { skipSymlinks?: boolean }): Promise<DirEntry[]>
  /** Remove a file */
  unlink(path: string): Promise<void>
  /** Create a directory */
  mkdir(path: string, mode?: number): Promise<void>
  /** Remove a directory */
  rmdir(path: string): Promise<void>
  /** Rename/move a file */
  rename(oldPath: string, newPath: string): Promise<void>
  /** Get file permissions */
  chmod(path: string, mode: number): Promise<void>
  /** Resolve a path (expand ~ and normalize) */
  resolvePath(path: string): Promise<string>
  /** Close the SFTP connection */
  close(): void
}

/**
 * Create a remote filesystem backed by an SSH2 SFTP session
 */
export function createRemoteFs(client: Client): Promise<RemoteFs> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) {
        reject(new Error(`Failed to open SFTP: ${err.message}`))
        return
      }
      resolve(new SftpFs(sftp))
    })
  })
}

class SftpFs implements RemoteFs {
  private sftp: SFTPWrapper
  private closed = false

  constructor(sftp: SFTPWrapper) {
    this.sftp = sftp
  }

  async readFile(path: string, options?: ReadFileOptions): Promise<string | Buffer> {
    this.checkOpen()
    const resolved = await this.resolvePath(path)

    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []

      const readStream = this.sftp.createReadStream(resolved)

      readStream.on("data", (chunk: Buffer) => {
        chunks.push(chunk)
      })

      readStream.on("end", () => {
        const buffer = Buffer.concat(chunks)
        if (options?.encoding) {
          resolve(buffer.toString(options.encoding))
        } else {
          resolve(buffer)
        }
      })

      readStream.on("error", (streamErr: Error) => {
        reject(new Error(`Failed to read ${path}: ${streamErr.message}`))
      })
    })
  }

  async writeFile(path: string, data: string | Buffer, options?: WriteFileOptions): Promise<void> {
    this.checkOpen()
    const resolved = await this.resolvePath(path)
    const buffer = typeof data === "string" ? Buffer.from(data, options?.encoding) : data

    if (options?.backup) {
      await this.backupFile(resolved)
    }

    return new Promise((resolve, reject) => {
      const writeStream = this.sftp.createWriteStream(resolved, {
        mode: options?.mode,
      })

      writeStream.on("error", (streamErr: Error) => {
        reject(new Error(`Failed to write ${path}: ${streamErr.message}`))
      })

      writeStream.on("close", () => {
        resolve()
      })

      writeStream.end(buffer)
    })
  }

  private async backupFile(path: string): Promise<void> {
    const exists = await this.exists(path)
    if (!exists) return

    const backupPath = `${path}.backup`
    return new Promise((resolve, reject) => {
      const readStream = this.sftp.createReadStream(path)
      const writeStream = this.sftp.createWriteStream(backupPath)

      writeStream.on("error", (err: Error) => {
        reject(new Error(`Failed to backup ${path}: ${err.message}`))
      })

      writeStream.on("close", () => {
        resolve()
      })

      readStream.pipe(writeStream)
    })
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.stat(path)
      return true
    } catch {
      return false
    }
  }

  async stat(path: string): Promise<RemoteFileStat> {
    this.checkOpen()
    const resolved = await this.resolvePath(path)

    return new Promise((resolve, reject) => {
      this.sftp.stat(resolved, (err, stats) => {
        if (err) {
          reject(new Error(`Failed to stat ${path}: ${err.message}`))
          return
        }
        resolve({
          size: stats.size,
          uid: stats.uid,
          gid: stats.gid,
          mode: stats.mode,
          atime: stats.atime * 1000,
          mtime: stats.mtime * 1000,
          isFile: (stats.mode & 0o170000) === 0o100000,
          isDirectory: (stats.mode & 0o170000) === 0o040000,
          isSymbolicLink: (stats.mode & 0o170000) === 0o120000,
        })
      })
    })
  }

  async readdir(path: string, options?: { skipSymlinks?: boolean }): Promise<DirEntry[]> {
    this.checkOpen()
    const resolved = await this.resolvePath(path)
    const skipSymlinks = options?.skipSymlinks ?? false

    return new Promise((resolve, reject) => {
      this.sftp.readdir(resolved, (err, list) => {
        if (err) {
          reject(new Error(`Failed to readdir ${path}: ${err.message}`))
          return
        }

        const filtered = skipSymlinks
          ? list.filter((item) => (item.attrs.mode & 0o170000) !== 0o120000)
          : list

        resolve(
          filtered.map((item) => ({
            filename: item.filename,
            longname: item.longname,
            attrs: {
              size: item.attrs.size,
              uid: item.attrs.uid,
              gid: item.attrs.gid,
              mode: item.attrs.mode,
              atime: item.attrs.atime * 1000,
              mtime: item.attrs.mtime * 1000,
              isFile: (item.attrs.mode & 0o170000) === 0o100000,
              isDirectory: (item.attrs.mode & 0o170000) === 0o040000,
              isSymbolicLink: (item.attrs.mode & 0o170000) === 0o120000,
            },
          }))
        )
      })
    })
  }

  async unlink(path: string): Promise<void> {
    this.checkOpen()
    const resolved = await this.resolvePath(path)

    return new Promise((resolve, reject) => {
      this.sftp.unlink(resolved, (err) => {
        if (err) reject(new Error(`Failed to unlink ${path}: ${err.message}`))
        else resolve()
      })
    })
  }

  async mkdir(path: string, mode?: number): Promise<void> {
    this.checkOpen()
    const resolved = await this.resolvePath(path)

    return new Promise((resolve, reject) => {
      this.sftp.mkdir(resolved, { mode }, (err) => {
        if (err) reject(new Error(`Failed to mkdir ${path}: ${err.message}`))
        else resolve()
      })
    })
  }

  async rmdir(path: string): Promise<void> {
    this.checkOpen()
    const resolved = await this.resolvePath(path)

    return new Promise((resolve, reject) => {
      this.sftp.rmdir(resolved, (err) => {
        if (err) reject(new Error(`Failed to rmdir ${path}: ${err.message}`))
        else resolve()
      })
    })
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    this.checkOpen()
    const resolvedOld = await this.resolvePath(oldPath)
    const resolvedNew = await this.resolvePath(newPath)

    return new Promise((resolve, reject) => {
      this.sftp.rename(resolvedOld, resolvedNew, (err) => {
        if (err) reject(new Error(`Failed to rename ${oldPath} -> ${newPath}: ${err.message}`))
        else resolve()
      })
    })
  }

  async chmod(path: string, mode: number): Promise<void> {
    this.checkOpen()
    const resolved = await this.resolvePath(path)

    return new Promise((resolve, reject) => {
      this.sftp.chmod(resolved, mode, (err) => {
        if (err) reject(new Error(`Failed to chmod ${path}: ${err.message}`))
        else resolve()
      })
    })
  }

  async resolvePath(path: string): Promise<string> {
    if (path.startsWith("~")) {
      const home = await this.getHomeDir()
      return path.replace("~", home)
    }
    return path
  }

  close(): void {
    if (!this.closed) {
      this.sftp.end()
      this.closed = true
    }
  }

  private checkOpen(): void {
    if (this.closed) throw new Error("SFTP connection is closed")
  }

  private async getHomeDir(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.sftp.realpath(".", (err, resolvedPath) => {
        if (err) {
          // Fallback: try common home patterns
          resolve("/home/" + (process.env.USER ?? "root"))
        } else {
          resolve(resolvedPath)
        }
      })
    })
  }
}
