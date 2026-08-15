# 跨平台兼容 P8 实施计划（第六批）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** mcp-server 杂项工具跨平台化：`ssh_write_file` 改走 SFTP（删除 `echo|base64 -d` 管道，消除大文件 ARG_MAX 与 Windows 无 base64 问题）、`ssh_exists` 按方言探测、`ssh_get_host_load` 用便携命令（`/proc/meminfo` + `vm_stat` + PowerShell CIM）。

**Architecture:** `getClientForProfile` 返回 `hostId`（= `connection.getHostId()`），`withReconnect` 回调增加第二参数 `sessionKey?`（现有单参数回调不受影响）。`ssh_write_file` 用 `createRemoteFs` + 递归 mkdir + writeFile；`ssh_exists`/`ssh_get_host_load` 用 `getDialect(sessionKey).kind` 构造方言命令。

**Tech Stack:** TypeScript (ESM, node:test), ssh2。

**前置上下文（执行者必读）：**
- P5-P7 已交付执行链 + 工具层方言化；`getDialect(sessionKey)` 在 `./remote-dialect/index.js`
- `createRemoteFs` 在 `./remote-fs.js`（接口：`mkdir(path, mode?)` 单级、`writeFile(path, data, options?)`）；`shellQuote`/`assertOctalMode` 在 `./shell-quote.js`；`remoteParentDir` 在 `./remote-path.js`
- mcp-server：`getClientForProfile` L227（返回 `{ client, forwardManager }`，内部有 `connection` 变量 L346）、`withReconnect` L434（`fn(client)`）、clientCache entry L146-150
- `ssh_write_file` L906-928（现为 `echo b64 | base64 -d > path`）；`ssh_exists` L959-968（`test -e`）；`ssh_get_host_load` L1243-1268（`uptime`/`free -h`/`ps aux --no-headers | wc -l`）
- `ssh_cd`/`ssh_get_cwd` 走 daemon `setCwd`，P5 已方言化——本批不改
- **字节红线**：不传 sessionKey 的路径行为不变；posix 命令输出兼容现有解析
- **验证环境**：`npm run build:test`；`SSH_TOOL_DATA_DIR=/tmp/ssh-tool-sync-data npm run test:fast` + `test:transfer`；mcp-server 相关测试在 `src/__tests__/mcp-server.test.ts`

---

## Task 1: getClientForProfile/withReconnect 透出 hostId + ssh_write_file 改 SFTP

**Files:**
- Modify: `src/mcp-server.ts`
- Modify: `src/__tests__/mcp-server.test.ts`

- [ ] **Step 1: 写失败测试**

`mcp-server.test.ts` 追加：mock 连接成功后调 `ssh_write_file`，断言：
1. 未出现 `base64 -d` / `echo` 写文件 exec；
2. SFTP 层收到 `mkdir` 与 `write`（通过注入的 createRemoteFs mock 或捕获 `client.sftp` 调用）。

若现有测试基建难以注入 remote-fs，则在测试里 stub `client.sftp` 返回内存 sftp（mkdir/write 记录调用），并 stub `mkdir -p` 不再走 exec。

- [ ] **Step 2: 红灯**

Run: `npm run build:test && node --test --test-force-exit dist/__tests__/mcp-server.test.js`

- [ ] **Step 3: 实现**

1. `ClientCacheEntry` 加 `hostId: string`；`getClientForProfile` 缓存与返回加 `hostId`（用 L346 `connection.getHostId()`）。
2. `withReconnect` 的 `fn` 签名改为 `(client: any, sessionKey?: string) => Promise<T>`，调用处传 `hostId`。
3. `ssh_write_file` 内：

```typescript
const fs = await createRemoteFs(client)
await sftpMkdirP(client, remoteParentDir(path))   // 递归 mkdir helper（sftp.mkdir + stat 判定已存在）
await fs.writeFile(path, content, mode ? { mode: parseInt(assertOctalMode(mode), 8) } : undefined)
```

新增模块级 `sftpMkdirP(client, dir)` helper：逐级 mkdir（`/` 或 `C:` 段处理同 file-transfer 的 sftpMkdirP 思路）。删除 `dirCmd`/`writeCmd`/`b64` 构造。

- [ ] **Step 4: 绿灯**
- [ ] **Step 5: 回归 + 提交**

```bash
git commit -m "feat: write remote files via sftp instead of base64 echo pipeline"
```

---

## Task 2: ssh_exists 方言化 + ssh_get_host_load 便携命令

**Files:**
- Modify: `src/mcp-server.ts`
- Modify: `src/__tests__/mcp-server.test.ts`

- [ ] **Step 1: 写失败测试**（缓存 powershell 方言后断言 ssh_exists 走 `Test-Path`；断言 host_load 命令不含 `free -h`、含 `/proc/loadavg`/`vm_stat`/`Get-CimInstance`）
- [ ] **Step 2: 红灯**
- [ ] **Step 3: 实现**

`ssh_exists`：

```typescript
const sessionKey = ... // withReconnect 第二参
const kind = getDialect(sessionKey).kind
const cmd = kind === "powershell"
  ? `if (Test-Path -LiteralPath ${psQuote(path)}) { 'exists' } else { 'not_found' }`
  : `test -e ${shellQuote(path)} && echo "exists" || echo "not_found"`
```

`ssh_get_host_load`：按 kind 组装三组命令：

```typescript
const posixUptime = "cat /proc/loadavg 2>/dev/null || sysctl -n vm.loadavg"
const posixMem = "cat /proc/meminfo 2>/dev/null | head -n 8 || vm_stat | head -n 8"
const posixProc = "ps -e -o comm 2>/dev/null | wc -l || ps aux --no-headers | wc -l"
const psUptime = "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToString()"
const psMem = "Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize,FreePhysicalMemory | Format-List"
const psProc = "(Get-Process | Measure-Object).Count"
```

kind !== "posix" 时三组全用 PS 命令（cmd 无 PowerShell 时由 PS 引擎处理——实测 188 默认 shell 为 PowerShell；cmd 分支回退 posix 便携命令即可）。

- [ ] **Step 4: 绿灯**
- [ ] **Step 5: 回归 + 提交**

```bash
git commit -m "feat: dialect-aware ssh_exists and portable host load commands"
```

---

## 阶段验收（P8 本批完成定义）

1. `npm run build:test` 零错误。
2. 新用例：write_file 无 base64 exec、exists PS 分支、host_load 便携命令构造全 PASS。
3. `test:fast` + `test:transfer` 全绿；不传 sessionKey 路径字节不变。
4. 真机 188（探测=powershell）：`ssh_write_file`/`ssh_exists`/`ssh_get_host_load` 返回有效数据。

## 后续阶段

P9 CI 多平台矩阵、P10 188 手测清单 + 能力矩阵文档、P11/P12 收口。
