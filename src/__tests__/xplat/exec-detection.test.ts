/**
 * P9 矩阵测试（一）：探测判定 + exec round-trip（echo/引号/管道/含空格路径）。
 *
 * 仅在 sshd 可达且可认证时真实执行；否则整组 skip（附原因）。
 * 平台预期：
 *   windows-latest（DefaultShell=PowerShell）→ powershell/powershell
 *   macos-latest → posix/darwin
 *   ubuntu-latest → posix/gnu
 */

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { execRemote } from "../../remote-shell.js"
import { probeAndDetect, clearDialectCache, getDialect } from "../../remote-dialect/index.js"
import { putCachedDialect } from "../../remote-dialect/cache.js"
import type { DetectedDialect } from "../../remote-dialect/detect.js"
import { xplatConfig, connectXplat, isReachable, sessionKeyFor, closeXplat } from "./helpers.js"
import type ssh2 from "ssh2"

describe("xplat detection + exec round-trip", () => {
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

  it("detects the platform dialect (kind + sub)", (t) => {
    if (skipReason) return t.skip(skipReason)
    assert.ok(detected)
    const expected =
      process.platform === "win32"
        ? { kind: "powershell" as const, sub: "powershell" }
        : process.platform === "darwin"
          ? { kind: "posix" as const, sub: "darwin" }
          : { kind: "posix" as const, sub: "gnu" }
    assert.equal(detected.kind, expected.kind)
    assert.equal(detected.sub, expected.sub)
  })

  it("echo round-trip returns the marker verbatim", async (t) => {
    if (skipReason) return t.skip(skipReason)
    assert.ok(client && detected)
    const marker = `XPLAT_${Date.now().toString(36)}`
    const result = await execRemote(client, `echo ${marker}`, { timeout: 15000, sessionKey })
    assert.equal(result.code, 0)
    assert.ok(result.stdout.includes(marker), `stdout=${JSON.stringify(result.stdout)}`)
  })

  it("quoted string round-trip survives the wrapper", async (t) => {
    if (skipReason) return t.skip(skipReason)
    assert.ok(client && detected)
    const dialect = getDialect(sessionKey)
    const cmd = dialect.kind === "posix" ? `printf '%s' 'a b'` : `Write-Output 'a b'`
    const result = await execRemote(client, cmd, { timeout: 15000, sessionKey })
    assert.equal(result.code, 0)
    assert.equal(result.stdout.replace(/\r?\n$/, ""), "a b")
  })

  it("pipe round-trip executes through the wrapper", async (t) => {
    if (skipReason) return t.skip(skipReason)
    assert.ok(client && detected)
    const dialect = getDialect(sessionKey)
    const cmd = dialect.kind === "posix" ? "ls | wc -l" : "(Get-ChildItem | Measure-Object).Count"
    const result = await execRemote(client, cmd, { timeout: 15000, sessionKey })
    assert.equal(result.code, 0)
    assert.ok(result.stdout.trim().length > 0)
  })

  it("path containing a space round-trips verbatim", async (t) => {
    if (skipReason) return t.skip(skipReason)
    assert.ok(client && detected)
    const dialect = getDialect(sessionKey)
    const cmd = dialect.kind === "posix" ? `printf '%s' '/tmp/a b'` : `Write-Output 'C:/a b'`
    const result = await execRemote(client, cmd, { timeout: 15000, sessionKey })
    assert.equal(result.code, 0)
    assert.equal(result.stdout.replace(/\r?\n$/, ""), dialect.kind === "posix" ? "/tmp/a b" : "C:/a b")
  })
})
