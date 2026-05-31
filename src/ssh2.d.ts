declare module "ssh2" {
  import { EventEmitter } from "events"
  import { Socket } from "net"
  import { Readable, Writable } from "stream"

  export interface ConnectConfig {
    host?: string
    port?: number
    username?: string
    password?: string
    privateKey?: string | Buffer
    passphrase?: string
    readyTimeout?: number
    sock?: Socket | Readable
    /** Path to SSH agent socket or 'pageant' on Windows, or an Agent instance */
    agent?: string | BaseAgent
    /** Enable agent forwarding (requires `agent` to be set) */
    agentForward?: boolean
    [key: string]: any
  }

  export interface ClientChannel extends EventEmitter {
    write(data: string | Buffer, callback?: (err?: Error) => void): boolean
    close(): void
    setWindow(rows: number, cols: number, height: number, width: number, callback?: (err?: Error) => void): void
    on(event: "data", listener: (data: Buffer) => void): this
    on(event: "close", listener: (code?: number, signal?: string) => void): this
    on(event: "error", listener: (err: Error) => void): this
    stderr: Readable
  }

  export interface SFTPWrapper extends EventEmitter {
    createReadStream(path: string, options?: any): Readable
    createWriteStream(path: string, options?: any): Writable
    stat(path: string, callback: (err: Error | undefined, stats: Stats) => void): void
    readdir(path: string, callback: (err: Error | undefined, list: DirEntry[]) => void): void
    unlink(path: string, callback: (err: Error | undefined) => void): void
    mkdir(path: string, options: { mode?: number }, callback: (err: Error | undefined) => void): void
    rmdir(path: string, callback: (err: Error | undefined) => void): void
    rename(oldPath: string, newPath: string, callback: (err: Error | undefined) => void): void
    chmod(path: string, mode: number, callback: (err: Error | undefined) => void): void
    realpath(path: string, callback: (err: Error | undefined, resolvedPath: string) => void): void
    end(): void
  }

  export interface Stats {
    size: number
    uid: number
    gid: number
    mode: number
    atime: number
    mtime: number
  }

  export interface DirEntry {
    filename: string
    longname: string
    attrs: Stats
  }

  export class Client extends EventEmitter {
    connect(config: ConnectConfig): void
    shell(window: { term?: string; cols?: number; rows?: number }, callback: (err: Error | undefined, channel: ClientChannel) => void): void
    exec(command: string, callback: (err: Error | undefined, stream: ClientChannel) => void): void
    forwardOut(srcIP: string, srcPort: number, dstIP: string, dstPort: number, callback: (err: Error | undefined, stream: any) => void): void
    sftp(callback: (err: Error | undefined, sftp: SFTPWrapper) => void): void
    destroy(): void
    on(event: "ready", listener: () => void): this
    on(event: "error", listener: (err: Error) => void): this
    on(event: "close", listener: () => void): this
    on(event: string, listener: (...args: any[]) => void): this
  }

  export class BaseAgent {
    getIdentities(cb: (err: Error | null, keys?: any[]) => void): void
    sign(pubKey: any, data: Buffer, options: any, cb: (err: Error | null, sig?: Buffer) => void): void
  }

  export class OpenSSHAgent extends BaseAgent {
    constructor(socketPath: string)
  }

  export class PageantAgent extends BaseAgent {}

  export class CygwinAgent extends BaseAgent {
    constructor(socketPath: string)
  }

  export function createAgent(path: string): BaseAgent

  export namespace utils {
    function generateKeyPairSync(type: string, options?: any): { private: string; public: string }
  }

  export class Server extends EventEmitter {
    constructor(config?: { hostKeys?: any[]; [key: string]: any }, connectionListener?: (client: Client) => void)
    listen(port: number, host?: string, callback?: () => void): this
    close(callback?: () => void): this
    address(): { port: number; family: string; address: string } | string
    on(event: "connection", listener: (client: Client) => void): this
    on(event: string, listener: (...args: any[]) => void): this
  }
}
