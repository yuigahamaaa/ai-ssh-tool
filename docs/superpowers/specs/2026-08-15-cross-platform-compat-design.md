# 跨平台远程执行兼容 — 12 阶段设计

> 状态：待审阅
> 日期：2026-08-15
> 关联现场：Mac (ssh-tool 客户端) → Windows 192.168.50.188 (OpenSSH)，profile `lobster-188`

## 0. 背景与问题

现场审查确认：ssh-tool 的远程执行模型**本质上只支持 POSIX shell**。所有远端命令都被包装为：

```text
echo "SSH_TOOL_PID:$$" >&2; exec sh -c '<命令>'
```

该 wrapper 在 [remote-shell.ts:L157](../../src/remote-shell.ts#L157)、[exec-task-manager.ts:L303](../../src/exec-task-manager.ts#L303)、[daemon.ts:L100](../../src/daemon.ts#L100) 三处重复实现，后台变体（`setsid sh -c ...`，[daemon.ts:L285](../../src/daemon.ts#L285)）再加一处；kill 字符串在 5 处重复。Windows OpenSSH 默认 shell 是 `cmd.exe` 或注册表配置的 PowerShell，均无法解析该 wrapper——`$$` 不是 PID、`exec` 不存在、`sh` 通常不存在、POSIX 单引号转义无效。这就是"反斜杠变 4 倍、引号/管道解析错误、setsid 不存在"的根因：**多层 shell 命令字符串编码叠加，而非单点转义 bug**。

除 Windows 外，审查还发现 BSD/macOS/BusyBox 远端的暴露点：`free -h`（procps 专属）、`ps --no-headers`（GNU 旗标）、`sleep 0.1`（POSIX 仅保证整数秒）、GNU tar 长选项（`--overwrite`、`-I`）、`base64`（非 POSIX 工具）、硬编码 `/tmp`。

另一独立问题：现场 profile `lobster-188` 在连接阶段即失败 `Cannot parse privateKey: Unsupported key format`，属连接层（私钥格式/传递）缺陷，与 shell 方言无关，但同样阻断 Windows 访问，纳入 Phase 0。

## 1. 目标与非目标

**目标**

1. 远端支持全矩阵：Linux（glibc/BusyBox）、macOS/BSD、Windows（PowerShell 优先，cmd 兜底）。
2. 连接后自动探测远端 shell/OS，无需用户手工配置；探测失败回退 posix，现有 Linux 用户零影响。
3. 消灭 8 处重复的 wrapper/kill 字符串，统一为单一方言构造层，一处修改全处生效。
4. 工具层（file-transfer、remote-file-tools、mcp-server）命令构造按方言分支并提供降级链。
5. 测试体系：CI 多平台 runner（ubuntu/windows/macos）起真实 sshd 做端到端矩阵 + 平台能力矩阵表 + 真实 188 手测清单。
6. 分 12 个阶段交付，每阶段独立可验收、可合并。

**非目标**

- 不改造 coordinator 子系统的跨平台（`/proc` observer、systemd 部署）——留待后续独立 spec，仅在 Phase 11 标注边界。
- 不实现交互式 shell 的 Windows 方言适配（`--shell` 模式），仅覆盖 exec 通道。
- 不做远端 shell 的能力协商协议（如探测每条命令可用性），能力矩阵静态声明 + 降级链足够。

## 2. 总体架构

### 2.1 方言抽象（核心）

新建 `src/remote-dialect/` 模块：

```text
src/remote-dialect/
  types.ts          # DialectSpec 接口、RemoteDialect、DialectKind
  posix.ts          # POSIX 方言（含 GNU/BusyBoot 差异处理）
  powershell.ts     # Windows PowerShell / pwsh 方言
  cmd.ts            # cmd.exe 兜底方言
  detect.ts         # 连接后自动探测
  cache.ts          # 探测结果按 (host,port,user) 缓存
  index.ts          # 导出 getDialect()/detectAndCache()
```

**DialectSpec 接口**（收拢现有 8 处重复）：

```typescript
export type DialectKind = "posix" | "powershell" | "cmd"

export interface DialectSpec {
  readonly kind: DialectKind
  /** 包装命令：输出 PID 标记到 stderr + 以正确方言执行用户命令 */
  buildExec(command: string, opts?: { cwd?: string; env?: Record<string, string> }): string
  /** 后台启动（setsid → Start-Process → start /b） */
  buildBackground(command: string, opts?: { cwd?: string; env?: Record<string, string> }): string
  /** 终止进程（kill 阶梯 → Stop-Process → taskkill /T /F） */
  buildKill(pid: number): string
  /** PID 标记字符串（stderr 中可被正则捕获） */
  pidMarkerPattern(): RegExp
  /** cwd 解析命令（pwd -P → Get-Location / cd） */
  buildCwdResolve(baseCwd?: string): string
  /** 校验远端返回的绝对路径是否合法（/ 开头 vs 盘符开头） */
  isValidAbsPath(path: string): boolean
  /** POSIX 风格顶层分号拆分是否适用（cmd 用 & 拆分，powershell 同 ; 但解析器不同） */
  supportsSemicolonSplit(): boolean
}
```

### 2.2 执行链改造后的数据流

```text
ssh_exec / ssh_exec_background / transfer / file tools
  └─ remoteExec / execScheduledStream / ExecTaskManager.start
       └─ dialect = getDialect(sessionKey)            ← 缓存未命中则探测
            └─ wrapped = dialect.buildExec(cmd, {cwd, env})
                 └─ client.exec(wrapped)              ← 唯一的 client.exec 包装点
```

现状的三处 wrapper 构造点全部改为调用 `dialect.buildExec()`；五处 kill 改为 `dialect.buildKill()`。PID 捕获正则从硬编码 `/SSH_TOOL_PID:(\d+)/` 改为 `dialect.pidMarkerPattern()`（各方言标记格式统一为 `SSH_TOOL_PID:<n>`，但捕获由方言自身声明，cmd 方言的标记写入方式不同）。

### 2.3 探测协议（三态一次判定）

探针命令**必须不经过任何 wrapper**，直接 `client.exec()` 原始字符串，且同时被三种 shell 容忍：

```text
echo __A__%OS%__B__$env:OS__C__
```

| 远端默认 shell | 实际输出 | 判定 |
|---|---|---|
| cmd.exe | `__A__Windows_NT__B__$env:OS__C__` | windows-cmd |
| PowerShell | `__A__%OS%__B__Windows_NT__C__` | windows-powershell |
| POSIX sh | `__A__%OS%__B__:OS__C__`（`$env` 展开为空） | posix |

判定规则（优先级从上到下）：

1. 输出包含 `$env:OS` 字面量 → **windows-cmd**
2. 输出包含 `%OS%` 字面量 → **windows-powershell**
3. 输出匹配 `__A__.*__B__.*__C__` 且 2 段中无 `%`/`$` 展开 → **posix**，进入第二级
4. 其他（受限 shell / 输出畸形）→ 回退 **posix** 并打日志 `dialect: probe ambiguous, fallback posix`

第二级（仅 posix）：`uname -s` 2 秒超时 → `Linux`（再探 BusyBox：`busybox 2>&1 || true` 输出含 `BusyBox` 则标记 gnu 差异模式）/ `Darwin` / `*BSD` / 失败 → 保守模式（只用严格 POSIX 命令 + 现有 fallback 链）。

第二级（仅 windows-powershell/cmd）：探测 PowerShell 可用性——`powershell -NoProfile -Command "exit 0"`（exit 0 → 用 powershell 方言执行；非 0 → cmd 方言）。

**缓存**：`Map<hostId, {kind, sub, detectedAt}>`，daemon 内存级，session 断开不重置。profile 可加可选字段 `remoteShellHint: "posix"|"powershell"|"cmd"` 跳过探测（自动探测为主，hint 为旁路，供受限环境手工指定）。

### 2.4 各方言关键形态

**POSIX**（现状保持，仅收拢）：

```text
buildExec:  echo "SSH_TOOL_PID:$$" >&2; cd '<cwd>' && export K=V; exec sh -c '<cmd>'
buildKill:  kill -TERM <pid> 2>/dev/null; sleep 1; kill -KILL <pid> 2>/dev/null; true
            （sleep 0.1 → sleep 1，兼容 BusyBox；终止等待放客户端侧）
```

**PowerShell**（核心：`-EncodedCommand` 消灭引号/反斜杠/管道层层解析）：

```text
buildExec:
  生成 PS 脚本：
    [Console]::Error.WriteLine("SSH_TOOL_PID:$PID")
    if (cwd) { Set-Location -LiteralPath '<cwd>' }
    foreach env: $env:K = 'V'
    Invoke-Expression -Command <用户命令原文，单引号安全转义为双单引号>
  → powershell -NoLogo -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand <UTF16LE→Base64>
buildKill:  powershell -NoProfile -Command "Stop-Process -Id <pid> -Force -ErrorAction SilentlyContinue"
buildBackground: Start-Process -FilePath ... -WindowStyle Hidden，PID 标记照常写 stderr
```

**cmd**（无 PowerShell 的兜底，能力受限并明示）：

```text
buildExec:  cmd /d /s /c "echo SSH_TOOL_PID:^%RANDOM^% 1>&2 & <命令>"   （PID 用 tasklist 事后补查，标记允许延迟）
buildKill:  taskkill /PID <pid> /T /F
cwd:        cd /d "<path>" && ...
env:        set "K=V" && ...
```

## 3. 12 阶段计划

> 每阶段 = 一个独立 PR，含测试 + 验收命令。阶段间依赖：Phase 0 独立；1–2 串行；3 依赖 1–2；4–5 依赖 3；6–8 依赖 3；9–10 依赖 6；11–12 收尾。

### Phase 0 — 连接层私钥修复（P0，无依赖）

**范围**：现场 `lobster-188` 连接失败 `Cannot parse privateKey: Unsupported key format`。

**改动**：
- `src/profile-manager.ts`：私钥读取支持"路径 vs 内容"自动区分（现状疑似把路径当内容传给 ssh2）；密钥头嗅探（`BEGIN OPENSSH/RSA/EC PRIVATE KEY`）+ 明确报错（"看起来是路径/看起来是公钥/格式不支持，请用 ssh-keygen -p 转换"）。
- `src/connection.ts:toConnectConfig`：传递前 trim + 规范化 CRLF→LF（profile 序列化可能损坏换行）。
- 新测试 `src/__tests__/profile-key-format.test.ts`：路径型/内容型/公钥误存/CRLF 损坏四用例。

**验收**：`node dist/cli/ssh-exec.js --profile-name lobster-188 --command "echo ok"` 在真实 188 上返回 `ok`（或明确的密钥格式错误指引，而非 `Unsupported key format`）。

### Phase 1 — DialectSpec 抽象 + POSIX 方言（P0）

**范围**：建 `src/remote-dialect/`，实现接口 + `posix.ts`，**不改行为**——现有三处 wrapper 调用点全部改为 `posixDialect.buildExec()`，输出字符串与现状逐字节一致。

**改动**：
- 新建 `types.ts`、`posix.ts`、`index.ts`（`getDialect()` 暂时恒返回 posix）。
- [remote-shell.ts:L157](../../src/remote-shell.ts#L157)、[exec-task-manager.ts:L242-L303](../../src/exec-task-manager.ts#L242)、[daemon.ts:L100,L122,L168-L186](../../src/daemon.ts#L100) 替换为 dialect 调用。
- kill 五处（remote-shell L104、ETM L265/L475、daemon L122/L268/L383）替换为 `buildKill()`，同时 `sleep 0.1`→`sleep 1`（BusyBox 兼容，客户端终止等待补偿）。
- 测试：现有 remote-shell/daemon-streaming 测试全部不改应通过（字节一致）；新增 `src/__tests__/remote-dialect-posix.test.ts` 断言 buildExec/buildKill 精确字符串。

**验收**：`npm run test:fast && npm run test:transfer` 全绿；diff 审查确认无行为变化。

### Phase 2 — 探测器 + 缓存（P0）

**范围**：`detect.ts` + `cache.ts`，接入 `getDialect()`。

**改动**：
- `detect.ts`：三态探针（`echo __A__%OS%__B__$env:OS__C__`）+ 二级探测（uname / powershell 可用性），2 秒超时，失败回退 posix。
- `cache.ts`：`Map<hostId, DetectedDialect>`，`detectAndCache(client, hostId)`。
- `index.ts`：`getDialect(sessionKey)` 缓存未命中时触发探测。
- profile 类型 `SSHProfile` 加可选 `remoteShellHint`。
- 测试 `src/__tests__/remote-dialect-detect.test.ts`：mock 三种 shell 的响应断言判定；超时/畸形输出回退 posix。

**验收**：单测覆盖三态 + 二级 + 回退；对 188 真机（Phase 0 修复后）探测返回 `powershell`。

### Phase 3 — PowerShell 方言（P0，Windows 主路径）

**范围**：`powershell.ts` 实现 DialectSpec 全接口，`-EncodedCommand` 编码。

**关键实现**：
- `buildExec`：PS 脚本模板（PID 标记 → Set-Location → $env → Invoke-Expression）→ `iconv-lite` 或 `Buffer.from(script, "utf16le").toString("base64")` 编码。
- 用户命令内嵌：单引号包裹 + `''` 转义（PS 单引号内唯一特殊字符）。
- `buildBackground`：`Start-Process powershell -ArgumentList '-NoProfile','-EncodedCommand',<bg脚本> -WindowStyle Hidden -PassThru`，PID 从 PassThru 输出写标记。
- `buildKill`：`Stop-Process -Force`；进程树终止用 `taskkill /PID <pid> /T /F`（PS 的 Stop-Process 不杀树）。
- `isValidAbsPath`：`/^[A-Za-z]:[\\/]/`。
- 测试 `remote-dialect-powershell.test.ts`：编码正确性（Base64 解回 UTF16LE 比对脚本）、引号/反斜杠/管道/`$` 原样保留、cwd/env 注入。

**验收**：真机 188 上 `ssh_exec` 执行 `powershell -Command "Get-ChildItem 'C:\Program Files'"` 与含管道命令均正确。

### Phase 4 — cmd 方言（P1，无 PowerShell 兜底）

**范围**：`cmd.ts`，能力降级明示（`supportsSemicolonSplit()` false、PID 标记延迟）。

**改动**：`cmd /d /s /c` 包装、`cd /d`、`set "K=V"`、`taskkill /T /F`、PID 标记用 `^%RANDOM^%` 占位 + 执行后 `tasklist /FI "IMAGENAME eq cmd.exe"` 补查（best-effort，文档明示 cmd 方言下超时终止可能只关 channel）。

**测试**：`remote-dialect-cmd.test.ts` 字符串断言。

**验收**：单测通过即可（无真实 cmd-only 机器时靠 Phase 9 CI windows runner 验证）。

### Phase 5 — 执行链全面接线（P0）

**范围**：daemon 后台任务、超时取消、cwd 语义切换到方言。

**改动**：
- [daemon.ts:L281-L285](../../src/daemon.ts#L281) `setsid` wrapper → `dialect.buildBackground()`。
- [daemon.ts:L255-L271](../../src/daemon.ts#L255)、L380-L387 进程组 kill → `dialect.buildKill()`（POSIX 保留负 PGID 形态，Windows 用 taskkill /T）。
- `resolveRemoteCwd`（[remote-shell.ts:L72-L90](../../src/remote-shell.ts#L72)）→ `dialect.buildCwdResolve()` + `isValidAbsPath()` 替换 `startsWith("/")` 硬校验。
- `splitTopLevelSemicolonCommands` 仅在 `dialect.supportsSemicolonSplit()` 时启用（cmd 方言改 `&` 或不拆分）。
- ETM 的 `SSH_TOOL_NOHUP_PID` 分支（[exec-task-manager.ts:L324](../../src/exec-task-manager.ts#L324)）与主标记统一为 `dialect.pidMarkerPattern()`。

**测试**：daemon-streaming-runner 补 cwd 传参用例（覆盖审查盲区 14）；delegate 测试补 kill 命令串断言（盲区 15）；新增 background wrapper 用例（盲区 1）。

**验收**：`test:fast + test:transfer + test:ssh` 全绿；188 真机后台任务可启动/查询/取消。

### Phase 6 — 工具层适配：file-transfer（P1）

**范围**：目录传输的 tar 链、`test` 探测、`mv`/`rm`、`/tmp` 硬编码。

**改动**：
- `remoteIsDir/Exists/Symlink`（L125-L152）→ dialect 分支：PS 用 `Test-Path -PathType Container/Leaf`；cmd 用 `if exist`。补齐 `test -L` 零覆盖测试（盲区 9）。
- 远端 backup `mv`（L328）/ rename 循环（L335）→ PS `Move-Item` / cmd `move`、`ren`；补远端用例（盲区 8）。
- **tar 链替代方案**：Windows 分支不走 tar——上传目录改为 SFTP 递归 mkdir + 逐文件 put（复用现有 uploadFile）；下载同理（readdir + 逐文件 get）。POSIX 侧保留 tar 但 GNU 长选项探测降级：`--overwrite` 不可用时改 `tar -xzpf` + 预 `rm -rf` 目标子项；`-I gzip -N` 不可用回退 `-czf`（盲区 7）。
- `/tmp` 硬编码（L1075/L1178）→ 探测 `TMPDIR`/`$env:TEMP`/`/tmp` 写权限一次并缓存。
- 转码 `lineEnding: auto`（L273/L751/L951）改为按**远端**平台推断（探测结果），不再用本机 `process.platform`（盲区 21）。
- 测试：folder 测试补 GNU 选项降级矩阵；Windows 路径 round-trip（上传 `C:\Users\x\dir` 下载回来内容一致）。

**验收**：真机 188 目录上传/下载 round-trip 通过；CI windows runner 同样通过（Phase 9 接入后）。

### Phase 7 — 工具层适配：remote-file-tools（P1）

**范围**：read/list/stat/grep/find 的 GNU 主路径 + fallback 链扩展。

**改动**：
- `read_file`：`head -c`/`grep -I` 无 fallback（盲区 22）——严格 POSIX 降级 `dd bs=1 count=N`、二进制检测改 `od`/`file`；Windows 分支整链改 PS：`Get-Content -TotalCount -Encoding Byte`。
- `list_dir`/`stat`/`find`/`grep`：Windows 分支 PS 实现（`Get-ChildItem`/`Get-Item`/`Select-String`）；POSIX 侧补 BusyBox 模式（`find -printf` 失败时走现有 sh fallback——代码已有，补测试矩阵）。
- 第三级 SFTP 降级（remote-tools L355/L396，盲区 13）补测试。
- 测试：`remote-file-tools.test.ts` 加方言分支构造断言；真机 188 上 `ssh_read_file`/`ssh_list_dir`/`ssh_grep` 各一例。

**验收**：真机 188 文件工具全可用；Linux mock 测试不回归。

### Phase 8 — 工具层适配：mcp-server 杂项命令（P2）

**范围**：`ssh_write_file` base64 管道、`ssh_exists`、`ssh_get_host_load`、`ssh_cd`。

**改动**：
- `ssh_write_file`（L912-L918）：改走 SFTP（`createRemoteFs` 已有），彻底删 `echo|base64 -d` 路径（盲区 4）——大文件 ARG_MAX 问题一并消除。
- `ssh_exists`（L964）→ dialect `Test-Path`/`test -e`（盲区 6）。
- `ssh_get_host_load`（L1253-L1255）：`free -h` → `/proc/meminfo` 直读（Linux）+ `vm_stat`（Darwin）+ `Get-CimInstance Win32_OperatingSystem`（Windows）；`ps --no-headers` → `ps -e -o ... | tail -n +2` 便携式（盲区 5）。
- `ssh_cd`/`ssh_get_cwd`（L1470-L1562）：依赖 Phase 5 的 `buildCwdResolve`，PS 下返回 `C:\...` 路径合法。
- 测试：mcp-server 层补上述工具的真机手测项（进 Phase 10 清单）+ mock 命令断言。

**验收**：真机 188 上四工具返回有效数据。

### Phase 9 — CI 多平台真机矩阵（P0，与 3-8 并行可先行搭建）

**范围**：GitHub Actions 三 runner 起真实 sshd，端到端跑方言矩阵。

**改动**：新 workflow `.github/workflows/cross-platform.yml`：

```yaml
strategy:
  matrix:
    os: [ubuntu-latest, windows-latest, macos-latest]
steps:
  - runner 内安装并启动 sshd（windows: Enable-WindowsOptionalFeature OpenSSH Server；
    macos: sudo systemsetup -setremotelogin on；ubuntu: apt install openssh-server）
  - 生成临时密钥对注入 authorized_keys
  - 跑 npm run test:xplat —— node --test dist/__tests__/xplat/*.test.js
```

- 新目录 `src/__tests__/xplat/`：探测判定（三 OS 各自应得 posix-darwin/posix-linux/windows-powershell）、exec round-trip（echo/引号/管道/路径）、cwd、后台任务、kill、目录传输 round-trip、文件工具各一例。测试内连本机 `ssh2.connect` 到 runner 的 sshd。
- 现有 `.github/workflows/test.yml` 不动，cross-platform 为独立必过检查。

**验收**：三 runner 全绿；故意在 PS 方言里退回旧 wrapper（临时 revert Phase 3 一行）能看到 windows runner 变红。

### Phase 10 — 真实 188 手测清单 + 平台能力矩阵文档（P1）

**范围**：把真机验证固化为可重复执行的清单。

**交付**：
- `docs/superpowers/specs/2026-08-15-xplat-capability-matrix.md`：行=功能（exec/cwd/env/后台/kill/传输/文件工具/host-load），列=方言（posix-gnu/posix-busybox/posix-bsd/powershell/cmd），格=主路径命令 + fallback 链 + CI 覆盖标记。
- `scripts/manual-check-188.sh`：一键跑通 188 的 20 项手测（密钥修复→探测→exec→引号管道→cwd→后台→取消→目录 round-trip→read/grep/list→host-load），每项输出 PASS/FAIL。
- 覆盖审查盲区清单逐项对账（24 项盲区在哪些阶段被消掉）。

**验收**：脚本在 188 上全 PASS；矩阵文档无 TBD。

### Phase 11 — 边界收尾：受限环境与文档（P2）

**范围**：保守模式与用户侧文档。

**改动**：
- 探测畸形时进入保守模式的日志与 MCP 响应提示（`guidance` 字段告知"远端 shell 受限，已降级"）。
- `remote-fs.getHomeDir` 失败回退 `/home/$USER`（[remote-fs.ts:L354](../../src/remote-fs.ts#L354)，盲区 10）改为 SFTP realpath 失败时返回明确错误而非猜路径。
- README 双语补"Windows 远端要求"（OpenSSH + PowerShell 5.1+ 或 pwsh；cmd 模式限制表）。
- coordinator 子系统的 Windows 边界在矩阵文档标注"不支持"，接口留 `dialect` 参数位。

**验收**：文档评审；保守模式有测试。

### Phase 12 — 清理与防御性收口（P2）

**范围**：防回归收口。

**改动**：
- 删除迁移期兼容代码（若 Phase 1-5 留有 `getDialect() ?? posix` 兜底路径，收口为必选注入）。
- `grep -rn "exec sh -c\|setsid\|kill -TERM"` 确认仅存在于 `remote-dialect/posix.ts` 一处。
- 全量回归：`npm run test:all` + cross-platform CI 三 runner。
- 版本号 minor bump（2.0 → 2.1），CHANGELOG 记录 Windows 支持与行为变化（`sleep 0.1→1` 等）。

**验收**：grep 仅一处；全量测试绿；发 tag `v2.1.0-rc1`。

## 4. 阶段依赖图

```text
P0(密钥) ─────────────────────────────┐
P1(抽象+posix) → P2(探测) → P3(PS方言) → P5(执行链接线) → P6(transfer)
                        │            └→ P4(cmd方言)      → P7(file-tools) → P8(mcp杂项)
                        └→ P9(CI矩阵，可在 P1 后先行搭建，随阶段逐步加用例)
P10(手测+矩阵) ← P3/P5/P6/P7/P8
P11(边界) ← P10
P12(收口) ← 全部
```

## 5. 测试策略总览

1. **单元（每阶段内嵌）**：方言构造器字符串精确断言、编码正确性、探测三态判定。
2. **集成（mock ssh2 Server，现有模式）**：wrapper 接线、kill 触发、fallback 链降级。
3. **真机 CI（Phase 9）**：三 OS runner × 核心用例矩阵。
4. **真机 188（Phase 10）**：20 项手测脚本，覆盖现场发现的全部症状（`dir`、`powershell -Command`、引号、管道、反斜杠路径、后台、取消）。
5. **审查盲区对账**：第 0 节审查列出的 24 项盲区在 3/5/6/7/8 阶段逐项消掉，Phase 10 清单对账。

## 6. 风险与决策记录

| # | 风险/决策 | 处理 |
|---|---|---|
| 1 | cmd 方言 PID 标记不可靠 | 标记延迟/占位，文档明示 cmd 模式超时终止可能只关 channel（`remoteProcessMayContinue` 语义已有） |
| 2 | BusyBox `sleep 1` 使终止变慢 | 客户端补偿：kill 发出后不等远端 sleep，channel 立即 close |
| 3 | Windows 无 tar 导致目录传输换 SFTP 递归 | 性能下降可接受（正确性优先）；>1000 文件分批 + 进度回调 |
| 4 | PS `-EncodedCommand` 排查难（远端看到 Base64） | `--debug` 日志落盘解码后的 PS 脚本原文 |
| 5 | 探测命令本身被受限 shell 拒绝 | 三态失败 → posix 回退 + 保守模式，绝不阻塞连接 |
| 6 | 现有 Linux 用户回归风险 | Phase 1 字节一致迁移 + Phase 9 ubuntu runner 矩阵兜底 |
| 7 | 协调器（coordinator）不在本轮 | 矩阵标注不支持，接口留位 |

## 7. 验收总门

12 阶段全部完成的定义：

1. Mac → Win 188 真机：`dir`、`powershell -Command`（含管道/引号/带空格路径）、后台任务、取消、目录 round-trip、文件工具全部可用。
2. CI 三 runner 矩阵全绿且为必过检查。
3. `grep "exec sh -c\|setsid"` 仅 `remote-dialect/posix.ts` 一处。
4. 24 项审查盲区全部有对应测试或明确"不适用"标注。
5. `npm run test:all` 全绿，tag `v2.1.0-rc1` 发布。
