# 跨平台兼容 P6 实施计划（第四批）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 P5 的方言接线在工具层生效：opencode 工具（remote-tools）与文件传输（file-transfer）的所有 remoteExec 调用补传 `sessionKey`，远端探测命令（isDir/Exists/Symlink）按方言分支（PS `Test-Path` / cmd `if exist`），`lineEnding: auto` 按远端平台推断而非本机 `process.platform`。

**Architecture:** `RemoteToolContext` 增加 `sessionKey`（gateway 创建时传 `connection.getHostId()`）；file-transfer 的传输 options 增加 `sessionKey`，`remoteIsDir/remotePathExists/remoteIsSymlink` 按 `getDialect(sessionKey).kind` 三路构造探测命令，`buildTransformChain` 的 auto lineEnding 按方言（Windows→crlf）。不传 sessionKey 时行为与现状完全一致（posix）。

**Tech Stack:** TypeScript (ESM, node:test), ssh2。

**前置上下文（执行者必读）：**
- P5 已让 exec 链按 `getDialect(sessionKey)` 选方言；`getDialect()` 无参恒 posix
- 工具层现状：`remote-tools.ts` 的 `createRemoteTools(ctx)` 内工具对象多处 `remoteExec(ctx.client, ...)`（L247/255/326/347/351/388/392/422/429/471/478）；`file-transfer.ts` 的 `remoteIsDir/Exists/Symlink`（L125-152）用 POSIX `test`；`buildTransformChain`（L262-300）auto lineEnding 用 `process.platform`（L273）；调用点 L308/337/352/911/1189/1327
- **字节红线**：不传 sessionKey 的路径逐字节不变
- **验证环境**：`npm run build:test`；`SSH_TOOL_DATA_DIR=/tmp/ssh-tool-sync-data npm run test:fast` + `test:transfer`；mcp-server/integration 6 个存量失败与本批无关

---

## Task 1: 工具层 sessionKey 接线 + 探测命令方言化 + lineEnding

**Files:**
- Modify: `src/remote-tools.ts`（ctx.sessionKey + 透传）
- Modify: `src/gateway.ts`（getRemoteTools 传 sessionKey）
- Modify: `src/file-transfer.ts`（options.sessionKey + 探测命令方言分支 + lineEnding）
- Modify: `src/__tests__/remote-tools.test.ts`（sessionKey 透传用例）
- Modify: `src/__tests__/file-transfer-folder.test.ts`（探测命令方言用例）

- [ ] **Step 1: 写失败测试**

`src/__tests__/remote-tools.test.ts` 追加（复用其既有 mock）：

```typescript
import { clearDialectCache, putCachedDialect } from "../remote-dialect/cache.js"
```

在合适 describe 内追加：

```typescript
  it("passes the session key through to remoteExec so dialect selection works", async () => {
    let receivedKey: string | undefined
    const client = createMockClient((cmd, cb) => { ... }) // 依文件现有 helper
    const tools = await createRemoteTools({
      sessionId: "s",
      client,
      cwd: "/tmp",
      sessionKey: "u@h:22",
    })
    // 触发一个走 remoteExec 的工具调用，捕获其 options.sessionKey
    ...
    assert.equal(receivedKey, "u@h:22")
  })
```

`src/__tests__/file-transfer-folder.test.ts` 追加：缓存 powershell 方言后下载目录，断言远端 isDir 探测命令用 `Test-Path`（mock 捕获命令字符串）。

- [ ] **Step 2: 运行测试验证失败**

Run: `npm run build:test && node --test --test-force-exit dist/__tests__/remote-tools.test.js dist/__tests__/file-transfer-folder.test.js`

Expected: 新用例 FAIL（sessionKey 未透传 / 探测命令仍是 `test -d`）→ 红灯。

- [ ] **Step 3: remote-tools.ts + gateway.ts 接线**

`RemoteToolContext` 加 `sessionKey?: string`；工具对象内所有 `remoteExec(ctx.client, cmd, opts)` 的 opts 加 `sessionKey: ctx.sessionKey`。

`gateway.ts getRemoteTools` 的 `createRemoteTools` 调用传 `sessionKey: connection.getHostId()`。

- [ ] **Step 4: file-transfer.ts 接线**

- `FileTransferOptions`/`FolderTransferOptions` 加 `sessionKey?: string`
- 新 helper：

```typescript
function remoteDialectKind(sessionKey?: string): DialectKind {
  return getDialect(sessionKey).kind
}
```

（import `getDialect` from `./remote-dialect/index.js`、`psQuote` from `./remote-dialect/powershell.js`、`type DialectKind` from `./remote-dialect/types.js`。）

- `remoteIsDir/remotePathExists/remoteIsSymlink(client, remotePath, sessionKey?)` 按 kind 分支：

```typescript
async function remoteIsDir(client: Client, remotePath: string, sessionKey?: string): Promise<boolean> {
  try {
    const kind = getDialect(sessionKey).kind
    let cmd: string
    if (kind === "posix") {
      cmd = `test -d ${shellQuote(remotePath)} && echo "DIR" || echo "FILE"`
    } else if (kind === "powershell") {
      cmd = `if (Test-Path -LiteralPath ${psQuote(remotePath)} -PathType Container) { 'DIR' } else { 'FILE' }`
    } else {
      cmd = `if exist "${remotePath}\\" (echo DIR) else (echo FILE)`
    }
    const result = await remoteExec(client, cmd, { timeout: 5000, splitSemicolons: false, sessionKey })
    return result.stdout.trim() === "DIR"
  } catch {
    return false
  }
}
```

`remotePathExists` 用 `Test-Path -LiteralPath <p>` / `if exist "<p>"`；`remoteIsSymlink` PS 用 `if ((Get-Item -LiteralPath <p> -Force).LinkType) { 'YES' } else { 'NO' }`，cmd 用 `if exist "<p>" (echo NO) else (echo NO)`（cmd 无法可靠判软链，明示不支持，恒 NO）。

- `buildTransformChain(options)` 的 auto lineEnding：

```typescript
if (lineEnding === "auto") {
  lineEnding = remoteDialectKind(options.sessionKey) !== "posix" ? "crlf" : "lf"
}
```

- `upload/download/uploadFile/downloadFile/uploadFolder/downloadFolder` 把 `options.sessionKey` 透传到所有内部 remoteExec / remoteIsDir / remotePathExists / remoteIsSymlink / buildTransformChain 调用（L308/337/352/911/1189/1327 等）；`upload`/`download` 组装 FileTransferOptions 时带 `sessionKey`。

- [ ] **Step 5: 运行测试验证通过**

Run: `npm run build:test && node --test --test-force-exit dist/__tests__/remote-tools.test.js dist/__tests__/file-transfer-folder.test.js`

Expected: 新旧用例全 PASS。

- [ ] **Step 6: 回归 + 提交**

Run:
```bash
SSH_TOOL_DATA_DIR=/tmp/ssh-tool-sync-data npm run test:fast
SSH_TOOL_DATA_DIR=/tmp/ssh-tool-sync-data npm run test:transfer
```
Expected: 583 + 68（或含新用例数）全绿。

```bash
git add src/remote-tools.ts src/gateway.ts src/file-transfer.ts src/__tests__/remote-tools.test.ts src/__tests__/file-transfer-folder.test.ts
git commit -m "feat: pass session key to tool layer and dialect-aware remote probes"
```

---

## 阶段验收（P6 本批完成定义）

1. `npm run build:test` 零错误。
2. 新用例：remote-tools sessionKey 透传、file-transfer 探测命令方言分支全 PASS。
3. `test:fast` + `test:transfer` 全绿；不传 sessionKey 路径字节不变。
4. `grep -n "process.platform === \"win32\"" src/file-transfer.ts` 无结果（auto lineEnding 已按远端方言）。
5. 真机（188，探测=powershell）：目录/文件传输的远端探测不再用 `test -d`（PS 下 `Test-Path` 生效）。

## 后续阶段

P6b（SFTP 递归目录传输 Windows 分支 + tar GNU 选项降级）、P7（remote-file-tools 命令构造 PS 分支 + read/list/stat/grep/find）、P8（mcp-server 杂项：write_file 改 SFTP、host_load 便携命令、ssh_cd 方言化）、P9 CI 矩阵、P10 188 手测。
