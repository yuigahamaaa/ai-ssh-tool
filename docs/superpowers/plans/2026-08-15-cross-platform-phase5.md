# 跨平台兼容 P5 实施计划（第三批）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 P2 探测结果 + P3/P4 Windows 方言真实接进执行链：连接成功即探测缓存，exec 主入口按 `sessionKey`（`user@host:port`）选方言，`resolveRemoteCwd` 与分号拆分方言化。

**Architecture:** `SSHConnection` 新增 `getHostId()`（基于 final hop 构造缓存键）；`gateway.connectByChain` 连接成功后 best-effort 触发 `detectAndCache`；`remoteExec`/`execRemote`/`execOnChain`/`ExecTaskManager.start`/`execScheduledStream` 增 `sessionKey` 参数并透传 `getDialect(sessionKey)`；`resolveRemoteCwd` 按 `dialect.kind` 三路构造命令并用 `isValidAbsPath` 校验；`remoteExec` 分号拆分受 `supportsSemicolonSplit` 控制。所有调用点不传 sessionKey 时仍 posix 兜底，Linux 行为零变化。

**Tech Stack:** TypeScript (ESM, node:test), ssh2。

**前置上下文（执行者必读）：**
- `getDialect(sessionKey, hint)` 已实现（P2）；三方言已落地（P3/P4）；`getDialect()` 无参恒 posix
- 执行链现状：daemon scheduler runner（`daemon.ts:247-255`）调 `execScheduledStream`，task 含 `hostId`；`handleExec`（L1009）用 `remoteExec`；`startBackground`（L272-389）与 cancel 在闭包内可直接取 `conn.getHostId()`
- `SSH_TOOL_NOHUP_PID`（`exec-task-manager.ts:316`）无生产者，删除该 fallback
- **字节红线**：不传 sessionKey 的路径产出与现状逐字节一致
- **验证环境**：`npm run build:test`；`SSH_TOOL_DATA_DIR=/tmp/ssh-tool-sync-data npm run test:fast` + `test:transfer`；mcp-server/integration 6 个存量失败与本批无关

---

## Task 1: 探测触发 + sessionKey 接线

**Files:**
- Modify: `src/remote-dialect/powershell.ts`（导出 `psQuote`）
- Modify: `src/connection.ts`（新增 `getHostId()`）
- Modify: `src/gateway.ts`（connectByChain 探测触发）
- Modify: `src/remote-shell.ts`（sessionKey 透传 + 分号拆分控制 + resolveRemoteCwd 方言化）
- Modify: `src/exec-task-manager.ts`（sessionKey + 删 NOHUP）
- Modify: `src/daemon.ts`（execScheduledStream 系列 + handleExec + startBackground）
- Modify: `src/__tests__/remote-shell.test.ts`（2 新用例）
- Modify: `src/__tests__/daemon-streaming-runner.test.ts`（1 新用例）

- [ ] **Step 1: 写失败测试**

`src/__tests__/remote-shell.test.ts` 追加两个用例（文件已有 `before/after` 重定向 SSH_TOOL_DATA_DIR 与 mock 基础设施）：

```typescript
import { clearDialectCache, putCachedDialect } from "../remote-dialect/cache.js"
```

在 `describe("remoteExec")` 内追加：

```typescript
  it("uses the dialect cached for the session key (powershell wrapper)", async () => {
    putCachedDialect("u@h:22", { kind: "powershell", sub: "powershell", detectedAt: Date.now() })
    try {
      let received = ""
      const client = createMockClient((cmd, cb) => {
        received = cmd
        const stream = createMockStream()
        cb(null, stream)
        stream.emit("close", 0)
      })
      await remoteExec(client, "echo hi", { sessionKey: "u@h:22" })
      assert.match(received, /^powershell -NoLogo -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand /)
    } finally {
      clearDialectCache()
    }
  })

  it("does not split semicolons when the dialect does not support it", async () => {
    putCachedDialect("c@h:22", { kind: "cmd", sub: "cmd", detectedAt: Date.now() })
    try {
      let execCount = 0
      const client = createMockClient((_cmd, cb) => {
        execCount++
        const stream = createMockStream()
        cb(null, stream)
        stream.emit("close", 0)
      })
      await remoteExec(client, "echo a; echo b", { sessionKey: "c@h:22" })
      assert.equal(execCount, 1)
    } finally {
      clearDialectCache()
    }
  })
```

`src/__tests__/daemon-streaming-runner.test.ts` 追加：

```typescript
import { clearDialectCache, putCachedDialect } from "../remote-dialect/cache.js"
```

在 describe 内追加：

```typescript
  it("uses the dialect for the task hostId (powershell wrapper)", async () => {
    putCachedDialect("u@h:22", { kind: "powershell", sub: "powershell", detectedAt: Date.now() })
    try {
      const client = new FakeClient()
      const resultPromise = execScheduledStream(client as any, "echo hi", 5000, undefined, undefined, undefined, "u@h:22")
      await new Promise(resolve => setImmediate(resolve))
      client.streams[0]!.emit("close", 0, undefined)
      await resultPromise
      assert.match(client.executed[0]!, /^powershell -NoLogo -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand /)
    } finally {
      clearDialectCache()
    }
  })
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npm run build:test && node --test --test-force-exit dist/__tests__/remote-shell.test.js dist/__tests__/daemon-streaming-runner.test.js`

Expected: 新用例 FAIL（当前 wrapper 是 posix 形式）→ 红灯。

- [ ] **Step 3: 方言层小改**

`src/remote-dialect/powershell.ts`：`function psQuote` → `export function psQuote`。

- [ ] **Step 4: connection.ts 加 getHostId**

```typescript
import { hostIdOf } from "./remote-dialect/cache.js"
```

在 `getFinalHost()` 后：

```typescript
  /** 目标主机的方言缓存键（user@host:port）。未连接返回空串。 */
  getHostId(): string {
    if (this.hops.length === 0) return ""
    const h = this.hops[this.hops.length - 1].host
    return hostIdOf(h.host, h.port, h.auth.username)
  }
```

- [ ] **Step 5: gateway 探测触发**

`src/gateway.ts`：

```typescript
import { detectAndCache } from "./remote-dialect/index.js"
import { log } from "./logger.js"
```

```typescript
  async connectByChain(chain: SSHConnectionChain, name?: string): Promise<SSHSession> {
    const opts: ConnectionOptions = {
      chain,
      name,
      timeout: this.config.connectionTimeout,
    }
    const session = await this.sessions.connect(opts)
    this.probeRemoteDialect(session).catch(() => {})
    return session
  }

  /** 连接成功后探测远端 shell 方言（best-effort，失败静默回退 posix，不阻塞连接）。 */
  private async probeRemoteDialect(session: SSHSession): Promise<void> {
    try {
      const connection = this.sessions.getConnection(session.id)
      if (!connection || !connection.isConnected()) return
      const host = connection.getFinalHost()
      await detectAndCache(connection.getFinalClient(), host.host, host.port, host.auth.username)
    } catch (err) {
      log("gateway", `dialect probe failed for session ${session.id.slice(0, 8)}: ${(err as Error).message}`)
    }
  }
```

- [ ] **Step 6: remote-shell.ts 接线**

`execRemote` options 类型加 `sessionKey?: string`；`killRemoteProcess(client, pid, sessionKey?)` 内 `getDialect(sessionKey).buildKill(pid)`；L157 `getDialect(options?.sessionKey).buildExec(command)`；L187 `getDialect(options?.sessionKey).pidMarkerPattern()`；L138/177/203/222 调 killRemoteProcess 处传 `options?.sessionKey`。

`remoteExec` options 加 `sessionKey?: string`；`remoteExecSingle` 的 `taskManager.start` 选项传 `sessionKey`；分号拆分：

```typescript
export async function remoteExec(
  client: Client,
  command: string,
  options?: { timeout?: number; cwd?: string; env?: Record<string, string>; host?: string; splitSemicolons?: boolean; sessionKey?: string },
): Promise<ExecResult> {
  const dialect = getDialect(options?.sessionKey)
  const split = options?.splitSemicolons !== false && dialect.supportsSemicolonSplit()
  const commands = split ? splitTopLevelSemicolonCommands(command) : [command]
  if (commands.length <= 1) return remoteExecSingle(client, command, options)
  ...
```

`execOnChain` options 加 `sessionKey` 透传。

`resolveRemoteCwd` 方言化（导出 `psQuote` 已备）：

```typescript
export async function resolveRemoteCwd(
  client: Client,
  path: string,
  baseCwd?: string,
  sessionKey?: string,
): Promise<string> {
  const dialect = getDialect(sessionKey)
  let command: string
  if (dialect.kind === "posix") {
    command = `${baseCwd ? `cd ${shellQuote(baseCwd)} && ` : ""}cd ${shellQuote(path)} && pwd -P`
  } else if (dialect.kind === "powershell") {
    command = `${baseCwd ? `Set-Location -LiteralPath ${psQuote(baseCwd)}; ` : ""}Set-Location -LiteralPath ${psQuote(path)}; (Get-Location).Path`
  } else {
    command = `${baseCwd ? `cd /d "${baseCwd}" && ` : ""}cd /d "${path}" && cd`
  }
  const result = await execRemote(client, command, { timeout: 30000, sessionKey })
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `Unable to change directory to ${path}`)
  }
  const cwd = result.stdout.replace(/\r?\n$/, "")
  if (!cwd || !dialect.isValidAbsPath(cwd)) {
    throw new Error(`Remote directory resolution returned an invalid path for ${path}`)
  }
  return cwd
}
```

`remote-shell.ts` 顶部增加 `import { psQuote } from "./remote-dialect/powershell.js"`。

- [ ] **Step 7: exec-task-manager.ts 接线**

`start` options 类型加 `sessionKey?: string`；L302 wrapper、L264/L475 kill、L323 pid 全部 `getDialect(options?.sessionKey)`；L316-317 删除 NOHUP fallback（`if (!pidMatch) pidMatch = text.match(/SSH_TOOL_NOHUP_PID:(\d+)/)` 一行删除）。

- [ ] **Step 8: daemon.ts 接线**

- `execScheduledStreamSingle(client, command, timeoutMs, onOutput?, onPid?, sessionKey?)`：L100/122/136 用 `getDialect(sessionKey)`
- `execScheduledStream(client, command, timeoutMs, onOutput?, onPid?, cwd?, sessionKey?)`：把 sessionKey 透传两个 `execScheduledStreamSingle` 调用
- scheduler runner（L252）：`execScheduledStream(client, task.command, task.timeoutMs ?? 120_000, onOutput, (pid) => { task.pid = pid }, task.effectiveCwd, task.hostId)`
- `startBackground`（L278）：`const hostId = conn.getHostId()`；L285 buildBackground、L268/L383 group kill、L335/L353 pid pattern 全部 `getDialect(hostId)`
- `handleExec`（L1009）：`remoteExec(client, command, { timeout: timeout ?? 30000, sessionKey: connection.getHostId() })`

- [ ] **Step 9: 运行测试验证通过**

Run: `npm run build:test && node --test --test-force-exit dist/__tests__/remote-shell.test.js dist/__tests__/daemon-streaming-runner.test.js`

Expected: 新旧用例全 PASS。

- [ ] **Step 10: 回归 + 提交**

Run:
```bash
SSH_TOOL_DATA_DIR=/tmp/ssh-tool-sync-data npm run test:fast
SSH_TOOL_DATA_DIR=/tmp/ssh-tool-sync-data npm run test:transfer
```
Expected: 582 + 68 全绿（不传 sessionKey 路径字节不变）。

```bash
git add src/remote-dialect/powershell.ts src/connection.ts src/gateway.ts src/remote-shell.ts src/exec-task-manager.ts src/daemon.ts src/__tests__/remote-shell.test.ts src/__tests__/daemon-streaming-runner.test.ts
git commit -m "feat: wire dialect detection into the exec chain via session key"
```

---

## 阶段验收（P5 完成定义）

1. `npm run build:test` 零错误。
2. 新用例：remote-shell（sessionKey 方言生效 + 分号不拆分）、daemon-streaming-runner（hostId 透传）全 PASS。
3. `test:fast` 582 + `test:transfer` 68 全绿。
4. `grep -n "SSH_TOOL_NOHUP" src/` 无结果。
5. `grep -rn "getDialect()" src/` 仅出现在未传 sessionKey 的兜底路径。
6. 真机（188，P0 修复后）：连接时自动探测并缓存 powershell；后续 `ssh_exec` wrapper 为 `powershell -EncodedCommand` 形式。

## 后续阶段

P6 file-transfer、P7 remote-file-tools、P8 mcp-server 工具层按方言分支适配（工具层 remoteExec 调用点补传 sessionKey）；P9 CI 三平台矩阵；P10 188 手测；P11/P12 收口。
