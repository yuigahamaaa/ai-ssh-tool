/**
 * xplat 矩阵测试连接基建。
 *
 * 契约：
 * - 配置经 env 覆盖：XPLAT_SSH_HOST / XPLAT_SSH_PORT / XPLAT_SSH_USER / XPLAT_SSH_KEY
 * - XPLAT_SSH_KEY 未设置时内存生成临时 ed25519 密钥（CI 外自跳过逻辑由各测试套件负责）
 * - isReachable 短超时 TCP 探测；connectXplat 使用 hostVerifier 全接受（CI 一次性主机）
 */

import os from "node:os"
import { readFileSync } from "node:fs"
import { createConnection } from "node:net"
import ssh2 from "ssh2"
import { createStableEd25519KeyPair } from "../ssh-test-key.js"

export interface XplatConfig {
  host: string
  port: number
  username: string
  keyPath?: string
}

export function xplatConfig(): XplatConfig {
  return {
    host: process.env.XPLAT_SSH_HOST ?? "127.0.0.1",
    port: Number(process.env.XPLAT_SSH_PORT ?? "22"),
    username: process.env.XPLAT_SSH_USER ?? os.userInfo().username,
    keyPath: process.env.XPLAT_SSH_KEY || undefined,
  }
}

export function sessionKeyFor(conf: XplatConfig): string {
  return `${conf.username}@${conf.host}:${conf.port}`
}

/** 短超时 TCP 探测，端口无监听时快速返回 false。 */
export function isReachable(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port })
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(false)
    }, timeoutMs)
    socket.once("connect", () => {
      clearTimeout(timer)
      socket.destroy()
      resolve(true)
    })
    socket.once("error", () => {
      clearTimeout(timer)
      socket.destroy()
      resolve(false)
    })
  })
}

/** 连接本机 sshd；ready 即 resolve，auth/网络失败 reject。 */
export async function connectXplat(conf: XplatConfig): Promise<ssh2.Client> {
  const privateKey = conf.keyPath
    ? readFileSync(conf.keyPath)
    : createStableEd25519KeyPair().private
  return new Promise((resolve, reject) => {
    const client = new ssh2.Client()
    client.once("ready", () => resolve(client))
    client.once("error", (err) => reject(err))
    client.connect({
      host: conf.host,
      port: conf.port,
      username: conf.username,
      privateKey,
      readyTimeout: 8000,
      hostVerifier: () => true,
    })
  })
}

export async function closeXplat(client: ssh2.Client): Promise<void> {
  await new Promise<void>((resolve) => {
    client.once("close", () => resolve())
    try {
      client.destroy()
    } catch {
      resolve()
    }
    // 防悬挂：5s 兜底
    setTimeout(resolve, 5000).unref()
  })
}
