/**
 * P9 矩阵测试（二）：cwd 解析 + 后台任务 + kill。
 *
 * 后台/杀进程直接走 dialect.buildBackground/buildKill 并真实执行，
 * 与 daemon 后台流程同一条代码路径。无 sshd/未授权时整组 skip。
 */

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { execRemote, remoteExec, resolveRemoteCwd } from "../../remote-shell.js"
import { probeAndDetect, clearDialectCache, getDialect } from "../../remote-dialect/index.js"
import { putCachedDialect } from "../../remote-dialect/cache.js"
import type { DetectedDialect } from "../../remote-dialect/detect.js"
import type { DialectSpec } from "../../remote-dialect/types.js"
import { xplatConfig, connectXplat, isReachable, sessionKeyFor, closeXplat } from "./helpers.js"
import type ssh2 from "ssh2"

/** 直接 exec 后台包装命令，从 stderr 捕获 PID 标记。 */
function execBackgroundCapturePid(client: ssh2.Client, bgCommand: string, dialect: DialectSpec): Promise<number> {
  return new Promise((resolve, reject) => {
    client.exec(bgCommand, (err, stream) => {
      if (err) return reject(err)
      const chunks: string[] = []
      stream.stderr.on("data", (d: Buffer) => chunks.push(d.toString()))
      stream.on("data", () => { /* drain stdout */ })
      stream.on("close", () => {
        const text = chunks.join("")
        const m = text.match(dialect.pidMarkerPattern())
        if (m) resolve(parseInt(m[1], 10))
        else reject(new Error(`no pid marker in stderr: ${JSON.stringify(text)}`))
      })
      stream.on("error", reject)
    })
  })
}

describe("xplat cwd + background/kill lifecycle", () => {
  const conf = xplatConfig()
  let client: ssh2.Client | undefined
  let sessionKey = ""
  let detected: DetectedDialect | undefined
  let skipReason: string | undefined

  before(async () => {
    if (!(await isReachable(conf.host, conf.port))) {
      skipReason = `no sshd listening at ${conf.host}:${conf.port}`
      return
    }
    try {
      client = await connectXplat(conf)
    } catch (e) {
      skipReason = `cannot authenticate to ${conf.host}:${conf.port}: ${(e as Error).message}`
      return
    }
    sessionKey = sessionKeyFor(conf)
    detected = await probeAndDetect(client)
    putCachedDialect(sessionKey, detected)
  })

  after(async () => {
    clearDialectCache()
    if (client) await closeXplat(client)
  })

  it("resolves a remote cwd and execs inside it", async (t) => {
    if (skipReason) return t.skip(skipReason)
    assert.ok(client && detected)
    const dialect = getDialect(sessionKey)
    const marker = Date.now().toString(36)
    const dir = dialect.kind === "posix" ? `/tmp/xplat-cwd-${marker}` : `$env:TEMP\\xplat-cwd-${marker}`
    const mkdir = dialect.kind === "posix" ? `mkdir -p ${dir}` : `New-Item -ItemType Directory -Force -Path '${dir}' | Out-Null`
    const created = await execRemote(client, mkdir, { timeout: 15000, sessionKey })
    assert.equal(created.code, 0, created.stderr)

    const resolved = await resolveRemoteCwd(client, dir, undefined, sessionKey)
    assert.ok(dialect.isValidAbsPath(resolved), `resolved=${resolved}`)

    const pwdCmd = dialect.kind === "posix" ? "pwd -P" : "(Get-Location).Path"
    const pwd = await remoteExec(client, pwdCmd, { cwd: dir, sessionKey, timeout: 15000 })
    assert.equal(pwd.code, 0, pwd.stderr)
    assert.equal(pwd.stdout.replace(/\r?\n$/, ""), resolved)
  })

  it("starts a background process, verifies it is alive, then kills it", async (t) => {
    if (skipReason) return t.skip(skipReason)
    assert.ok(client && detected)
    const dialect = getDialect(sessionKey)
    const cmd = dialect.kind === "posix" ? "sleep 30" : "Start-Sleep -Seconds 30"
    const pid = await execBackgroundCapturePid(client, dialect.buildBackground(cmd), dialect)
    assert.ok(Number.isInteger(pid) && pid > 0, `captured pid=${pid}`)

    const aliveCmd = dialect.kind === "posix" ? `kill -0 ${pid} 2>/dev/null` : `Get-Process -Id ${pid} -ErrorAction SilentlyContinue`
    const alive = await execRemote(client, aliveCmd, { timeout: 15000, sessionKey })
    assert.equal(alive.code, 0, `expected process ${pid} alive`)

    await new Promise<void>((resolve, reject) => {
      client!.exec(dialect.buildKill(pid), (err) => (err ? reject(err) : resolve()))
    })

    let dead = false
    for (let i = 0; i < 20; i++) {
      const check = await execRemote(client, aliveCmd, { timeout: 15000, sessionKey })
      if (check.code !== 0) {
        dead = true
        break
      }
      await new Promise((r) => setTimeout(r, 200))
    }
    assert.ok(dead, `process ${pid} still alive after kill`)
  })
})
