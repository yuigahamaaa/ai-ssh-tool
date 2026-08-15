# 跨平台能力矩阵（功能 × 方言 × 覆盖）与审查盲区对账

> 日期：2026-08-15 ｜ 关联计划：`docs/superpowers/plans/2026-08-15-cross-platform-phase10.md`（Task 2）
> 依据：总设计 `docs/superpowers/specs/2026-08-15-cross-platform-compat-design.md` §2/§3
> 红线：本表所有"主路径命令"直接抄自 `src/` 实现（`remote-dialect/*.ts`、`remote-file-tools.ts`、`mcp-server.ts`、`file-transfer.ts`、`detect.ts`），不做理想化改写，可用 grep 抽查。

## 1. 方言列说明

| 列 | 探测判定（sub） | 典型远端 |
|---|---|---|
| posix-gnu | posix + Linux + 无 BusyBox | Ubuntu/CentOS（glibc） |
| posix-busybox | posix + Linux + `busybox` 命中 | Alpine / 嵌入式 |
| posix-bsd | posix + Darwin / BSD | macOS / FreeBSD |
| powershell | 探针含 `__B__Windows_NT__C__`（`$env:OS` 展开） | Windows OpenSSH（默认 shell 为 PowerShell） |
| cmd | 探针含 `$env:OS` 字面量（`%OS%` 展开） | Windows OpenSSH（默认 shell 为 cmd.exe） |

> 真机 188 实测探测结果为 `kind=cmd sub=powershell`（默认 shell 是 cmd.exe，PowerShell 5.1 已安装）——cmd 方言下所有依赖 PS 的能力经 `powershell -EncodedCommand` 显式调用获得，见 §2 各格。

## 2. 能力矩阵主体

图例：`xplat/exec-detection` → `src/__tests__/xplat/exec-detection.test.ts`；`xplat/lifecycle` → `lifecycle.test.ts`；`xplat/transfer-filetools` → `transfer-filetools.test.ts`；`手测#N` → `scripts/manual-check-188.mjs` 第 N 项；`单测:xxx` → `src/__tests__/xxx.test.ts`。fallback 以 `⤷` 表示（同一格内自左向右降级）。

### 2.1 探测（detect.ts）

| 能力 | posix-gnu | posix-busybox | posix-bsd | powershell | cmd |
|---|---|---|---|---|---|
| 主路径 | `echo __A__%OS%__B__$env:OS__C__` 三态探针（不经任何 wrapper 直接交给远端默认 shell） | 同左 | 同左 | 同左 | 同左 |
| 二级判定 | `uname -s`→Linux→`busybox 2>&1` 命中与否 | 同左 | `uname -s`→Darwin/BSD | `powershell -NoProfile -Command "exit 0"` code=0 | 同左（code≠0 → cmd） |
| 畸形回退 | `classifyProbeOutput` 无展开标记 → 保守 posix | 同左 | 同左 | 同左 | 同左 |
| 覆盖 | 手测#02 ｜ xplat/exec-detection（darwin→posix/darwin、linux→posix/gnu、win→powershell） | xplat/exec-detection | xplat/exec-detection | xplat/exec-detection | 手测#02（188 实测 cmd） |

### 2.2 exec（buildExec）

| 能力 | posix-gnu | posix-busybox | posix-bsd | powershell | cmd |
|---|---|---|---|---|---|
| 主路径 | `echo "SSH_TOOL_PID:$$" >&2; exec sh -c '<cmd>'`（cwd：`cd '<dir>' &&`；env：`export K='v'; `） | 同左 | 同左 | `powershell -NoLogo -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand <UTF-16LE→Base64>`（体：`[Console]::Error.WriteLine("SSH_TOOL_PID:$PID")` + cwd `Set-Location -LiteralPath '<dir>'` + env `$env:K = '<v>'` + `Invoke-Expression -Command '<cmd>'`） | `cmd /d /s /c "echo SSH_TOOL_PID:unavailable 1>&2 & <cmd>"`（cwd：`cd /d "<dir>" &&`；env：`set "K=v" && `；PID 不可用，超时退化为仅关 channel） |
| 转义 | POSIX 单引号（`''` 折叠） | 同左 | 同左 | PS 单引号（`''` 加倍）；多层 shell 不再出现 | cmd 双引号；`&`/`|`/`(` 等由 cmd 解析 |
| 覆盖 | xplat/exec-detection（echo/引号/管道/路径 round-trip） | 同左 | xplat/exec-detection | xplat/exec-detection | 手测#03-#09（echo/引号/管道/反斜杠路径 round-trip） |

### 2.3 cwd（buildCwdResolve + resolveRemoteCwd）

| 能力 | posix-gnu | posix-busybox | posix-bsd | powershell | cmd |
|---|---|---|---|---|---|
| 主路径 | `cd '<dir>' && pwd -P`（无 baseCwd 时 `pwd -P`） | 同左 | 同左 | `Set-Location -LiteralPath '<dir>'; (Get-Location).Path` | `cd /d "<dir>" && cd` |
| 绝对路径校验 | `startsWith("/")` | 同左 | 同左 | `/^[A-Za-z]:[\\/]/` 或 `\\\\` 前缀 | 同 powershell |
| 覆盖 | xplat/lifecycle（cwd 解析） | 同左 | 同左 | xplat/lifecycle | 手测#11（`%TEMP%` 子目录 → 盘符路径） |

### 2.4 env 注入（buildExec 内）

| 能力 | posix-gnu | posix-busybox | posix-bsd | powershell | cmd |
|---|---|---|---|---|---|
| 主路径 | `export K=<shellQuote v>; <cmd>` | 同左 | 同左 | `$env:K = '<v>'`（`assertEnvName` 校验） | `set "K=v" && <cmd>` |
| 覆盖 | 单测:exec-task-manager  | 同左 | 同左 | 手测#12（PASS） | 手测#12 SKIP：cmd 单行 `set K=V && echo %K%` 中 `%K%` 在解析期展开为空（已知 cmd 方言限制） |

### 2.5 后台任务（buildBackground）

| 能力 | posix-gnu | posix-busybox | posix-bsd | powershell | cmd |
|---|---|---|---|---|---|
| 主路径 | `if command -v setsid ...; then setsid sh -c 'echo "SSH_TOOL_PID:$$" >&2; exec sh -c "$1"' ssh-tool '<cmd>'; else nohup sh -c '<cmd>' >/dev/null 2>&1 & echo "SSH_TOOL_PID:$!" >&2; fi`（setsid 缺失环境自动降级 nohup） | 同左 | 同左（macOS 无 setsid → 走 nohup 分支） | 外层 `powershell -EncodedCommand`：`$p = Start-Process -FilePath "powershell" -ArgumentList '-NoProfile','-EncodedCommand','<inner>' -WindowStyle Hidden -PassThru; [Console]::Error.WriteLine("SSH_TOOL_PID:" + $p.Id)` | `cmd /d /s /c "start /b cmd /d /s /c \"<cmd>\""`（无 PID 标记 → 超时终止退化） |
| 覆盖 | xplat/lifecycle（后台启动+存活+kill） | 同左 | xplat/lifecycle | xplat/lifecycle | 手测#13-15 SKIP（cmd 无可靠 PID，改由手测#16/17 的 SFTP 链间接覆盖） |

### 2.6 kill（buildKill）

| 能力 | posix-gnu | posix-busybox | posix-bsd | powershell | cmd |
|---|---|---|---|---|---|
| 主路径 | `kill -TERM <pid> 2>/dev/null; sleep 1; kill -KILL <pid> 2>/dev/null; true`（group：负 PGID 双形态；`sleep 1` 已消除 `sleep 0.1` 非整秒） | 同左 | 同左 | 非 group：`powershell -NoProfile -Command "Stop-Process -Id <pid> -Force -ErrorAction SilentlyContinue"`；group：`taskkill /PID <pid> /T /F` | `taskkill /PID <pid> /T /F` |
| 覆盖 | xplat/lifecycle（kill 后进程消失） | 同左 | 同左 | xplat/lifecycle | 手测#15（powershell 分支） |

### 2.7 单文件传输（uploadFile / downloadFile）

| 能力 | posix-gnu | posix-busybox | posix-bsd | powershell | cmd |
|---|---|---|---|---|---|
| 主路径 | SFTP 流式（`sftp.createReadStream`/`createWriteStream`，文件大小阈值内直读直写）——无方言分支 | 同左 | 同左 | 同左 | 同左 |
| 覆盖 | 单测:file-transfer ｜ xplat/transfer-filetools（目录级字节 round-trip 兼覆盖） | 同左 | 同左 | 手测#16/17（目录级） | 手测#16/17 |

### 2.8 目录传输（uploadFolder / downloadFolder）

| 能力 | posix-gnu | posix-busybox | posix-bsd | powershell | cmd |
|---|---|---|---|---|---|
| 主路径 | 本地 `tar -czf` 压缩（`-I gzip -6` 不可用回退 `-czf`）→ 远端解压（`--overwrite` 不可用回退 `tar -xzpf` + 预 `rm -rf` 目标子项） | 同左（bsdtar/macOS 走 `-czf` 降级） | 同左 | SFTP 递归：`sftpMkdirP` 递归 mkdir + 逐文件 `uploadFile`/`downloadFile`（嵌套父目录逐一 mkdir，避免 put ENOENT） | 同 powershell |
| fallback | GNU tar 长选项探测逐级降级 | 同左 | 同左 | — | — |
| 覆盖 | 单测:file-transfer-folder（含嵌套父目录 mkdir 断言） | 同左 | 同左 | 手测#16（上传 round-trip）/手测#17（下载逐字节一致）｜ xplat/transfer-filetools | 手测#16/17（188 实跑 PASS） |

### 2.9 文件工具（read / list / stat / grep / find，remote-file-tools + remote-tools 降级链）

| 能力 | posix-gnu | posix-busybox | posix-bsd | powershell | cmd |
|---|---|---|---|---|---|
| read_file 主路径 | `wc -c`+`wc -l` 元数据；`sed -n 'S,E p' <path> | head -c N` | 同左（无 `head -c` 时 `⤷ dd bs=1 count=N`，strict 分支） | `Get-Content -LiteralPath '<path>'` 切片 `-join` | SFTP `fs.readFile` |
| list_dir 主路径 | `find <path> -maxdepth 1 -mindepth 1 -printf '%f\t%y\t%s\t%m\t%T@\t%p\n'` | `⤷ buildListDirFallbackCommand`（sh 循环 `ls -ldn`） | `⤷ 同上 fallback`（BSD find 无 `-printf`） | `Get-ChildItem -LiteralPath '<path>' -Force \| ForEach-Object { ... Format-List 风格 6 段 }` | SFTP `fs.readdir`（DirEntry.filename） |
| stat 主路径 | `stat -c '%F\t%s\t%a\t%U\t%G\t%Y\t%n' <path>` | `⤷ buildStatFallbackCommand`（`ls -ldn` 解析） | `⤷ 同上 fallback` | `Get-Item -LiteralPath '<path>' ... Format 7 段` | SFTP `fs.stat`（isDirectory 等为布尔属性） |
| grep 主路径 | `grep -RInIZ [--include='<glob>'] '<pattern>' '<path>'` | `⤷ buildGrepFallbackCommand`（去 `-Z`） | `⤷ 同左` | `Select-String -Path '<path>' -Pattern '<pattern>' -Recurse -ErrorAction SilentlyContinue \| ForEach-Object { 3 段 }` | SFTP 降级（第三级） |
| find 主路径 | `find <path> [-maxdepth N] [-type t] [-name '<name>'] -printf '%p\t%y\t%s\t%T@\n'` | `⤷ buildFindFallbackCommand`（`-exec sh -c '...ls -ldn...'`） | `⤷ 同上 fallback` | `Get-ChildItem -LiteralPath '<path>' -Recurse \| Where-Object {...} \| ForEach-Object { 4 段 }` | SFTP 降级（第三级） |
| 第三级（全方言） | SFTP `createRemoteFs`（生产链末尾统一降级） | 同左 | 同左 | 同左 | 同左 |
| 覆盖 | 单测:remote-file-tools / remote-tools ｜ xplat/transfer-filetools | 单测:remote-file-tools（fallback 构造断言） | 同左 | 手测#18（read/list）｜ 单测:remote-tools | 手测#18（SFTP 分支实跑 PASS） |

### 2.10 写文件（writeRemoteFileViaSftp / ssh_write_file）

| 能力 | posix-gnu | posix-busybox | posix-bsd | powershell | cmd |
|---|---|---|---|---|---|
| 主路径 | SFTP：`sftpMkdirP(远端父目录)` + `fs.writeFile(path, content, mode)`——无方言分支，已彻底删除 `echo\|base64 -d` 管道（ARG_MAX 一并消除） | 同左 | 同左 | 同左 | 同左 |
| 覆盖 | 单测:mcp-server（writeRemoteFileViaSftp 递归 mkdir + 内容断言） | 同左 | 同左 | 同左 | 同左 |

### 2.11 host-load（buildHostLoadCommands）

| 能力 | posix-gnu | posix-busybox | posix-bsd | powershell | cmd |
|---|---|---|---|---|---|
| uptime | `cat /proc/loadavg 2>/dev/null \|\| sysctl -n vm.loadavg` | 同左 | 同左 | `(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToString()` | `powershell -NoProfile -EncodedCommand <同上 CIM>` |
| memory | `cat /proc/meminfo 2>/dev/null \| head -n 8 \|\| vm_stat \| head -n 8` | 同左 | 同左 | `Get-CimInstance Win32_OperatingSystem \| Select-Object TotalVisibleMemorySize,FreePhysicalMemory \| Format-List` | `powershell -NoProfile -EncodedCommand <同上>` |
| proc | `ps -e -o comm 2>/dev/null \| wc -l \|\| ps aux --no-headers \| wc -l` | 同左 | 同左 | `(Get-Process \| Measure-Object).Count` | `powershell -NoProfile -EncodedCommand <同上>` |
| 覆盖 | 单测:mcp-server（portable posix host load） | 同左 | 同左 | 单测:mcp-server（powershell host load）｜ 手测#20（188 PASS） | 单测:mcp-server（cmd 显式 powershell 调用）｜ 手测#20 |

## 3. 审查盲区对账表

> 编号与 §0 审查发现全部来自设计文档 `2026-08-15-cross-platform-compat-design.md`（§0 背景 + §3 各 Phase 内嵌标注）。未在文档中逐条枚举的盲区不臆造，统一标注"以 P9 xplat + P10 手测覆盖"。盲区 10（getHomeDir 猜路径）设计在 Phase 11，本批未交付，明确标注状态。

### 3.1 编号盲区（设计文档 §3 明示）

| # | 盲区描述（出处） | 消除阶段 | 证据 |
|---|---|---|---|
| 1 | wrapper/kill 字符串 8 处重复（`echo "SSH_TOOL_PID:$$" >&2; exec sh -c ...`、`setsid`、kill） | P1-P5（Phase 5 统一 `dialect.buildExec/buildBackground/buildKill/pidMarkerPattern`） | `src/remote-dialect/*.ts`；xplat/exec-detection + lifecycle；手测#03-#09/#13-15 |
| 4 | `ssh_write_file` 走 `echo\|base64 -d` 管道（ARG_MAX） | P8（改 SFTP `writeRemoteFileViaSftp`） | §2.10；单测:mcp-server（writeRemoteFileViaSftp） |
| 5 | host-load 用 `free -h` / `ps --no-headers`（procps/GNU 专属） | P8（`buildHostLoadCommands` 方言化） | §2.11；单测:mcp-server（host load ×3）；手测#20 |
| 6 | `ssh_exists` 未方言化 | P8（`buildExistsCommand`：`test -e`/`Test-Path`/cmd `if exist`） | §2.9 旁注；单测:mcp-server（posix 字节保持/powershell Test-Path/cmd 双引号）；手测#19 |
| 7 | GNU tar 长选项（`--overwrite`、`-I`）在 BSD/Windows 不可用 | P6（tar 链替代：Windows 走 SFTP；POSIX 保留 + GNU 选项探测降级） | §2.8；单测:file-transfer-folder（GNU 选项降级矩阵 + 嵌套父目录）；手测#16/17 |
| 8 | 远端 backup `mv` / rename 循环未方言化 | P6（`Move-Item` / `move /Y`） | §2.8 旁注（file-transfer.ts remoteMove）；单测:file-transfer |
| 9 | `test -L` 软链判定零覆盖 / 未方言化 | P6（`remoteIsSymlink`：PS ReparsePoint / posix `test -L` / cmd 恒 false） | file-transfer.ts remoteIsSymlink；单测:file-transfer |
| 10 | `remote-fs.getHomeDir` 失败回退猜 `/home/$USER` | P11（本批未交付） | **状态：P11 处理中**（设计文档 Phase 11 明示；matrix 标注不支持项） |
| 13 | remote-tools 第三级 SFTP 降级零覆盖 | P7（fallback 链补测试；cmd 方言整链走 SFTP） | §2.9 第三级；手测#18（cmd SFTP 分支实跑）；xplat/transfer-filetools |
| 14 | daemon 后台 cwd 传参缺覆盖 | P5（`resolveRemoteCwd` + `buildCwdResolve` + isValidAbsPath 替换 `startsWith("/")`） | xplat/lifecycle（cwd 解析）；手测#11；单测:daemon-streaming-runner |
| 15 | kill 命令串 5 处重复无断言 | P5（`dialect.buildKill`，group 负 PGID 形态保留） | §2.6；单测:exec-task-manager-delegate（kill 命令串断言）；xplat/lifecycle |
| 21 | 转码 `lineEnding: auto` 按本机 `process.platform` 推断 | P6（改按远端探测结果推断，`sessionKey` 贯穿 file-transfer） | §2.8 旁注；单测:file-transfer-folder（换行符按方言）；手测#16/17 |
| 22 | `read_file` 的 `head -c` / `grep -I` 无 fallback | P7（strict POSIX 降级 `dd bs=1 count=N`；PS 整链 `Get-Content`） | §2.9 read_file；单测:remote-file-tools（strict 分支） |

### 3.2 §0 审查发现（设计文档 §0"除 Windows 外……"与私钥问题）

| 发现 | 消除阶段 | 证据 |
|---|---|---|
| 私钥路径传错（`Cannot parse privateKey: Unsupported key format`） | P0（`resolvePrivateKeyContent` 连接层解析路径字符串） | 手测#01（188 握手 PASS）｜ 单测:private-key / connection |
| `free -h`（procps 专属） | P8 | 同盲区 5 |
| `ps --no-headers`（GNU 旗标） | P8 | 同盲区 5 |
| `sleep 0.1`（POSIX 仅保证整秒） | P5（`buildKill` 统一 `sleep 1`） | §2.6 主路径命令（`sleep 1` 现文）；单测:remote-dialect-posix |
| GNU tar 长选项（`--overwrite`、`-I`） | P6 | 同盲区 7 |
| `base64`（非 POSIX 工具） | P8（删除 `echo\|base64 -d` 路径） | 同盲区 4 |
| 硬编码 `/tmp` | P6（`remoteTmpDir`：仅 posix 需要远端 tar 临时文件 → `/tmp`；非 posix 走 SFTP 无临时文件） | file-transfer.ts remoteTmpDir；手测#16/17 |
| wrapper 重复（8 处） | P1-P5 | 同盲区 1 |

### 3.3 未逐条枚举项

- 设计文档 §3 各 Phase 中标注但未给出独立编号的能力性要求（如 Phase 6 换行符推断、Phase 9 三 runner 起真实 sshd、Phase 7 BusyBox find fallback 矩阵）均**以 P9 xplat + P10 手测 + 对应单测覆盖**，见 §2 各格覆盖列。

## 4. 已知限制与标注（对照总设计"非目标"）

- **coordinator 子系统跨平台**（`/proc` observer、systemd 部署）：不在本矩阵范围，matrix 标注"不支持"，接口保留 `dialect` 参数位（总设计 Phase 11 收口，本批未交付）。
- **交互式 shell（`--shell` 模式）Windows 方言**：非目标，仅覆盖 exec 通道。
- **cmd 方言固有限制**：env `%VAR%` 解析期展开、后台任务无 PID 标记（超时终止退化为仅关 channel）、软链判定恒 false——均在 §2 对应格标注，不列为缺陷。
