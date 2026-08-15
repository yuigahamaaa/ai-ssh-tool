/**
 * P9 矩阵测试（三）：目录传输 round-trip + 文件工具（走 createRemoteTools
 * 生产路径，含 GNU→portable fallback 链）+ buildExistsCommand 真实执行。
 *
 * 无 sshd/未授权时整组 skip。
 */

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { join, basename, relative } from "node:path"
import { tmpdir } from "node:os"
import { execRemote } from "../../remote-shell.js"
import { probeAndDetect, clearDialectCache, getDialect } from "../../remote-dialect/index.js"
import { putCachedDialect } from "../../remote-dialect/cache.js"
import { createRemoteTools } from "../../remote-tools.js"
import { uploadFolder, downloadFolder } from "../../file-transfer.js"
import { buildExistsCommand } from "../../mcp-server.js"
import type { DetectedDialect } from "../../remote-dialect/detect.js"
import { xplatConfig, connectXplat, isReachable, sessionKeyFor, closeXplat } from "./helpers.js"
import type ssh2 from "ssh2"

/** 递归收集 相对路径 → Buffer。 */
function collectTree(root: string): Map<string, Buffer> {
  const result = new Map<string, Buffer>()
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name)
      const rel = relative(root, full)
      if (statSync(full).isDirectory()) walk(full)
      else result.set(rel, readFileSync(full))
    }
  }
  walk(root)
  return result
}

describe("xplat folder transfer + file tools", () => {
  const conf = xplatConfig()
  let client: ssh2.Client | undefined
  let sessionKey = ""
  let detected: DetectedDialect | undefined
  let skipReason: string | undefined
  let localRoot = ""
  let srcDir = ""
  let remoteDir = ""

  before(async (t) => {
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

    localRoot = mkdtempSync(join(tmpdir(), "xplat-"))
    srcDir = join(localRoot, "src")
    mkdirSync(join(srcDir, "sub", "nested"), { recursive: true })
    writeFileSync(join(srcDir, "a.txt"), "line1\nline2 中文 needle\n")
    writeFileSync(join(srcDir, "sub", "b c.txt"), "file with space\n")
    writeFileSync(join(srcDir, "sub", "nested", "d.bin"), Buffer.from([0, 1, 2, 3, 255, 254]))
    remoteDir = getDialect(sessionKey).kind === "posix"
      ? `/tmp/xplat-folder-${Date.now().toString(36)}`
      : `${process.env.TEMP ?? "C:\\Windows\\Temp"}\\xplat-folder-${Date.now().toString(36)}`
  })

  after(async () => {
    clearDialectCache()
    if (client && detected && getDialect(sessionKey).kind === "posix" && remoteDir) {
      try { await execRemote(client, `rm -rf ${remoteDir}`, { timeout: 15000, sessionKey }) } catch { /* best-effort */ }
    }
    if (client) await closeXplat(client)
    if (localRoot) rmSync(localRoot, { recursive: true, force: true })
  })

  it("uploads and downloads a folder round-trip byte-identically", async (t) => {
    if (skipReason) return t.skip(skipReason)
    assert.ok(client && detected)
    const up = await uploadFolder(client, srcDir, remoteDir, { sessionKey, overwrite: true, timeout: 180000 })
    assert.ok(up.success, `upload failed: ${JSON.stringify(up)}`)

    const outDir = join(localRoot, "out")
    const dl = await downloadFolder(client, remoteDir, outDir, { sessionKey, overwrite: true, timeout: 180000 })
    assert.ok(dl.success, `download failed: ${JSON.stringify(dl)}`)

    const downloaded = collectTree(join(outDir, basename(remoteDir)))
    const expected = collectTree(srcDir)
    assert.deepEqual([...downloaded.keys()], [...expected.keys()])
    for (const [rel, buffer] of expected) {
      assert.ok(downloaded.has(rel), `missing remote file: ${rel}`)
      assert.deepEqual(downloaded.get(rel), buffer, `content mismatch: ${rel}`)
    }
  })

  it("file tools run through the production fallback chain", async (t) => {
    if (skipReason) return t.skip(skipReason)
    assert.ok(client && detected)
    const tools = await createRemoteTools({ sessionId: "xplat-test", client, cwd: "~", sessionKey })
    const aTxt = `${srcDir}${process.platform === "win32" ? "\\" : "/"}a.txt`

    const stat = await tools.stat.execute({ path: aTxt })
    assert.equal(stat.type, "file")
    assert.ok(stat.sizeBytes > 0, `stat.sizeBytes=${stat.sizeBytes}`)

    const listed = await tools.listDir.execute({ path: srcDir })
    assert.ok((listed.entries ?? []).some((e: any) => e.name === "a.txt"), `entries=${JSON.stringify(listed.entries)}`)

    const read = await tools.readFile.execute({ path: aTxt, limit: 1 })
    assert.ok((read as any).content.includes("line1"), JSON.stringify(read))

    const grep = await tools.grep.execute({ pattern: "needle", path: srcDir })
    assert.ok(grep.count >= 1, `grep.count=${grep.count}`)

    const found = await tools.find.execute({ path: srcDir, name: "b c.txt" })
    assert.ok(found.count >= 1, `find.count=${found.count}`)

    assert.equal(await tools.exists.execute({ path: aTxt }), true)
    assert.equal(await tools.exists.execute({ path: `${aTxt}.nope` }), false)
  })

  it("buildExistsCommand executes to exists/not_found per dialect", async (t) => {
    if (skipReason) return t.skip(skipReason)
    assert.ok(client && detected)
    const aTxt = `${srcDir}${process.platform === "win32" ? "\\" : "/"}a.txt`
    const exists = await execRemote(client, buildExistsCommand(aTxt, sessionKey), { timeout: 15000, sessionKey })
    assert.equal(exists.code, 0)
    assert.equal(exists.stdout.trim(), "exists")

    const absent = await execRemote(client, buildExistsCommand(`${aTxt}.nope`, sessionKey), { timeout: 15000, sessionKey })
    assert.equal(absent.code, 0)
    assert.equal(absent.stdout.trim(), "not_found")
  })
})
