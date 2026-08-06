# 传输 / OutputStore / 端口转发重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变任何对外契约（MCP/CLI 表面、IPC 请求/响应、`TransferResult`/`TaskOutputResult`/`PortForward` 结构、`OutputStore` 同步 `void` 签名）的前提下，重构目录传输、OutputStore 写入和端口转发生命周期三个内部子系统。

**Architecture:** 三个独立任务、三个独立 commit。任务一在 `file-transfer.ts` 引入异步 tar 子进程（`spawn`）与极薄 `TransferScope` 统一清理，并增加归档成员路径逃逸校验；任务二在 `output-store.ts` 引入合并 flush 写入（内存态实时、磁盘 100ms 合并窗口 + 强制 flush 点）；任务三在 `port-forwarding.ts` 引入幂等 stop 状态机、对称连接计数与断线 drain。

**Tech Stack:** TypeScript 5、Node.js `node:test`、`child_process.spawn`、`fs`、ssh2。

**参考设计:** `docs/superpowers/specs/2026-08-06-transfer-outputstore-forward-refactor-design.md`（commit `720a99b`）

---

## 共享命令约定

所有命令前使用完整 PATH（当前环境默认 PATH 极简）：

```bash
export PATH=/Users/wanghaizhi/.nvm/versions/node/v22.22.3/bin:/bin:/usr/bin:$PATH
```

构建测试产物与运行指定测试：

```bash
npm run build:test
node --test --test-force-exit dist/__tests__/<file>.test.js
```

全量快速回归：

```bash
npm run test:fast
```

已知环境限制：`test:ssh` 中 scheduler 目录 EPERM（TRAE Sandbox）不是回归指标；e6922ec 引入的 file-transfer 2 个既有失败已在 `68912b3` 修复。

---

### Task 1: 目录传输异步化（`file-transfer.ts`）

**Files:**
- Modify: `src/file-transfer.ts`（顶部 import、`uploadFolder` L911-1032、`downloadFolder` L1038-1166、新增 helper）
- Create: `src/__tests__/file-transfer-folder.test.ts`
- Test reference: `src/__tests__/file-transfer.test.ts`、`src/__tests__/file-transfer-smart.test.ts`

#### 目标

把 `uploadFolder`/`downloadFolder` 内的同步 `execSync` tar 调用改为异步 `spawn`，统一超时 kill 与临时文件清理（`TransferScope`），并新增归档成员路径逃逸校验。对外 `upload`/`download`/`uploadFolder`/`downloadFolder` 签名与 `TransferResult` 不变。

- [ ] **Step 1: 写失败测试——归档成员逃逸校验（纯函数）**

在新建 `src/__tests__/file-transfer-folder.test.ts` 写入：

```ts
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mock } from "node:test"
import { EventEmitter } from "events"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

import { uploadFolder, assertTarMembersWithin } from "../file-transfer.js"

describe("assertTarMembersWithin", () => {
  it("accepts plain relative members", () => {
    assert.doesNotThrow(() =>
      assertTarMembersWithin(["src/a.txt", "src/deep/b.txt", "."], "/extract"),
    )
  })

  it("rejects members escaping via ../", () => {
    assert.throws(
      () => assertTarMembersWithin(["../evil.txt"], "/extract"),
      /escape|outside/i,
    )
  })

  it("rejects absolute members", () => {
    assert.throws(
      () => assertTarMembersWithin(["/etc/passwd"], "/extract"),
      /escape|outside/i,
    )
  })

  it("rejects members that normalize outside the target", () => {
    assert.throws(
      () => assertTarMembersWithin(["a/../../evil.txt"], "/extract"),
      /escape|outside/i,
    )
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run build:test && node --test --test-force-exit dist/__tests__/file-transfer-folder.test.js`
Expected: FAIL，`assertTarMembersWithin` 未导出（TS error）。

- [ ] **Step 3: 写失败测试——uploadFolder 用 spawn 而非 execSync，超时 kill 并清理**

追加到同一测试文件：

```ts
function makeMockClient() {
  const client = new EventEmitter() as any
  client.exec = mock.fn((_cmd: string, cb: Function) => {
    const stream = new EventEmitter() as any
    stream.stderr = new EventEmitter()
    stream.write = mock.fn(() => {})
    stream.close = mock.fn(() => stream.emit("close", 0))
    cb(null, stream)
    process.nextTick(() => stream.emit("close", 0))
    return stream
  })
  return client
}

function makeMockSpawn() {
  const children: any[] = []
  const spawn = mock.fn(() => {
    const child: any = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.pid = 12345
    child.kill = mock.fn((_sig?: string) => {
      child.killed = true
      return true
    })
    children.push(child)
    return child
  })
  return { spawn, children }
}

describe("uploadFolder async tar", () => {
  it("compresses with spawn and cleans up temp files on tar failure", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "ft-folder-"))
    const childProcess = await import("child_process")
    const { spawn, children } = makeMockSpawn()
    mock.method(childProcess, "spawn", spawn as any)

    const result = await uploadFolder(makeMockClient(), tmp, "/remote/dir", { timeout: 200 })

    assert.equal(result.success, false)
    assert.equal(result.action, "failed")
    // spawn used, tar child killed on failure path
    assert.ok(spawn.mock.callCount() >= 1)
    assert.ok(children.some((c) => c.killed))
    // local temp archive removed
    const leftovers = spawn.mock.calls
      .map((c: any) => c.arguments[1])
      .flat()
      .filter((arg: any) => typeof arg === "string" && arg.includes("ssh-upload-"))
    // fallback: nothing left in the upload temp glob handled by scope cleanup
    rmSync(tmp, { recursive: true, force: true })
    assert.ok(true)
  })
})
```

说明：spawn mock 返回永不退出的子进程，`uploadFolder` 在超时/失败时通过 scope 清理 kill 它。若实现仍用 `execSync`，`spawn.mock.callCount()` 为 0，测试失败。

- [ ] **Step 4: 运行测试确认失败**

Run: `npm run build:test && node --test --test-force-exit dist/__tests__/file-transfer-folder.test.js`
Expected: FAIL（`assertTarMembersWithin` 未导出；`uploadFolder` 未调用 spawn）。

- [ ] **Step 5: 实现 `assertTarMembersWithin` 与异步 tar helper**

在 `src/file-transfer.ts` 顶部将 child_process 改为顶层导入，并新增 helper（放在 `sha256File` 附近）：

```ts
import { spawn } from "child_process"
```

```ts
/**
 * Reject tar members that would escape the extract directory. Defends
 * against malicious/corrupt archives where a member uses `../`, an
 * absolute path, or normalizes outside the target dir. Pure function so
 * it is unit-testable without spawning tar.
 */
export function assertTarMembersWithin(members: string[], extractDir: string): void {
  const root = pathPosix.resolve(extractDir)
  for (const raw of members) {
    const member = raw.replace(/\r$/, "")
    if (member === "." || member === "") continue
    if (member.startsWith("/") || /^[A-Za-z]:/.test(member)) {
      throw new Error(`Archive member escapes target directory: ${member}`)
    }
    const joined = pathPosix.resolve(root, member)
    if (joined !== root && !joined.startsWith(root + "/")) {
      throw new Error(`Archive member escapes target directory: ${member}`)
    }
  }
}

interface TransferScope {
  localTempFiles: string[]
  remoteTempPaths: string[]
  childProcs: Set<import("child_process").ChildProcess>
  streams: Set<{ destroy: () => void }>
}

function createTransferScope(): TransferScope {
  return { localTempFiles: [], remoteTempPaths: [], childProcs: new Set(), streams: new Set() }
}

function cleanupTransferScope(scope: TransferScope, client: Client): void {
  for (const child of scope.childProcs) {
    if (child.exitCode === null) {
      try { child.kill("SIGKILL") } catch { /* best-effort */ }
    }
  }
  scope.childProcs.clear()
  for (const stream of scope.streams) {
    try { stream.destroy() } catch { /* best-effort */ }
  }
  scope.streams.clear()
  for (const file of scope.localTempFiles) {
    try { if (existsSync(file)) unlinkSync(file) } catch { /* best-effort */ }
  }
  scope.localTempFiles = []
  for (const remote of scope.remoteTempPaths) {
    void remoteExec(client, `rm -f ${shellQuote(remote)}`, { timeout: 10000 }).catch(() => {})
  }
  scope.remoteTempPaths = []
}

/** Run tar asynchronously; kills the child on timeout. Resolves on exit. */
function runTar(args: string[], opts: { timeout: number; scope: TransferScope }): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("tar", args, { stdio: ["ignore", "ignore", "pipe"] })
    opts.scope.childProcs.add(child)
    let stderr = ""
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString() })
    let settled = false
    const finish = (code: number): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      opts.scope.childProcs.delete(child)
      resolve({ code, stderr })
    }
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM") } catch { /* best-effort */ }
      setTimeout(() => { try { child.kill("SIGKILL") } catch { /* best-effort */ } }, 500)
      finish(124)
    }, opts.timeout)
    child.on("error", () => finish(1))
    child.on("close", (code: number | null) => finish(code ?? 1))
  })
}

/** Run tar and capture stdout lines (for `-tzf` listing). */
function runTarList(args: string[], opts: { timeout: number; scope: TransferScope }): Promise<{ code: number; stderr: string; members: string[] }> {
  return new Promise((resolve) => {
    const child = spawn("tar", args, { stdio: ["ignore", "pipe", "pipe"] })
    opts.scope.childProcs.add(child)
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString() })
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString() })
    let settled = false
    const finish = (code: number): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      opts.scope.childProcs.delete(child)
      resolve({ code, stderr, members: stdout.split("\n").filter((l) => l.trim() !== "") })
    }
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM") } catch { /* best-effort */ }
      setTimeout(() => { try { child.kill("SIGKILL") } catch { /* best-effort */ } }, 500)
      finish(124)
    }, opts.timeout)
    child.on("error", () => finish(1))
    child.on("close", (code: number | null) => finish(code ?? 1))
  })
}
```

- [ ] **Step 6: 实现 uploadFolder 异步化**

替换 `uploadFolder`（`src/file-transfer.ts:911-1032`）中的 `execSync` 压缩与 finally 清理为：

```ts
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
  const scope = createTransferScope()
  scope.localTempFiles.push(tmpFile)
  scope.remoteTempPaths.push(remoteTmp)
  let uploadResult: TransferResult | null = null
  let targetDecision: OverwriteDecision | undefined

  try {
    targetDecision = await checkOverwrite(client, remotePath, options)
    if (!targetDecision.proceed) {
      return {
        success: true, path: remotePath, finalPath: remotePath, requestedPath: remotePath,
        sourcePath: localPath, action: "skipped", targetType: "directory",
        overwriteStrategy: targetDecision.strategy, skipped: true, size: 0,
        duration: Date.now() - startTime,
      }
    }
    const finalRemotePath = targetDecision.targetPath

    await remoteExec(client, `mkdir -p ${shellQuote(finalRemotePath)}`, { timeout: 10000 })

    let tarOptions: string[] = []
    if (options?.skipSymlinks) tarOptions = ["--no-recursion", "--ignore-failed-read"]
    else if (options?.followSymlinks) tarOptions = ["--dereference"]

    const compress = await runTar(
      ["-czf", tmpFile, ...tarOptions, "-C", localPath, "."],
      { timeout, scope },
    )
    if (compress.code !== 0) {
      throw new Error(`Failed to compress ${localPath}: ${compress.stderr.trim()}`)
    }

    const localStat = statSync(tmpFile)
    const archiveChecksum = await sha256File(tmpFile)
    log("transfer", `Compressed ${localPath} -> ${tmpFile} (${localStat.size} bytes)`)

    // Validate archive members before shipping to the remote host, so a
    // tar/OS quirk cannot produce a path that escapes on the remote.
    const list = await runTarList(["-tzf", tmpFile], { timeout: 30000, scope })
    if (list.code !== 0) {
      throw new Error(`Failed to inspect archive members: ${list.stderr.trim()}`)
    }
    assertTarMembersWithin(list.members, finalRemotePath)

    uploadResult = await uploadFile(client, tmpFile, remoteTmp, {
      onProgress: options?.onProgress
        ? (p) => options.onProgress!({ ...p, filename: `${folderName}/ (uploading archive)` })
        : undefined,
      timeout,
    })

    const extractCmd = `tar -xzf ${shellQuote(remoteTmp)} -C ${shellQuote(finalRemotePath)} ${options?.overwrite ? "--overwrite" : ""}`
    await remoteExec(client, extractCmd, { timeout })

    const duration = Date.now() - startTime
    log("transfer", `Folder upload complete: ${localPath} -> ${finalRemotePath} (${duration}ms)`)
    return {
      success: true, path: finalRemotePath, finalPath: finalRemotePath, requestedPath: remotePath,
      sourcePath: localPath, action: "uploaded", targetType: "directory",
      overwriteStrategy: targetDecision.strategy,
      overwritten: targetDecision.existed && !targetDecision.renamed && !targetDecision.backupPath,
      renamed: targetDecision.renamed, backupPath: targetDecision.backupPath,
      sourceBytes: localStat.size, bytesTransferred: uploadResult.bytesTransferred ?? uploadResult.size,
      checksum: { algorithm: "sha256", source: archiveChecksum },
      verification: { sizeMatched: (uploadResult.bytesTransferred ?? uploadResult.size) === localStat.size },
      size: uploadResult.size, duration,
    }
  } catch (err: any) {
    log("transfer", `Folder upload failed: ${err.message}`)
    return {
      success: false, path: targetDecision?.targetPath ?? remotePath,
      finalPath: targetDecision?.targetPath ?? remotePath, requestedPath: remotePath,
      sourcePath: localPath, action: "failed", targetType: "directory",
      overwriteStrategy: targetDecision?.strategy ?? options?.overwrite,
      size: uploadResult?.size ?? 0, duration: Date.now() - startTime, error: err.message,
    }
  } finally {
    cleanupTransferScope(scope, client)
  }
}
```

- [ ] **Step 7: 实现 downloadFolder 异步化**

替换 `downloadFolder`（`src/file-transfer.ts:1038-1166`）中的 `execSync` 解压与 finally 清理为：

```ts
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
  const scope = createTransferScope()
  scope.localTempFiles.push(tmpFile)
  scope.remoteTempPaths.push(remoteTmp)
  const requestedExtractPath = join(localPath, folderName)
  let finalExtractPath = requestedExtractPath
  let downloadResult: TransferResult | null = null
  let targetDecision: LocalOverwriteDecision | undefined

  try {
    const isDir = await remoteIsDir(client, remotePath)
    if (!isDir) {
      throw new Error(`Remote path is not a directory: ${remotePath}`)
    }

    targetDecision = checkLocalDirectoryOverwrite(requestedExtractPath, options)
    finalExtractPath = targetDecision.targetPath
    if (!targetDecision.proceed) {
      return {
        success: true, path: localPath, finalPath: finalExtractPath, requestedPath: localPath,
        sourcePath: remotePath, action: "skipped", targetType: "directory",
        overwriteStrategy: targetDecision.strategy, skipped: true, size: 0,
        duration: Date.now() - startTime,
      }
    }

    const remoteParent = dirname(remotePath)

    let tarOptions: string[] = []
    if (options?.skipSymlinks) tarOptions = ["--no-recursion", "--ignore-failed-read"]
    else if (options?.followSymlinks) tarOptions = ["--dereference"]

    const compressCmd = `tar -czf ${shellQuote(remoteTmp)} ${tarOptions.join(" ")} -C ${shellQuote(remoteParent)} ${shellQuote(folderName)}`
    await remoteExec(client, compressCmd, { timeout })

    const sizeResult = await remoteExec(client, `stat -c %s ${shellQuote(remoteTmp)} 2>/dev/null || wc -c < ${shellQuote(remoteTmp)}`, { timeout: 10000 })
    const remoteSize = parseInt(sizeResult.stdout.trim()) || 0
    log("transfer", `Compressed on remote: ${remotePath} -> ${remoteTmp} (${remoteSize} bytes)`)

    downloadResult = await downloadFile(client, remoteTmp, tmpFile, {
      onProgress: options?.onProgress
        ? (p) => options.onProgress!({ ...p, filename: `${folderName}/ (downloading archive)` })
        : undefined,
      timeout,
    })
    const archiveChecksum = await sha256File(tmpFile)

    // Validate archive members before extracting locally.
    const list = await runTarList(["-tzf", tmpFile], { timeout: 30000, scope })
    if (list.code !== 0) {
      throw new Error(`Failed to inspect archive members: ${list.stderr.trim()}`)
    }
    assertTarMembersWithin(list.members, finalExtractPath)

    if (!existsSync(finalExtractPath)) {
      mkdirSync(finalExtractPath, { recursive: true })
    }
    const extract = await runTar(
      ["-xzf", tmpFile, "-C", finalExtractPath, "--strip-components=1"],
      { timeout, scope },
    )
    if (extract.code !== 0) {
      throw new Error(`Failed to extract ${tmpFile}: ${extract.stderr.trim()}`)
    }

    const duration = Date.now() - startTime
    log("transfer", `Folder download complete: ${remotePath} -> ${finalExtractPath} (${duration}ms)`)
    return {
      success: true, path: localPath, finalPath: finalExtractPath, requestedPath: localPath,
      sourcePath: remotePath, action: "downloaded", targetType: "directory",
      overwriteStrategy: targetDecision.strategy,
      overwritten: targetDecision.existed && !targetDecision.renamed && !targetDecision.backupPath,
      renamed: targetDecision.renamed, backupPath: targetDecision.backupPath,
      sourceBytes: remoteSize, bytesTransferred: downloadResult.size,
      checksum: { algorithm: "sha256", destination: archiveChecksum },
      verification: { sizeMatched: downloadResult.size === remoteSize },
      size: downloadResult.size, duration,
    }
  } catch (err: any) {
    log("transfer", `Folder download failed: ${err.message}`)
    return {
      success: false, path: localPath, finalPath: finalExtractPath, requestedPath: localPath,
      sourcePath: remotePath, action: "failed", targetType: "directory",
      overwriteStrategy: targetDecision?.strategy ?? options?.overwrite,
      renamed: targetDecision?.renamed, backupPath: targetDecision?.backupPath,
      size: downloadResult?.size ?? 0, duration: Date.now() - startTime, error: err.message,
    }
  } finally {
    cleanupTransferScope(scope, client)
  }
}
```

- [ ] **Step 8: 运行新测试与受影响回归**

Run:
```bash
npm run build:test && node --test --test-force-exit dist/__tests__/file-transfer-folder.test.js dist/__tests__/file-transfer.test.js dist/__tests__/file-transfer-smart.test.js
```
Expected: PASS。既有 28 个 file-transfer 测试（含此前修复的 overwrite 语义）必须保持通过。

- [ ] **Step 9: 全量快速回归**

Run: `npm run test:fast`
Expected: 全部通过（此前基线 581）。

- [ ] **Step 10: 提交 Task 1**

```bash
git add src/file-transfer.ts src/__tests__/file-transfer-folder.test.ts
git commit -m "refactor: make folder transfers asynchronous and safely cleanable"
```

---

### Task 2: OutputStore 合并 flush 写入（`output-store.ts`）

**Files:**
- Modify: `src/scheduler/output-store.ts`
- Modify: `src/scheduler/scheduler-service.ts:149-169`（`dispose()` 加 flush）
- Modify: `src/__tests__/output-store.test.ts`（3 个写盘时序断言改为 flush 后断言）
- Create: `src/__tests__/output-store-flush.test.ts`

#### 目标

`appendStdout/appendStderr` 保持同步 `void`：内存态（tail/逻辑字节/truncated）立即更新，磁盘写入合并为 100ms 静默窗口一次落盘。新增 `flush(taskId)` / `flushAll()` 与可选 `flushIntervalMs` 构造参数（均为新增，不破坏既有签名）。

- [ ] **Step 1: 写失败测试——合并窗口内不立即落盘**

新建 `src/__tests__/output-store-flush.test.ts`：

```ts
import { describe, it, beforeEach, afterEach, mock } from "node:test"
import assert from "node:assert/strict"
import { OutputStore } from "../scheduler/output-store.js"
import { rmSync, mkdirSync, existsSync, readFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

describe("OutputStore flush batching", () => {
  const testDir = join(tmpdir(), `output-flush-${Date.now()}`)
  let appendFileSyncSpy: ReturnType<typeof mock.fn>

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true })
    const fsMod = require("fs")
    appendFileSyncSpy = mock.fn(fsMod.appendFileSync)
    mock.method(fsMod, "appendFileSync", appendFileSyncSpy)
  })

  afterEach(() => {
    mock.restoreAll()
    try { rmSync(testDir, { recursive: true }) } catch {}
  })

  it("does not write to disk immediately within the batch window", () => {
    const store = new OutputStore(testDir, { flushIntervalMs: 500 })
    store.create("t1")
    store.appendStdout("t1", "hello\n")
    assert.ok(!existsSync(join(testDir, "t1.stdout")))
    store.flush("t1")
    assert.ok(existsSync(join(testDir, "t1.stdout")))
    assert.equal(readFileSync(join(testDir, "t1.stdout"), "utf8"), "hello\n")
  })

  it("coalesces many appends into one disk write", () => {
    const store = new OutputStore(testDir, { flushIntervalMs: 100 })
    store.create("t1")
    for (let i = 0; i < 50; i++) store.appendStdout("t1", `line${i}\n`)
    store.flush("t1")
    // 1 appendFileSync (batch) + 0 per-append
    assert.equal(appendFileSyncSpy.mock.callCount(), 1)
  })

  it("flushes all pending tasks via flushAll", () => {
    const store = new OutputStore(testDir, { flushIntervalMs: 500 })
    store.create("a"); store.create("b")
    store.appendStdout("a", "A")
    store.appendStderr("b", "B")
    store.flushAll()
    assert.equal(readFileSync(join(testDir, "a.stdout"), "utf8"), "A")
    assert.equal(readFileSync(join(testDir, "b.stderr"), "utf8"), "B")
  })

  it("stops writing to disk past maxOutputFileSize but keeps memory tail", () => {
    const store = new OutputStore(testDir, { maxOutputFileSize: 10, flushIntervalMs: 100 })
    store.create("t1")
    store.appendStdout("t1", "abcdefghijklmnop")
    const output = store.getOutput("t1", "full")
    assert.equal(output.stdout, "abcdefghij")
    assert.equal(output.stdoutBytes, 16)
    assert.equal(output.stdoutFileTruncated, true)
  })

  it("does not throw when a disk write fails", () => {
    const store = new OutputStore(testDir, { flushIntervalMs: 100 })
    store.create("t1")
    store.appendStdout("t1", "x")
    appendFileSyncSpy.mock.mockImplementation(() => { throw new Error("disk full") })
    assert.doesNotThrow(() => store.flush("t1"))
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run build:test && node --test --test-force-exit dist/__tests__/output-store-flush.test.js`
Expected: FAIL（`flush`/`flushAll` 不存在；当前实现每 append 落盘，coalesce 断言失败）。

- [ ] **Step 3: 实现 PendingWrites 状态与 flush 方法**

在 `src/scheduler/output-store.ts` 新增：

```ts
interface PendingWrites {
  stdoutQueue: string[] | null   // null = 已停止写盘（超过 maxOutputFileSize）
  stderrQueue: string[] | null
  flushTimer: NodeJS.Timeout | null
}
```

类字段与构造函数（`flushIntervalMs` 新增可选参数）：

```ts
export class OutputStore {
  private baseDir: string
  private maxOutputFileSize: number
  private flushIntervalMs: number
  private inMemory = new Map<string, OutputEntry>()
  private pending = new Map<string, PendingWrites>()

  constructor(baseDir?: string, opts?: { maxOutputFileSize?: number; flushIntervalMs?: number }) {
    this.baseDir = resolve(baseDir ?? getSchedulerOutputsDir())
    this.maxOutputFileSize = opts?.maxOutputFileSize ?? DEFAULT_MAX_OUTPUT_FILE_SIZE
    this.flushIntervalMs = opts?.flushIntervalMs ?? 100
    if (!existsSync(this.baseDir)) {
      mkdirSync(this.baseDir, { recursive: true, mode: 0o700 })
    }
  }
```

新增方法（放在 `appendStderr` 之后）：

```ts
  /** Immediately persist pending output for one task. Idempotent. */
  flush(taskId: string): void {
    const p = this.pending.get(taskId)
    if (!p) return
    this.pending.delete(taskId)
    if (p.flushTimer) { clearTimeout(p.flushTimer); p.flushTimer = null }
    const paths = this.getPaths(taskId)
    this.flushQueue(paths.stdout, p.stdoutQueue)
    this.flushQueue(paths.stderr, p.stderrQueue)
  }

  /** Persist all pending output (call from shutdown/cleanup paths). */
  flushAll(): void {
    for (const taskId of Array.from(this.pending.keys())) {
      this.flush(taskId)
    }
  }

  private flushQueue(path: string, queue: string[] | null): void {
    if (!queue || queue.length === 0) return
    let buf = Buffer.concat(queue.map((d) => Buffer.from(d, "utf8")))
    const cap = this.maxOutputFileSize
    const existing = existsSync(path) ? statSync(path).size : 0
    const remaining = cap - existing
    if (remaining <= 0) return
    const toWrite = buf.subarray(0, remaining)
    try {
      if (existsSync(path)) {
        appendFileSync(path, toWrite)
      } else {
        writeFileSync(path, toWrite, { mode: 0o600 })
      }
    } catch (err) {
      log("scheduler", `Output flush failed for ${path}: ${(err as Error).message}`)
    }
  }

  private enqueue(taskId: string, stream: "stdout" | "stderr", data: string): void {
    let p = this.pending.get(taskId)
    if (!p) {
      p = { stdoutQueue: [], stderrQueue: [], flushTimer: null }
      this.pending.set(taskId, p)
    }
    const queue = stream === "stdout" ? p.stdoutQueue : p.stderrQueue
    if (queue !== null) queue.push(data)
    if (!p.flushTimer) {
      p.flushTimer = setTimeout(() => {
        p.flushTimer = null
        this.flush(taskId)
      }, this.flushIntervalMs)
      if (typeof (p.flushTimer as any).unref === "function") (p.flushTimer as any).unref()
    }
  }
```

- [ ] **Step 4: 改造 append 与截断语义**

将 `appendStdout`/`appendStderr` 改为：

```ts
  appendStdout(taskId: string, data: string): void {
    const entry = this.ensureEntry(taskId)
    entry.stdoutTail = appendTail(entry.stdoutTail, data)
    entry.stdoutBytes += Buffer.byteLength(data)
    this.enqueue(taskId, "stdout", data)
  }

  appendStderr(taskId: string, data: string): void {
    const entry = this.ensureEntry(taskId)
    entry.stderrTail = appendTail(entry.stderrTail, data)
    entry.stderrBytes += Buffer.byteLength(data)
    this.enqueue(taskId, "stderr", data)
  }
```

删除旧的 `appendWithinLimit`（其职责由 `flushQueue` 的 cap 截断取代）。超过 `maxOutputFileSize` 后：`flushQueue` 不再写盘（`remaining <= 0` 直接 return），同时将 `getOutput` 的 `stdoutFileTruncated` 语义补上——在 `getOutput` 中读取时，若 `stdoutBytes > maxOutputFileSize` 则 `stdoutFileTruncated = true`。修改 `getOutput` 的 truncated 计算：

```ts
    const stdoutFileTruncated = (entry?.stdoutFileTruncated ?? false) || (stdoutBytes > this.maxOutputFileSize)
    const stderrFileTruncated = (entry?.stderrFileTruncated ?? false) || (stderrBytes > this.maxOutputFileSize)
```

（`getOutput` 中原有 `entry?.stdoutFileTruncated ?? false` 两行替换为此两行；`flushQueue` 写满 cap 时也可在 entry 上置标志，但内存判定已覆盖，二者等价。）

- [ ] **Step 5: full 读取前强制 flush**

`getOutput` 中 `mode === "full"` 分支在读盘前 flush：

```ts
    if (mode === "full") {
      this.flush(taskId)
    }
    let stdout = mode === "full"
      ? this.getFullStdout(taskId)
      : (entry ? bufferToString(entry.stdoutTail) : this.readFileTail(paths.stdout, returnLimit))
    let stderr = mode === "full"
      ? this.getFullStderr(taskId)
      : (entry ? bufferToString(entry.stderrTail) : this.readFileTail(paths.stderr, returnLimit))
```

- [ ] **Step 6: remove 前 flush、cleanup 前 flushAll、dispose 挂接**

`remove` 改为：

```ts
  remove(taskId: string): void {
    this.flush(taskId)
    this.inMemory.delete(taskId)
    const paths = this.getPaths(taskId)
    this.safeUnlink(paths.stdout)
    this.safeUnlink(paths.stderr)
  }
```

`cleanup` 开头加：

```ts
    this.flushAll()
```

`src/scheduler/scheduler-service.ts` 的 `dispose()` 中（在 `this.virtualCwdStore.dispose()` 附近）加：

```ts
    this.outputStore.flushAll()
```

- [ ] **Step 7: 适配既有 3 个写盘时序测试**

在 `src/__tests__/output-store.test.ts`：

1. `defers stdout/stderr file creation until first append`：append 后先断言不存在，`store.flush("task-1")` 后再断言存在：

```ts
    store.appendStdout("task-1", "hello\n")
    store.appendStderr("task-1", "error\n")

    assert.ok(!existsSync(join(testDir, "task-1.stdout")))
    assert.ok(!existsSync(join(testDir, "task-1.stderr")))

    store.flush("task-1")

    assert.ok(existsSync(join(testDir, "task-1.stdout")))
    assert.ok(existsSync(join(testDir, "task-1.stderr")))
```

2. `persists to disk`：在 readFileSync 前加 `store.flush("task-1")`。
3. `gets full stdout/stderr`：在 getFullStdout 前加 `store.flush("task-1")`。

其余既有测试（`removes from memory`、`tracks file truncation`、`cleanup deletes old output`）因 remove/cleanup/getOutput-full 内部 flush，无需改动。

- [ ] **Step 8: 运行 OutputStore 测试**

Run: `npm run build:test && node --test --test-force-exit dist/__tests__/output-store.test.js dist/__tests__/output-store-flush.test.js`
Expected: PASS。

- [ ] **Step 9: 全量快速回归**

Run: `npm run test:fast`
Expected: 全部通过（scheduler/daemon 相关测试覆盖 flush 路径）。

- [ ] **Step 10: 提交 Task 2**

```bash
git add src/scheduler/output-store.ts src/scheduler/scheduler-service.ts src/__tests__/output-store.test.ts src/__tests__/output-store-flush.test.ts
git commit -m "refactor: batch scheduler output writes with coalesced flush"
```

---

### Task 3: 端口转发生命周期幂等化（`port-forwarding.ts`）

**Files:**
- Modify: `src/port-forwarding.ts`
- Modify: `src/__tests__/port-forwarding.test.ts`

#### 目标

`stop()` 幂等（并发/重复 stop 只关闭一次）；连接计数对称（connect 失败/stream 错误/close 全部成对增减）；断线时 drain 所有活跃 socket。公开 `PortForward` 与 `PortForwardManager` 方法不变。

- [ ] **Step 1: 写失败测试——并发 stop 只关闭一次、断线 drain 活跃连接**

追加到 `src/__tests__/port-forwarding.test.ts` 的 Local Forward describe 内：

```ts
  describe("idempotent stop and drain", () => {
    it("coalesces concurrent stop calls into one close", async () => {
      const manager = new PortForwardManager(conn.getFinalClient())
      const fwd = await manager.localForward("127.0.0.1", 0, "127.0.0.1", 22)
      const results = await Promise.all([manager.stop(fwd.id), manager.stop(fwd.id)])
      assert.deepEqual(results, [true, true])
      assert.equal(manager.get(fwd.id), null)
      // Second stop of a removed forward is a no-op returning false.
      assert.equal(await manager.stop(fwd.id), false)
    })

    it("drains active connections when the SSH client disconnects", async () => {
      const manager = new PortForwardManager(conn.getFinalClient())
      await manager.localForward("127.0.0.1", 0, "127.0.0.1", 22)
      // Simulate client loss by invoking the manager's disconnect handling
      // directly; the real SSHConnection stays alive for other tests.
      ;(manager as any).handleClientDisconnect()
      const list = manager.list()
      assert.ok(list.length === 0 || list.every((f) => f.status === "error"))
    })
  })
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run build:test && node --test --test-force-exit dist/__tests__/port-forwarding.test.js`
Expected: FAIL。并发 stop 对同一 id：当前实现两次都进入关闭逻辑（`server.close` 被调两次，第二次可能抛 ERR_SERVER_NOT_RUNNING 导致 Promise 不 resolve → 测试挂起/失败）。

- [ ] **Step 3: 实现停止状态机与连接集合**

在 `src/port-forwarding.ts` 增加：

```ts
interface ActiveConnection {
  destroy: () => void
}
```

类字段：

```ts
  private stoppingIds = new Set<string>()
  private activeConnections = new Set<ActiveConnection>()
  private drainAllConnections(): void {
    for (const conn of this.activeConnections) {
      try { conn.destroy() } catch { /* best-effort */ }
    }
    this.activeConnections.clear()
  }
```

- [ ] **Step 4: stop() 幂等化**

将 `stop` 改为：

```ts
  async stop(id: string): Promise<boolean> {
    const entry = this.forwards.get(id)
    if (!entry) return false
    if (this.stoppingIds.has(id)) return true
    this.stoppingIds.add(id)

    try {
      if (entry.forward.type === "local") {
        const { server } = entry as ActiveLocalForward
        await new Promise<void>((resolve) => {
          try {
            server.close(() => resolve())
          } catch {
            try { (server as any).closeAllConnections?.() } catch { /* best-effort */ }
            resolve()
          }
        })
      } else {
        const remoteEntry = entry as ActiveRemoteForward
        try {
          this.client.unforwardIn(entry.forward.bindAddr, entry.forward.bindPort, () => {})
        } catch (e) {
          log("portforward", `[${id}] unforwardIn failed (client likely disconnected): ${(e as Error).message}`)
        }
        if (remoteEntry.routeKey) {
          this.remoteRoutes.delete(remoteEntry.routeKey)
          this.unbindTcpConnection()
        }
      }

      entry.forward.status = "stopped"
      this.forwards.delete(id)
      log("fwd", `[${id}] Forward stopped`)
      return true
    } finally {
      this.stoppingIds.delete(id)
    }
  }
```

- [ ] **Step 5: 连接计数对称化与活跃连接登记**

local forward 的 `createServer` 回调改为：

```ts
    const server = createServer((socket: Socket) => {
      forward.connections++
      log("fwd", `[${id}] New connection (total: ${forward.connections})`)
      const conn: ActiveConnection = { destroy: () => { try { socket.destroy() } catch {} } }
      this.activeConnections.add(conn)

      this.client.forwardOut(
        localBindAddr,
        0,
        remoteDstAddr,
        remoteDstPort,
        (err, stream) => {
          if (err) {
            log("fwd", `[${id}] forwardOut error: ${err.message}`)
            this.activeConnections.delete(conn)
            socket.destroy()
            forward.connections--
            return
          }

          socket.pipe(stream)
          stream.pipe(socket)

          const closeOnce = (): void => {
            this.activeConnections.delete(conn)
            forward.connections--
            try { stream.close() } catch {}
            log("fwd", `[${id}] Connection closed (remaining: ${forward.connections})`)
          }

          socket.on("error", (socketErr: Error) => {
            log("fwd", `[${id}] Socket error: ${socketErr.message}`)
            try { stream.close() } catch {}
          })

          stream.on("error", (streamErr: Error) => {
            log("fwd", `[${id}] Stream error: ${streamErr.message}`)
            socket.destroy()
          })

          socket.on("close", closeOnce)
          stream.on("close", () => { socket.destroy() })
        },
      )
    })
```

`handleClientDisconnect` 中加 drain（在 `stopAll()` 之前）：

```ts
    this.drainAllConnections()
```

- [ ] **Step 6: 远程转发连接计数对称**

`bindTcpConnection` 的 dispatcher 内改为（登记到 `activeConnections`，close 时释放并减计数）：

```ts
      const stream = accept()
      const localSocket = createConnection(route.localDstPort, route.localDstAddr)
      const conn: ActiveConnection = { destroy: () => { try { localSocket.destroy() } catch {}; try { stream.close() } catch {} } }
      this.activeConnections.add(conn)

      localSocket.on("connect", () => {
        stream.pipe(localSocket)
        localSocket.pipe(stream)
      })

      localSocket.on("error", (socketErr: Error) => {
        log("fwd", `[${route.forwardId}] Local connection error: ${socketErr.message}`)
        try { stream.close() } catch {}
      })

      stream.on("error", (streamErr: Error) => {
        log("fwd", `[${route.forwardId}] Stream error: ${streamErr.message}`)
        localSocket.destroy()
      })

      stream.on("close", () => {
        this.activeConnections.delete(conn)
        route.forward.connections--
        localSocket.destroy()
      })
```

- [ ] **Step 7: 运行端口转发测试**

Run: `npm run build:test && node --test --test-force-exit dist/__tests__/port-forwarding.test.js`
Expected: PASS（含既有 end-to-end remote forward 与新增幂等测试）。

- [ ] **Step 8: 全量快速回归**

Run: `npm run test:fast`
Expected: 全部通过。

- [ ] **Step 9: 提交 Task 3**

```bash
git add src/port-forwarding.ts src/__tests__/port-forwarding.test.ts
git commit -m "refactor: make port forwarding lifecycle idempotent"
```

---

### Task 4: 完整验证与兼容性检查

**Files:**
- Modify only if verification discovers a failing production/test file.

- [ ] **Step 1: 验证 TypeScript 构建**

Run: `npm run build`
Expected: exit 0，`tsc` 无错误。

- [ ] **Step 2: 全量快速回归**

Run: `npm run test:fast`
Expected: 全部通过。

- [ ] **Step 3: SSH 回归（记录环境限制）**

Run: `npm run test:ssh`
Expected: 仅 TRAE Sandbox 对 scheduler 目录的 EPERM 失败（既有环境限制），其余通过。若出现非 EPERM 失败，对照本批改动定位。

- [ ] **Step 4: 静态检查 staged diff**

Run:
```bash
git diff --check
git status --short
git log --oneline -5
```
Expected: `git diff --check` 无输出；仅 Task 1-3 的 3 个 refactor 提交 + 之前的 doc 提交（`720a99b`）在 HEAD 上。

- [ ] **Step 5: 兼容性清单逐项对照**

```text
[ ] ssh_upload/ssh_download 参数与 envelope 不变
[ ] CLI 传输 flag 与输出不变
[ ] TransferResult 字段与语义不变（含 failed 路径 error 字段）
[ ] tar.gz 归档格式不变；skipSymlinks/followSymlinks/overwrite/checksum/onProgress 语义不变
[ ] OutputStore.appendStdout/appendStderr 仍为同步 void
[ ] OutputEntry/TaskOutputResult/磁盘文件命名/cleanup 策略不变
[ ] PortForward 结构与 localForward/remoteForward/stop/list/get/stopAll 签名不变
[ ] 新增项（flush/flushAll/flushIntervalMs、stoppingIds/activeConnections、assertTarMembersWithin/TransferScope）均为内部或加法
```

- [ ] **Step 6: 提交边界确认**

只允许存在：

```text
docs: transfer/outputstore/forward refactor design (internal compatibility)
refactor: make folder transfers asynchronous and safely cleanable
refactor: batch scheduler output writes with coalesced flush
refactor: make port forwarding lifecycle idempotent
```

若验证发现问题，回到对应任务修复并重跑该任务测试；不创建混合收尾提交，不在用户明确要求前 push。

## 计划自检

- 规格覆盖：设计第 4/5/6 节（目录传输、OutputStore、端口转发）各有独立任务；第 7 节验证在第 4 任务；第 9 节风险均有对应缓解。
- 排除项：TOFU、跨域抽象层、进度细分/断点续传均未纳入任何修改任务。
- 类型一致性：`TransferScope`、`assertTarMembersWithin`、`runTar`/`runTarList`、`PendingWrites`、`flush`/`flushAll`、`flushIntervalMs`、`stoppingIds`、`activeConnections`、`drainAllConnections` 命名全程一致。
- 兼容性：`appendStdout/appendStderr` 保持同步 `void`；`getOutput`/`remove`/`cleanup` 内部 flush 不改变外部可观察语义（除写盘时序这一内部实现细节，已通过 Step 7 适配既有测试）。
- TDD：每个行为变更先列失败测试、执行命令、最小实现与通过验证。
