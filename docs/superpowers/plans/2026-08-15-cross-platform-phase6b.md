# 跨平台兼容 P6b 实施计划（第四批续）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐 Phase 6 剩余项：远端 backup `mv`/`rm` 方言化（盲区 8）、目录传输的 Windows 分支（SFTP 递归替代 tar，盲区 7）、POSIX 侧 tar GNU 长选项探测降级、`/tmp` 硬编码按远端临时目录（盲区 21 余项）。

**Architecture:** 传输探测已在 P6 完成方言化。本批把 file-transfer 的目录传输拆成两条链：`posix` 保留 tar 链（带 GNU 选项降级），`powershell`/`cmd` 走纯 SFTP 递归（mkdir + 逐文件 put/get，复用现有 uploadFile/downloadFile 的文件级逻辑）。`checkOverwrite` backup 分支的 `mv` 按方言构造。

**Tech Stack:** TypeScript (ESM, node:test), ssh2。

**前置上下文（执行者必读）：**
- P6 已交付：`sessionKey` 透传 + 探测三函数方言化 + lineEnding auto 按远端（commit `d3cc884`）
- `uploadFolder`（L1059+）/`downloadFolder`（L1167+）目前整链走 tar：本地压缩→上传→远端 `tar -xzf`；远端 `tar -I gzip -N -cf`→下载→本地解压
- 远端临时文件 `remoteTmp = "/tmp/ssh-..."` 硬编码（L1075/L1178）
- `checkOverwrite` backup 分支 `mv`（L355）已带 sessionKey 但命令本身仍 posix
- **字节红线**：不传 sessionKey 的路径逐字节不变
- **验证环境**：`npm run build:test`；`SSH_TOOL_DATA_DIR=/tmp/ssh-tool-sync-data npm run test:fast` + `test:transfer`；mcp-server/integration 6 个存量失败与本批无关

---

## Task 1: 远端 mv/rm 方言化 + 临时目录探测

**Files:**
- Modify: `src/file-transfer.ts`
- Modify: `src/__tests__/file-transfer.test.ts`

- [ ] **Step 1: 写失败测试**

`file-transfer.test.ts` 追加：缓存 powershell 方言后上传覆盖已存在文件且 `overwrite: "backup"`，断言 server 收到的 exec 命令解码后含 `Move-Item -LiteralPath` 而非 `mv`（复用 `decodePsEncodedCommand` helper）。

- [ ] **Step 2: 运行测试验证失败**

Run: `npm run build:test && node --test --test-force-exit dist/__tests__/file-transfer.test.js`

Expected: 新用例 FAIL → 红灯。

- [ ] **Step 3: 实现**

`file-transfer.ts` 新增 helper：

```typescript
function remoteMoveCommand(src: string, dst: string, sessionKey?: string): string {
  const kind = getDialect(sessionKey).kind
  if (kind === "powershell") return `Move-Item -LiteralPath ${psQuote(src)} -Destination ${psQuote(dst)}`
  if (kind === "cmd") return `move /Y "${src}" "${dst}"`
  return `mv ${shellQuote(src)} ${shellQuote(dst)}`
}
```

`checkOverwrite` backup 分支改用 `remoteMoveCommand(remotePath, backupPath, options?.sessionKey)`。

远端临时目录探测（`uploadFolder`/`downloadFolder` 用，posix 才需要，非 posix 走 SFTP 分支不产生 remoteTmp）：

```typescript
function remoteTempDir(sessionKey?: string): string {
  return getDialect(sessionKey).kind === "posix" ? "/tmp" : "."
}
```

（SFTP 分支不需要远端临时文件，`"."` 仅为类型占位；posix 保持 `/tmp` 现状。）

- [ ] **Step 4: 运行测试验证通过**

Run: `npm run build:test && node --test --test-force-exit dist/__tests__/file-transfer.test.js`

Expected: 新旧用例全 PASS。

- [ ] **Step 5: 回归 + 提交**

```bash
SSH_TOOL_DATA_DIR=/tmp/ssh-tool-sync-data npm run test:fast
SSH_TOOL_DATA_DIR=/tmp/ssh-tool-sync-data npm run test:transfer
git add src/file-transfer.ts src/__tests__/file-transfer.test.ts
git commit -m "feat: dialect-aware remote move and temp dir for transfers"
```

---

## Task 2: 目录传输 Windows 分支（SFTP 递归） + POSIX tar 降级

**Files:**
- Modify: `src/file-transfer.ts`
- Modify: `src/__tests__/file-transfer-folder.test.ts`

- [ ] **Step 1: 写失败测试**

`file-transfer-folder.test.ts` 追加：缓存 `cmd`（或 powershell）方言后 `uploadFolder`/`downloadFolder` round-trip，断言：
1. 成功返回（progress 有回调）；
2. server 收到的 exec 命令里**不含** `tar`（未走 tar 链）；
3. 远端 SFTP 收到递归 mkdir（`mkdir`）与文件 `write`/`read` 调用。

用 `putCachedDialect("u@h:22", { kind: "cmd", ... })`，传输 options 传 `sessionKey: "u@h:22"`。

- [ ] **Step 2: 运行测试验证失败**

Run: `npm run build:test && node --test --test-force-exit dist/__tests__/file-transfer-folder.test.js`

Expected: 新用例 FAIL（当前仍走 tar）→ 红灯。

- [ ] **Step 3: 实现 SFTP 递归**

新增两个内部函数（均返回 `TransferResult` 语义的进度回调可选项）：

```typescript
/** SFTP 递归上传：本地目录 → 远端目录（逐文件 put），供非 posix 方言使用。 */
async function uploadFolderSftp(client, localPath, remotePath, options): Promise<TransferResult>

/** SFTP 递归下载：远端目录 → 本地目录（readdir + 逐文件 get），供非 posix 方言使用。 */
async function downloadFolderSftp(client, remotePath, localPath, options): Promise<TransferResult>
```

实现要点：
- 目录枚举：上传用本地 `readdirSync` 递归（`withFileTypes`），跳过 `skipSymlinks` 的软链 / `followSymlinks` 时解引用；下载用 SFTP `readdir` 递归，`entry.attrs.isDirectory()` 分支，`skipSymlinks` 时跳过 `isSymbolicLink()`。
- 远端 mkdir：`sftp.mkdir(remoteDir, { recursive: true })`（ssh2 支持 recursive）；逐文件用 `sftp.fastPut`（大文件）/ `sftp.writeFile`（小文件，按 `fileSizeThreshold`）；下载用 `sftp.fastGet` / `sftp.readFile`。
- 相对路径映射：上传 `posix(relPath).replace(/\\/g, "/")` join 远端根；下载 `join(本地根, relPath.split("/").join(sep))`，`mkdirSync(dirname, { recursive: true })`。
- overwrite/lineEnding/encoding：文件级逻辑复用现有 `uploadFile`/`downloadFile`（它们已带 sessionKey 透传）——SFTP 分支内逐文件调用这两个函数而非裸 SFTP 写入，保证转码/校验/进度行为一致；skipSymlinks 在遍历层处理。
- 进度：`onProgress` 按 `{ filename: relPath, transferred, total, percent }` 汇总字节。
- 失败：任一文件失败即 throw（与 tar 链行为一致），scope 清理本地已写文件（复用 `createTransferScope`）。

`uploadFolder`/`downloadFolder` 入口按方言分流：

```typescript
const kind = getDialect(options?.sessionKey).kind
if (kind !== "posix") return kind === "powershell" || kind === "cmd"
  ? uploadFolderSftp(...)  // 或 downloadFolderSftp(...)
  : /* 不可达，posix 兜底走 tar */ uploadFolder(...)
```

- [ ] **Step 4: POSIX tar GNU 选项降级**

`uploadFolder` 的提取命令（L1130-1134）：
- 先尝试 `tar -xzf <t> -C <dir> --overwrite`；
- 若失败且 stderr 含 `--overwrite` 相关字样（或退化为无条件）→ 重试 `tar -xzpf <t> -C <dir>`，并在执行前对目标目录做 `rm -rf "${dir:?}/"*` 清空子项（命令构造前对 `dir` 做非空与绝对路径校验，杜绝 `rm -rf /`）。

`downloadFolder` 的压缩命令（L1211）：
- 先尝试 `tar -I gzip -N -cf ...`；
- 若失败 → 回退 `tar -czf ...`（等价 `-I gzip` 默认级别）。

降级探测仅 posix 分支生效，用一次轻量探测命令判定后缓存于局部变量（不引入全局缓存）。

- [ ] **Step 5: 运行测试验证通过**

Run: `npm run build:test && node --test --test-force-exit dist/__tests__/file-transfer-folder.test.js`

Expected: 新旧用例全 PASS。

- [ ] **Step 6: 回归 + 提交**

```bash
SSH_TOOL_DATA_DIR=/tmp/ssh-tool-sync-data npm run test:fast
SSH_TOOL_DATA_DIR=/tmp/ssh-tool-sync-data npm run test:transfer
git add src/file-transfer.ts src/__tests__/file-transfer-folder.test.ts
git commit -m "feat: sftp recursive folder transfer for windows dialects with tar fallback"
```

---

## 阶段验收（P6b 本批完成定义）

1. `npm run build:test` 零错误。
2. 新用例：远端 move 方言（Move-Item）、目录传输 Windows 分支（无 tar）、tar 降级全 PASS。
3. `test:fast` + `test:transfer` 全绿；不传 sessionKey 路径字节不变（posix 目录传输仍走 tar）。
4. `grep -n '"mv ' src/file-transfer.ts` 无结果（backup 已方言化）。
5. 真机 188（探测=powershell）：目录上传/下载 round-trip 通过（不再依赖远端 tar）。

## 后续阶段

P7（remote-file-tools 命令构造 PS 分支 + read/list/stat/grep/find）、P8（mcp-server 杂项：write_file 改 SFTP、host_load 便携命令、ssh_cd 方言化）、P9 CI 矩阵、P10 188 手测。
