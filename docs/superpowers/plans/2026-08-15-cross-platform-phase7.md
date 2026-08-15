# 跨平台兼容 P7 实施计划（第五批）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 remote-file-tools 的命令构造器按远端方言生成 PowerShell 语义命令（`Get-Item`/`Get-ChildItem`/`Select-String`），使 ssh_read_file/ssh_list_dir/ssh_stat/ssh_grep/ssh_find 在 Windows（探测=powershell）主机上可用；POSIX 侧补严格模式降级（`head -c` → `dd bs=1 count=N`、`grep -I` → `od`/`file`）。

**Architecture:** `build*Command(path, opts, kind?)` 增加可选 `kind: DialectKind` 参数（缺省 "posix"），输出格式与现有 parse 函数对齐（TAB 分隔），PS 分支命令经 remoteExec 的 `-EncodedCommand` wrapper 在远端执行。`remote-tools.ts` 调用处传 `getDialect(ctx.sessionKey).kind`。cmd 方言不构造（其远端无 PowerShell 时 SFTP 三级降级兜底，链路已存在）。

**Tech Stack:** TypeScript (ESM, node:test), ssh2。

**前置上下文（执行者必读）：**
- P6 已交付 sessionKey 全链路；P6b 已交付目录传输 SFTP 分支
- `remote-file-tools.ts` 命令构造器（L68-320）：`buildReadFileMetadataCommand`/`buildReadFileContentCommand`/`buildListDirCommand`/`buildListDirFallbackCommand`/`buildStatCommand`/`buildStatFallbackCommand`/`buildGrepCommand`/`buildGrepFallbackCommand`/`buildFindCommand`/`buildFindFallbackCommand`，全部 posix 语法
- parse 约定：list/find/stat 用 `\t` 分隔（`parseListDirOutput` 期望 `name\ttype\tsize\tmode\tmtime\tpath`；`parseFindOutput` 期望 `path\ttype\tsize\tmtime`；`parseStatOutput` 期望 `type\tsize\tmode\towner\tgroup\tmtime\tpath`）；grep 用 `path:line:text` 或 NUL 分隔
- remote-tools.ts 已有 SFTP 三级降级（readFile L249-261、stat L399-400、listDir fallback L354+）
- **字节红线**：不传 kind（posix）命令逐字节不变
- **验证环境**：`npm run build:test`；`SSH_TOOL_DATA_DIR=/tmp/ssh-tool-sync-data npm run test:fast` + `test:transfer`；remote-file-tools 相关测试在 `src/__tests__/remote-file-tools.test.ts` 与 `remote-tools.test.ts`

---

## Task 1: stat + list_dir 的 PowerShell 命令构造

**Files:**
- Modify: `src/remote-file-tools.ts`
- Modify: `src/__tests__/remote-file-tools.test.ts`
- Modify: `src/remote-tools.ts`

- [ ] **Step 1: 写失败测试**

`remote-file-tools.test.ts` 追加：

```typescript
it("builds a PowerShell stat command when kind is powershell", () => {
  const cmd = buildStatCommand("/x", { kind: "powershell" })
  assert.ok(cmd.includes("Get-Item"))
  assert.ok(cmd.includes("'/'x''"))  // psQuote 路径（单引号）
})
it("builds a PowerShell list_dir command when kind is powershell", () => {
  const cmd = buildListDirCommand("/x", false, { kind: "powershell" })
  assert.ok(cmd.includes("Get-ChildItem"))
})
```

并断言 posix 缺省输出与现状逐字节相同。

- [ ] **Step 2: 运行测试验证失败**（红灯）

Run: `npm run build:test && node --test --test-force-exit dist/__tests__/remote-file-tools.test.js`

- [ ] **Step 3: 实现**

`buildStatCommand(path, opts?: { kind?: DialectKind })`：

```typescript
if (opts?.kind === "powershell") {
  return `$i=Get-Item -LiteralPath ${psQuote(path)} -ErrorAction SilentlyContinue; if(-not $i){exit 1}; $t=if($i.PSIsContainer){'directory'}else{'file'}; $mt=[int][double]$i.LastWriteTime.ToUniversalTime().Subtract([datetime]'1970-01-01').TotalSeconds; "{0}`t{1}`t{2}`t{3}`t{4}`t{5}`t{6}" -f $t,$i.Length,'0','','',$mt,$i.FullName`
}
```

`buildListDirCommand(path, showHidden, opts?)`：PS 用 `Get-ChildItem -LiteralPath <p> -Force | ForEach-Object { $t=if($_.PSIsContainer){'d'}else{'f'}; $mt=[int][double]$_.LastWriteTime.ToUniversalTime().Subtract([datetime]'1970-01-01').TotalSeconds; "{0}`t{1}`t{2}`t{3}`t{4}`t{5}" -f $_.Name,$t,$_.Length,'0',$mt,$_.FullName }`；`showHidden` 为 false 时加 `| Where-Object { -not $_.Name.StartsWith('.') }`。

`remote-tools.ts`：stat/listDir 调用 build* 处传 `{ kind: getDialect(ctx.sessionKey).kind }`（先 `const kind = getDialect(ctx.sessionKey).kind` 于 execute 顶部复用）。

- [ ] **Step 4: 运行测试验证通过**（绿灯）

Run: `npm run build:test && node --test --test-force-exit dist/__tests__/remote-file-tools.test.js dist/__tests__/remote-tools.test.js`

- [ ] **Step 5: 回归 + 提交**

```bash
SSH_TOOL_DATA_DIR=/tmp/ssh-tool-sync-data npm run test:fast
SSH_TOOL_DATA_DIR=/tmp/ssh-tool-sync-data npm run test:transfer
git add src/remote-file-tools.ts src/remote-tools.ts src/__tests__/remote-file-tools.test.ts
git commit -m "feat: powershell command builders for stat and list_dir"
```

---

## Task 2: grep + find 的 PowerShell 命令构造

**Files:**
- Modify: `src/remote-file-tools.ts`
- Modify: `src/__tests__/remote-file-tools.test.ts`
- Modify: `src/remote-tools.ts`

- [ ] **Step 1: 写失败测试**（断言 PS 分支含 `Select-String` / `Get-ChildItem -Recurse`，posix 不变）
- [ ] **Step 2: 红灯**
- [ ] **Step 3: 实现**

`buildGrepCommand(params, opts?)` PS 分支：

```typescript
const pat = params.caseInsensitive ? params.pattern : `(?i)${params.pattern}` // PS Select-String 默认忽略大小写，需要精确时用 -CaseSensitive
return `Select-String -Path ${psQuote(params.path)} -Pattern ${psQuote(params.pattern)} -Recurse -ErrorAction SilentlyContinue | ForEach-Object { "{0}:{1}:{2}" -f $_.Path,$_.LineNumber,$_.Line }`
```

注意：Select-String 默认大小写不敏感；`caseInsensitive=false` 时加 `-CaseSensitive`。glob 参数 PS 侧忽略（`-Path` 支持通配，`psQuote` 后不展开；保持简单，文档注明）。

`buildFindCommand(params, opts?)` PS 分支：

```typescript
let cmd = `Get-ChildItem -LiteralPath ${psQuote(params.path)} -Recurse -ErrorAction SilentlyContinue`
if (params.maxDepth !== undefined) cmd += ` -Depth ${Math.max(0, Math.floor(params.maxDepth))}`
// 构造管道：输出 path\ttype\tsize\tmtime；type 过滤 + name 过滤在此处拼入 Where-Object
```

输出与 parseFindOutput 兼容（`path\ttype\tsize\tmtime`，mtime 为 epoch 秒）。`type`/`name` 过滤：`| Where-Object { $_.PSIsContainer -eq ($true) }` / `-like`。

`remote-tools.ts` grep/find 调用处同 Task 1 传 kind。

- [ ] **Step 4: 绿灯**
- [ ] **Step 5: 回归 + 提交**

```bash
git commit -m "feat: powershell command builders for grep and find"
```

---

## Task 3: read_file 的 PowerShell 分支 + POSIX 严格降级

**Files:**
- Modify: `src/remote-file-tools.ts`
- Modify: `src/__tests__/remote-file-tools.test.ts`

- [ ] **Step 1: 写失败测试**（PS metadata 含 `Get-Item`，PS content 含 `Get-Content`；严格降级 `dd` 构造断言）
- [ ] **Step 2: 红灯**
- [ ] **Step 3: 实现**

`buildReadFileMetadataCommand(path, opts?)` PS 分支：

```typescript
`$i=Get-Item -LiteralPath ${psQuote(path)} -ErrorAction SilentlyContinue; $size=if($i){$i.Length}else{0}; $lines=(Get-Content -LiteralPath ${psQuote(path)} -ErrorAction SilentlyContinue | Measure-Object -Line).Lines; "size_bytes=$size`ntotal_lines=$lines`nbinary_detected=false`nencoding=utf-8"`
```

`buildReadFileContentCommand(path, offset, limit, opts?)` PS 分支：

```typescript
`$lines=Get-Content -LiteralPath ${psQuote(path)}; $lines[(${start}-1)..(${end}-1)] -join "`n"`
```

（start/end 沿用现有计算；`-Encoding UTF8` 由 wrapper/远端默认；大文件整读进内存——工具场景可接受。）

POSIX 严格降级（缺省 posix 不变，新增导出 `buildReadFileContentPortableCommand` 或把现有 `sed|head -c` 改为探测降级——保持字节红线：不传 kind 逐字节不变，降级作为 `opts.strict` 新开关）：

```typescript
// strict: head -c 不可用时
`sed -n '${start},${end}p' ${shellQuote(path)} | dd bs=1 count=${MAX_READ_FILE_BYTES + 1} 2>/dev/null`
```

- [ ] **Step 4: 绿灯**
- [ ] **Step 5: 回归 + 提交**

```bash
git commit -m "feat: powershell read_file builders with posix strict fallback"
```

---

## 阶段验收（P7 本批完成定义）

1. `npm run build:test` 零错误。
2. 新用例：5 个 PS 命令构造 + posix 逐字节不变全 PASS。
3. `test:fast` + `test:transfer` 全绿。
4. 真机 188（探测=powershell）：`ssh_stat`/`ssh_list_dir`/`ssh_grep`/`ssh_find`/`ssh_read_file` 各返回有效数据（SFTP 降级不再触发）。

## 后续阶段

P8（mcp-server 杂项：write_file 改 SFTP、host_load 便携命令、ssh_cd 方言化）、P9 CI 矩阵、P10 188 手测。
