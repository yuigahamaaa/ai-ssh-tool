/**
 * Remote Shell - execute commands on remote SSH sessions
 * Wraps ssh2's exec() to run non-interactive commands and capture output
 */

import type { Client } from "ssh2"
import { log } from "./logger.js"

export interface ExecResult {
  stdout: string
  stderr: string
  code: number
  signal?: string
}

/**
 * Execute a command on a remote host via an existing SSH client.
 * Returns when the command finishes (non-interactive).
 */
export function remoteExec(
  client: Client,
  command: string,
  options?: { timeout?: number; cwd?: string; env?: Record<string, string> },
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const timeout = options?.timeout ?? 30000

    let fullCommand = command
    if (options?.cwd) {
      fullCommand = `cd ${JSON.stringify(options.cwd)} && ${fullCommand}`
    }
    if (options?.env) {
      const envPrefix = Object.entries(options.env)
        .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
        .join(" ")
      fullCommand = `${envPrefix}; ${fullCommand}`
    }

    log("exec", `Executing: ${fullCommand.slice(0, 200)}${fullCommand.length > 200 ? "..." : ""}`)
    log("exec", `Timeout: ${timeout}ms`)

    const timer = setTimeout(() => {
      log("exec", `Command timed out after ${timeout}ms: ${command}`)
      reject(new Error(`Command timed out after ${timeout}ms: ${command}`))
    }, timeout)

    const execStart = Date.now()
    client.exec(fullCommand, (err, stream) => {
      if (err) {
        clearTimeout(timer)
        log("exec", `exec() failed: ${err.message}`)
        reject(new Error(`Failed to exec command: ${err.message}`))
        return
      }

      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []

      stream.on("data", (data: Buffer) => {
        stdoutChunks.push(data)
      })

      stream.stderr.on("data", (data: Buffer) => {
        stderrChunks.push(data)
      })

      stream.on("close", (code?: number, signal?: string) => {
        clearTimeout(timer)
        const stdout = Buffer.concat(stdoutChunks).toString()
        const stderr = Buffer.concat(stderrChunks).toString()
        log("exec", `Completed in ${Date.now() - execStart}ms: code=${code}, stdout=${stdout.length}B, stderr=${stderr.length}B`)
        resolve({ stdout, stderr, code: code ?? 0, signal })
      })

      stream.on("error", (streamErr: Error) => {
        clearTimeout(timer)
        reject(new Error(`Stream error: ${streamErr.message}`))
      })
    })
  })
}

/**
 * Execute a command on the last hop of a connection chain.
 * The chain must already be connected.
 */
export function execOnChain(
  clients: { client: Client }[],
  command: string,
  options?: { timeout?: number; cwd?: string; env?: Record<string, string> },
): Promise<ExecResult> {
  if (clients.length === 0) {
    throw new Error("No SSH clients in chain")
  }
  const finalClient = clients[clients.length - 1].client
  return remoteExec(finalClient, command, options)
}
