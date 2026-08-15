# 跨平台兼容 P10 实施计划（第八批）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把真机 188（Windows OpenSSH）验证固化为可重复执行的清单脚本 + 输出平台能力矩阵文档（功能 × 方言 × 主路径/降级链/覆盖标记），并对账设计文档明示的审查盲区。

**Architecture:**
- `scripts/manual-check-188.mjs`：纯 Node ESM，直接 import `dist/` 编译产物（`remote-shell`、`remote-tools`、`file-transfer`、`mcp-server`、`remote-dialect`），用 ssh2 连 188，逐项执行 20 项检查并输出 `[PASS]/[FAIL]`，任一项失败 → 退出码非 0。认证走 `MCHECK_PROFILE`（ProfileManager 按名加载，如 `lobster-188`）或 `MCHECK_HOST/PORT/USER/PASSWORD/PRIVATE_KEY` 环境变量，凭证不进仓库。
- `scripts/manual-check-188.sh`：薄 bash 启动器（先 `npm run build` 保证 dist 最新，再 `node scripts/manual-check-188.mjs`）。
- `docs/superpowers/specs/2026-08-15-xplat-capability-matrix.md`：行=功能（探测/exec/cwd/env/后台/kill/传输/文件工具/写文件/host-load），列=方言（posix-gnu/posix-busybox/posix-bsd/powershell/cmd），格=主路径命令 + fallback 链 + 覆盖标记（P9 xplat 测试文件 / P10 手测 #N / 单测）。另含"审查盲区对账"表：以设计文档明示的盲区编号（1/4/5/6/7/8/9/10/13/14/15/21/22）与 §0 审查发现（私钥路径、free -h、ps --no-headers、sleep 0.1、GNU tar 长选项、base64、/tmp 硬编码、wrapper 重复）逐项对账，标注消除阶段与证据；未在文档中逐条枚举的盲区不臆造，统一标注"以 P9 xplat + P10 手测覆盖"。

**Tech Stack:** TypeScript (ESM, node:test), ssh2, bash。

**前置上下文（执行者必读）：**
- P0-P9 已交付：`probeAndDetect`/`getDialect(sessionKey)`；`remoteExec`/`execRemote`/`resolveRemoteCwd`（`src/remote-shell.ts`）；`createRemoteTools`（`src/remote-tools.ts`，readFile/listDir/stat/grep/find/exists 生产降级链）；`uploadFolder`/`downloadFolder`（`src/file-transfer.ts`，posix 走 tar、非 posix 走 SFTP 递归）；`buildHostLoadCommands`/`buildExistsCommand`/`writeRemoteFileViaSftp`（`src/mcp-server.ts`）
- 本机已有 profile `lobster-188`（host `192.168.50.188`、user `85118`、`privateKey` 为路径字符串 `~/.ssh/id_ed25519`——P0 已修连接层解析）。`desktop` profile 为含内联 ed25519 密钥的单跳直连 188。
- MCP `ssh_exists`/`ssh_get_host_load`/`ssh_write_file` 已方言化（P8）。
- **验证环境**：`npm run build` 后 `MCHECK_PROFILE=lobster-188 ./scripts/manual-check-188.sh`；`SSH_TOOL_DATA_DIR=/tmp/ssh-tool-sync-data npm run test:fast` 回归。
- **红线**：脚本不修改产品代码；不出现在 `test:fast`/`test:all`；矩阵文档所有"主路径命令"必须与 `src/` 实现一致（可 grep 验证），不写理想化命令。

---

## Task 1: manual-check-188 脚本（20 项真机检查）

**Files:**
- Add: `scripts/manual-check-188.mjs`
- Add: `scripts/manual-check-188.sh`

- [ ] **Step 1: 实现脚本骨架 + 前 10 项检查**

脚本结构：
```javascript
// 连接：MCHECK_PROFILE 优先（ProfileManager），否则 env 直连；ssh2 connect。
// 探测：probeAndDetect → putCachedDialect(sessionKey)，打印探测结果。
// check(name, fn)：fn 返回 true/抛错 → PASS/FAIL；汇总后 exitCode。
```
前 10 项（对应现场症状）：
1. 连接握手成功（密钥修复验证，P0）
2. 方言探测 → kind=powershell（sub=powershell）
3. exec 基础 echo（`echo XPLAT` → stdout 含标记）
4. `where powershell`（现场唯一成功命令回归）
5. `dir C:\Windows`（现场失败症状①：wrapper 反斜杠/引号错误）
6. `powershell -Command "Get-ChildItem 'C:\Program Files'"`（现场失败症状②）
7. 引号 round-trip（`Write-Output 'a b'` → `a b`）
8. 管道 round-trip（`(Get-ChildItem | Measure-Object).Count` → 数字）
9. 反斜杠路径 round-trip（`Write-Output 'C:\Program Files'` 原样）
10. 含空格路径 stat（`buildStatCommand('C:\Program Files', {kind})` → 成功）

- [ ] **Step 2: 后 10 项检查**

11. cwd 解析（`resolveRemoteCwd` 到 `$env:TEMP` 子目录 → 合法盘符路径）
12. env 注入（`remoteExec` 带 env → `$env:VAR` 可见）
13. 后台任务启动（`buildBackground('Start-Sleep -Seconds 30')` → 捕获 PID）
14. 后台任务存活校验（`Get-Process -Id <pid>`）
15. 后台任务取消（`buildKill(pid)` → 进程消失）
16. 目录上传 round-trip（本地临时目录 → 188 → SFTP 递归）
17. 目录下载 round-trip（188 → 本地，逐字节一致）
18. 文件工具 read/list（`createRemoteTools` 的 readFile + listDir 于临时目录）
19. `ssh_exists` 等价（`buildExistsCommand` → exists/not_found）
20. host-load 便携命令（`buildHostLoadCommands` → 三命令均 code 0）

- [ ] **Step 3: 本机构建 + 188 实跑全 PASS**

`npm run build` → `MCHECK_PROFILE=lobster-188 ./scripts/manual-check-188.sh` 输出 20×PASS。

- [ ] **Step 4: 回归 + 提交**

```bash
git commit -m "feat: add manual-check-188 script for real Windows host validation"
```

---

## Task 2: 平台能力矩阵文档 + 盲区对账

**Files:**
- Add: `docs/superpowers/specs/2026-08-15-xplat-capability-matrix.md`

- [ ] **Step 1: 写矩阵主体**

功能行（10 组）：探测 / exec / cwd / env / 后台 / kill / 单文件传输 / 目录传输 / 文件工具 / 写文件 / host-load。
方言列（5）：posix-gnu / posix-busybox / posix-bsd(darwin) / powershell / cmd。
每格：主路径命令（grep 验证与 `src/` 一致）+ fallback 链 + 覆盖标记（`xplat/exec-detection.test.ts` 等 + `manual-check-188 #N`）。

- [ ] **Step 2: 写盲区对账表**

以设计文档 §0/§3 明示的编号盲区 + §0 审查发现逐项列出：消除阶段（P0-P9）+ 证据（提交/测试/手测项）。文档未逐条枚举的项标"以 P9/P10 覆盖"。

- [ ] **Step 3: 提交**

```bash
git commit -m "docs: add cross-platform capability matrix and blind-spot reconciliation"
```

---

## 阶段验收（P10 本批完成定义）

1. `manual-check-188.sh` 在 188 上 20 项全 PASS（本轮实跑证据写入提交说明/会话记录）。
2. 矩阵文档无 TBD；主路径命令与 `src/` 实现一致（grep 抽查）。
3. 盲区对账表无臆造编号。
4. `test:fast` 回归全绿。

## 后续阶段

P11 边界收尾（保守模式、README Windows 远端要求、coordinator 边界标注）；P12 清理与防御性收口。
