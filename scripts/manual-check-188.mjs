#!/usr/bin/env node

/**
 * manual-check-188.mjs — 真实 Windows(188) 手测清单（P10）
 *
 * 覆盖 P0-P9 交付：私钥修复、方言探测、exec（引号/管道/反斜杠路径）、
 * cwd、env、后台任务、取消、目录传输 round-trip、文件工具、exists、
 * host-load 便携命令。每项输出 [PASS]/[FAIL]/[SKIP]，汇总后退出码非 0 表示有失败。
 *
 * 用法（任选其一）：
 *   MCHECK_PROFILE=lobster-188 node scripts/manual-check-188.mjs
 *   MCHECK_HOST=192.168.50.188 MCHECK_PORT=22 MCHECK_USER=xxx \
 *     MCHECK_PASSWORD=xxx node scripts/manual-check-188.mjs
 *   MCHECK_HOST=192.168.50.188 MCHECK_USER=xxx \
 *     MCHECK_PRIVATE_KEY=/path/to/key node scripts/manual-check-188.mjs
 */

import { homedir } from "node:os"
import { join } from "node:path"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, relative } from "node:path"
import ssh2 from "ssh2"
import { ProfileManager } from "../dist/profile-manager.js"
import { resolvePrivateKeyContent } from "../dist/private-key.js"
import { probeAndDetect } from "../dist/remote-dialect/index.js"
import { putCachedDialect, getCachedDialect } from "../dist/remote-dialect/cache.js"
import { execRemote, resolveRemoteCwd } from "../dist/remote-shell.js"
import { createRemoteFs } from "../dist/remote-fs.js"
import { uploadFolder, downloadFolder } from "../dist/file-transfer.js"
import { buildStatCommand, parseStatOutput, buildReadFileContentCommand, buildListDirCommand, parseListDirOutput } from "../dist/remote-file-tools.js"
import { buildExistsCommand, buildHostLoadCommands } from "../dist/mcp-server.js"

const PASS = "\u001b[32mPASS\u001b[0m"
const FAIL = "\u001b[31mFAIL\u001b[0m"
const SKIP = "\u001b[33mSKIP\u001b[0m"

let passCount = 0
let failCount = 0
let skipCount = 0

async function check(name, fn) {
  try {
    await fn()
    passCount++
    console.log(`[${PASS}] ${name}`)
  } catch (e) {
    failCount++
    console.log(`[${FAIL}] ${name} — ${e.message}`)
  }
}

function skip(name, reason) {
  skipCount++
  console.log(`[${SKIP}] ${name} — ${reason}`)
}

function loadTarget() {
  const profileName = process.env.MCHECK_PROFILE
  if (profileName) {
    const pm = new ProfileManager()
    pm.load()
    const profile = pm.getByName(profileName)
    if (!profile) throw new Error(`Profile not found: ${profileName}`)
    if (profile.chain.length !== 1) throw new Error(`manual-check 仅支持单跳 profile（${profileName} 有 ${profile.chain.length} 跳）`)
    const hop = profile.chain[0]
    return {
      host: hop.host,
      port: hop.port ?? 22,
      username: hop.auth.username,
      password: hop.auth.password,
      privateKey: hop.auth.privateKey ? resolvePrivateKeyContent(hop.auth.privateKey) : undefined,
    }
  }
  if (!process.env.MCHECK_HOST || !process.env.MCHECK_USER) {
    throw new Error("请设置 MCHECK_PROFILE，或 MCHECK_HOST + MCHECK_USER（+ MCHECK_PASSWORD / MCHECK_PRIVATE_KEY）")
  }
  return {
    host: process.env.MCHECK_HOST,
    port: Number(process.env.MCHECK_PORT ?? "22"),
    username: process.env.MCHECK_USER,
    password: process.env.MCHECK_PASSWORD,
    privateKey: process.env.MCHECK_PRIVATE_KEY ? resolvePrivateKeyContent(process.env.MCHECK_PRIVATE_KEY) : undefined,
  }
}

function connect(target) {
  return new Promise((resolve, reject) => {
    const client = new ssh2.Client()
    client.once("ready", () => resolve(client))
    client.once("error", reject)
    client.connect({
      host: target.host,
      port: target.port,
      username: target.username,
      password: target.password,
      privateKey: target.privateKey,
      readyTimeout: 15000,
      hostVerifier: () => true,
    })
  })
}

function close(client) {
  return new Promise((resolve) => {
    client.once("close", () => resolve())
    try { client.destroy() } catch { resolve() }
    setTimeout(resolve, 3000).unref()
  })
}

function collectTree(root) {
  const result = new Map()
  const walk = (dir) => {
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

async function main() {
  const target = loadTarget()
  const sessionKey = `${target.username}@${target.host}:${target.port}`
  let client

  // --- 01 连接（含私钥解析，P0） ---
  try {
    client = await connect(target)
    passCount++
    console.log(`[${PASS}] 01 连接握手（${target.username}@${target.host}:${target.port}）`)
  } catch (e) {
    failCount++
    console.log(`[${FAIL}] 01 连接握手 — ${e.message}`)
    process.exitCode = 1
    return
  }

  const localRoot = mkdtempSync(join(tmpdir(), "mcheck-"))
  let remoteRoot = ""
  const remoteRootFs = () => remoteRoot.replace(/\\/g, "/")
  try {
    // --- 02 方言探测 ---
    let detected
    await check("02 方言探测（Windows: powershell/cmd）", async () => {
      detected = await probeAndDetect(client)
      putCachedDialect(sessionKey, detected)
      if (detected.kind !== "powershell" && detected.kind !== "cmd") {
        throw new Error(`kind=${detected.kind} sub=${detected.sub}`)
      }
      console.log(`        探测结果: kind=${detected.kind} sub=${detected.sub}`)
    })

    const kind = detected?.kind ?? "powershell"

    // --- 03 exec 基础 echo ---
    await check("03 exec 基础 echo", async () => {
      const marker = `MCHECK_${Date.now().toString(36)}`
      const r = await execRemote(client, `echo ${marker}`, { timeout: 15000, sessionKey })
      if (r.code !== 0) throw new Error(`code=${r.code} stderr=${r.stderr.trim()}`)
      if (!r.stdout.includes(marker)) throw new Error(`stdout=${JSON.stringify(r.stdout)}`)
    })

    // --- 04 where powershell（现场唯一成功命令回归） ---
    await check("04 where powershell（现场症状回归）", async () => {
      const r = await execRemote(client, "where powershell", { timeout: 15000, sessionKey })
      if (r.code !== 0) throw new Error(`code=${r.code} stderr=${r.stderr.trim()}`)
      if (!r.stdout.trim()) throw new Error("empty stdout")
    })

    // --- 05 dir C:\\Windows（现场失败症状①） ---
    await check("05 dir C:\\Windows（反斜杠路径）", async () => {
      const r = await execRemote(client, "dir C:\\Windows", { timeout: 20000, sessionKey })
      if (r.code !== 0) throw new Error(`code=${r.code} stderr=${r.stderr.trim()}`)
      if (!r.stdout.trim()) throw new Error("empty stdout")
    })

    // --- 06 powershell -Command 带引号（现场失败症状②） ---
    await check("06 powershell -Command 'C:\\Program Files'（引号+空格路径）", async () => {
      const r = await execRemote(client, "powershell -Command \"Get-ChildItem 'C:\\Program Files'\"", { timeout: 20000, sessionKey })
      if (r.code !== 0) throw new Error(`code=${r.code} stderr=${r.stderr.slice(0, 300)}`)
      if (!r.stdout.trim()) throw new Error("empty stdout")
    })

    // --- 07 引号 round-trip ---
    await check("07 引号 round-trip", async () => {
      const cmd = kind === "cmd" ? `echo "a b"` : `Write-Output 'a b'`
      const r = await execRemote(client, cmd, { timeout: 15000, sessionKey })
      if (r.code !== 0) throw new Error(`code=${r.code}`)
      const expected = kind === "cmd" ? `"a b"` : `a b`
      if (r.stdout.replace(/\r?\n$/, "") !== expected) throw new Error(`stdout=${JSON.stringify(r.stdout)}`)
    })

    // --- 08 管道 round-trip ---
    await check("08 管道 round-trip", async () => {
      const cmd = kind === "cmd" ? "dir /b | find /c /v \"\"" : "(Get-ChildItem | Measure-Object).Count"
      const r = await execRemote(client, cmd, { timeout: 15000, sessionKey })
      if (r.code !== 0) throw new Error(`code=${r.code} stderr=${r.stderr.trim()}`)
      if (!r.stdout.trim()) throw new Error("empty stdout")
    })

    // --- 09 反斜杠路径原样 ---
    await check("09 反斜杠路径原样（C:\\Program Files）", async () => {
      const cmd = kind === "cmd" ? "echo C:\\Program Files" : "Write-Output 'C:\\Program Files'"
      const r = await execRemote(client, cmd, { timeout: 15000, sessionKey })
      if (r.code !== 0) throw new Error(`code=${r.code}`)
      if (!r.stdout.includes("C:\\Program Files")) throw new Error(`stdout=${JSON.stringify(r.stdout)}`)
    })

    // --- 10 含空格路径 stat（powershell 走方言命令；cmd 走 SFTP） ---
    await check("10 含空格路径 stat（C:\\Program Files）", async () => {
      if (kind === "cmd") {
        const fs = await createRemoteFs(client)
        // SFTP 路径统一用正斜杠（Windows SFTP 服务端按 POSIX 路径解释）
        const st = await fs.stat("C:/Program Files")
        // RemoteFileStat 的 isDirectory 是布尔属性（非 node fs.Stats 的 isDirectory() 方法）
        if (st?.isDirectory !== true) throw new Error(`type not directory (isDirectory=${st?.isDirectory})`)
      } else {
        const r = await execRemote(client, buildStatCommand("C:\\Program Files", { kind }), { timeout: 20000, sessionKey })
        if (r.code !== 0) throw new Error(`code=${r.code} stderr=${r.stderr.slice(0, 200)}`)
        const stat = parseStatOutput(r.stdout)
        if (stat.type !== "directory") throw new Error(`type=${stat.type}`)
      }
    })

    // --- 11 cwd 解析 ---
    await check("11 cwd 解析（resolveRemoteCwd）", async () => {
      const temp = (await execRemote(client, kind === "cmd" ? "echo %TEMP%" : "$env:TEMP", { timeout: 15000, sessionKey })).stdout.trim()
      const dir = `${temp}\\mcheck-cwd-${Date.now().toString(36)}`
      const mkdir = await execRemote(client, kind === "cmd" ? `mkdir "${dir}"` : `New-Item -ItemType Directory -Force -Path '${dir}' | Out-Null`, { timeout: 15000, sessionKey })
      if (mkdir.code !== 0) throw new Error(`mkdir failed: ${mkdir.stderr.trim()}`)
      const resolved = await resolveRemoteCwd(client, dir, undefined, sessionKey)
      if (!/^[A-Za-z]:[\\/]/.test(resolved)) throw new Error(`resolved=${resolved}`)
    })

    // --- 12 env 注入（cmd 单行 set+%VAR% 有解析期展开限制，跳过） ---
    if (kind === "cmd") {
      skip("12 env 注入", "cmd 单行 `set K=V && echo %K%` 中 %K% 在解析期展开为空（已知 cmd 方言限制）")
    } else {
      await check("12 env 注入（MCHECK_VAR）", async () => {
        const r = await execRemote(client, "$env:MCHECK_VAR='hello42'; echo $env:MCHECK_VAR", { timeout: 15000, sessionKey })
        if (r.code !== 0) throw new Error(`code=${r.code} stderr=${r.stderr.trim()}`)
        if (!r.stdout.includes("hello42")) throw new Error(`stdout=${JSON.stringify(r.stdout)}`)
      })
    }

    // --- 13-15 后台 + 取消（powershell 才可靠） ---
    if (kind !== "cmd") {
      let bgPid = 0
      await check("13 后台任务启动（Start-Sleep）", async () => {
        const dialect = (await import("../dist/remote-dialect/index.js")).getDialect(sessionKey)
        const pid = await new Promise((resolve, reject) => {
          client.exec(dialect.buildBackground("Start-Sleep -Seconds 30"), (err, stream) => {
            if (err) return reject(err)
            const chunks = []
            stream.stderr.on("data", (d) => chunks.push(d.toString()))
            stream.on("data", () => {})
            stream.on("close", () => {
              const m = chunks.join("").match(dialect.pidMarkerPattern())
              if (m) resolve(parseInt(m[1], 10))
              else reject(new Error(`no pid marker in stderr: ${JSON.stringify(chunks.join(""))}`))
            })
            stream.on("error", reject)
          })
        })
        bgPid = pid
        if (!Number.isInteger(pid) || pid <= 0) throw new Error(`pid=${pid}`)
      })

      await check("14 后台任务存活校验", async () => {
        const r = await execRemote(client, `Get-Process -Id ${bgPid} -ErrorAction SilentlyContinue`, { timeout: 15000, sessionKey })
        if (r.code !== 0) throw new Error(`code=${r.code}`)
      })

      await check("15 后台任务取消（buildKill）", async () => {
        const dialect = (await import("../dist/remote-dialect/index.js")).getDialect(sessionKey)
        await new Promise((resolve, reject) => client.exec(dialect.buildKill(bgPid), (err) => (err ? reject(err) : resolve())))
        let dead = false
        for (let i = 0; i < 20; i++) {
          const r = await execRemote(client, `Get-Process -Id ${bgPid} -ErrorAction SilentlyContinue`, { timeout: 15000, sessionKey })
          if (r.code !== 0) { dead = true; break }
          await new Promise((r2) => setTimeout(r2, 200))
        }
        if (!dead) throw new Error(`pid ${bgPid} still alive`)
      })
    }

    // --- 16-17 目录传输 round-trip ---
    const srcDir = join(localRoot, "src")
    mkdirSync(join(srcDir, "sub", "nested"), { recursive: true })
    writeFileSync(join(srcDir, "a.txt"), "line1\nline2 中文 needle\n")
    writeFileSync(join(srcDir, "sub", "b c.txt"), "file with space\n")
    writeFileSync(join(srcDir, "sub", "nested", "d.bin"), Buffer.from([0, 1, 2, 3, 255, 254]))

    await check("16 目录上传 round-trip（SFTP 递归）", async () => {
      const temp = (await execRemote(client, kind === "cmd" ? "echo %TEMP%" : "$env:TEMP", { timeout: 15000, sessionKey })).stdout.trim()
      remoteRoot = `${temp}\\mcheck-dir-${Date.now().toString(36)}`
      // SFTP 传输统一用正斜杠（file-transfer 内部 normalize），本地 basename 也正确
      const up = await uploadFolder(client, srcDir, remoteRootFs(), { sessionKey, overwrite: true, timeout: 180000 })
      if (!up.success) throw new Error(JSON.stringify(up))
    })

    await check("17 目录下载 round-trip（逐字节一致）", async () => {
      const outDir = join(localRoot, "out")
      const dl = await downloadFolder(client, remoteRootFs(), outDir, { sessionKey, overwrite: true, timeout: 180000 })
      if (!dl.success) throw new Error(JSON.stringify(dl))
      const downloaded = collectTree(join(outDir, basename(remoteRootFs())))
      const expected = collectTree(srcDir)
      if ([...downloaded.keys()].join() !== [...expected.keys()].join()) {
        throw new Error(`tree mismatch: remote=${[...downloaded.keys()]} local=${[...expected.keys()]}`)
      }
      for (const [rel, buf] of expected) {
        if (!downloaded.has(rel)) throw new Error(`missing: ${rel}`)
        if (Buffer.compare(downloaded.get(rel), buf) !== 0) throw new Error(`content mismatch: ${rel}`)
      }
    })

    // --- 18 文件工具 read/list（powershell 走方言命令；cmd 走 SFTP） ---
    await check("18 文件工具 read/list", async () => {
      const aTxt = `${remoteRootFs()}/a.txt`
      if (kind === "cmd") {
        const fs = await createRemoteFs(client)
        const buf = await fs.readFile(aTxt, { maxBytes: 1024 * 1024 })
        if (!buf.toString().includes("line1")) throw new Error(`read content missing line1`)
        const names = (await fs.readdir(remoteRootFs())).map((e) => e.filename)
        if (!names.includes("a.txt")) throw new Error(`list missing a.txt: ${JSON.stringify(names)}`)
      } else {
        const read = await execRemote(client, buildReadFileContentCommand(aTxt, 0, 1, { kind }), { timeout: 20000, sessionKey })
        if (read.code !== 0) throw new Error(`read code=${read.code} stderr=${read.stderr.slice(0, 200)}`)
        if (!read.stdout.includes("line1")) throw new Error(`stdout=${JSON.stringify(read.stdout)}`)
        const listed = await execRemote(client, buildListDirCommand(remoteRootFs(), false, { kind }), { timeout: 20000, sessionKey })
        if (listed.code !== 0) throw new Error(`list code=${listed.code} stderr=${listed.stderr.slice(0, 200)}`)
        const parsed = parseListDirOutput(remoteRootFs(), listed.stdout)
        if (!parsed.entries.some((e) => e.name === "a.txt")) throw new Error(`entries=${JSON.stringify(parsed.entries).slice(0, 200)}`)
      }
    })

    // --- 19 buildExistsCommand 真实执行 ---
    await check("19 buildExistsCommand（exists/not_found）", async () => {
      const aTxt = `${remoteRootFs()}/a.txt`
      const exists = await execRemote(client, buildExistsCommand(aTxt, sessionKey), { timeout: 15000, sessionKey })
      if (exists.code !== 0 || exists.stdout.trim() !== "exists") throw new Error(`code=${exists.code} stdout=${JSON.stringify(exists.stdout)}`)
      const absent = await execRemote(client, buildExistsCommand(`${aTxt}.nope`, sessionKey), { timeout: 15000, sessionKey })
      if (absent.code !== 0 || absent.stdout.trim() !== "not_found") throw new Error(`code=${absent.code} stdout=${JSON.stringify(absent.stdout)}`)
    })

    // --- 20 host-load 便携命令 ---
    await check("20 host-load 便携命令（CIM）", async () => {
      const cmds = buildHostLoadCommands(sessionKey)
      for (const [label, cmd] of Object.entries(cmds)) {
        const r = await execRemote(client, cmd, { timeout: 20000, sessionKey })
        if (r.code !== 0) throw new Error(`${label} code=${r.code} stderr=${r.stderr.trim().slice(0, 200)}`)
      }
    })
  } finally {
    // 清理远端临时目录（best-effort）
    if (client && remoteRoot) {
      try {
        const kind = getCachedDialect(sessionKey)?.kind ?? "powershell"
        const cmd = kind === "cmd"
          ? `rmdir /s /q "${remoteRoot}"`
          : `Remove-Item -LiteralPath '${remoteRoot.replace(/'/g, "''")}' -Recurse -Force -ErrorAction SilentlyContinue`
        await execRemote(client, cmd, { timeout: 20000, sessionKey })
      } catch { /* best-effort */ }
    }
    rmSync(localRoot, { recursive: true, force: true })
    await close(client)
  }

  console.log(`\n===== 汇总: ${passCount} PASS / ${failCount} FAIL / ${skipCount} SKIP =====`)
  process.exitCode = failCount > 0 ? 1 : 0
}

main().catch((e) => {
  console.error(`[FATAL] ${e.message}`)
  process.exitCode = 1
})
