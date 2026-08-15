# 跨平台兼容 P9 实施计划（第七批）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GitHub Actions 三 runner（ubuntu / windows / macos）起真实 sshd，端到端跑方言矩阵：探测判定、exec round-trip（echo/引号/管道）、cwd、后台任务、kill、目录传输 round-trip、文件工具各一例。新增独立 workflow `cross-platform.yml`，现有 `test.yml` 不动。

**Architecture:** 新增 `src/__tests__/xplat/`（编译产物 `dist/__tests__/xplat/`，独立于 `test:fast` 的显式文件清单，`test:all` 的 shell glob `dist/__tests__/*.test.js` 不跨目录匹配 → 本地无 sshd 时不会误入常规套件）。测试经 `ssh2.connect` 连本机 sshd（env 可覆盖 host/port/user/key），`probeAndDetect` 后按探测结果走方言分支，覆盖真实的 `buildExec`/`buildBackground`/`buildKill`/`buildCwdResolve` 与 `file-transfer`、`remote-file-tools` 全链路。无 sshd 可达时整体 `skip`（附原因），CI 矩阵 runner 保证 sshd 必在。

**Tech Stack:** TypeScript (ESM, node:test), ssh2, GitHub Actions。

**前置上下文（执行者必读）：**
- P0-P8 已交付：`probeAndDetect`/`classifyProbeOutput`（`src/remote-dialect/detect.ts`：posix 时 uname 细分 darwin/bsd/gnu|busybox，windows 时探测 powershell/cmd）；三方言 `DialectSpec`（`buildExec`/`buildBackground`/`buildKill`/`pidMarkerPattern`/`buildCwdResolve`）
- `remoteShell`：`execRemote(client, cmd, { timeout, sessionKey })` 内部套 `getDialect(sessionKey).buildExec`；`resolveRemoteCwd(client, path, baseCwd?, sessionKey?)`
- `file-transfer`：`uploadFolder`/`downloadFolder` 带 `sessionKey`（非 posix 走 SFTP 递归）
- `remote-file-tools`：`buildListDirCommand`/`buildStatCommand`/`buildGrepCommand`/`buildFindCommand`/`buildReadFileContentCommand` 带 `BuildCommandOptions { kind }`
- `ssh-test-key.ts`：`createStableEd25519KeyPair()` 现成 helper
- 探测协议：`echo __A__%OS%__B__$env:OS__C__`；sub 断言：ubuntu→gnu（无 busybox）、macos→darwin、windows（DefaultShell 设为 PowerShell 后）→powershell
- **本机验证**（macOS，Remote Login 已开启，port 22）：用临时生成的 ed25519 密钥，把 pubkey 追加进 `~/.ssh/authorized_keys`（带 `xplat-local-test` 注释）跑 `test:xplat`，跑完删除该行 + 临时密钥文件。绝不触碰已有 authorized_keys 内容。
- **验证环境**：`npm run build:test`（编译全绿，含 xplat 目录）；`SSH_TOOL_DATA_DIR=/tmp/ssh-tool-sync-data npm run test:fast`（回归 591+72 不回归）；`npm run test:xplat`（连本机 sshd）
- **红线**：xplat 测试不进入 `test:fast`/`test:all`（本地无 sshd 也不炸）；现有套件零改动；不 mock 真实执行链

---

## Task 1: xplat 测试基建 + 探测判定 + exec round-trip

**Files:**
- Add: `src/__tests__/xplat/helpers.ts`
- Add: `src/__tests__/xplat/exec-detection.test.ts`
- Modify: `package.json`

- [ ] **Step 1: 写 helper + 失败/跳过测试**

`helpers.ts`：
- `xplatConfig()`：从 env 读 `XPLAT_SSH_HOST`（默认 `127.0.0.1`）、`XPLAT_SSH_PORT`（默认 `22`）、`XPLAT_SSH_USER`（默认 `os.userInfo().username`）、`XPLAT_SSH_KEY`（默认不设 → 测试内 `createStableEd25519KeyPair` 内存生成）
- `connectXplat(conf)`：`ssh2.connect({ host, port, username, privateKey, readyTimeout: 5000, hostVerifier: () => true })`，resolve client / reject error
- `isReachable(conf)`：短超时 TCP 探测 host:port
- `tryAuth(conf)`：`connectXplat` 成功即 true（随后 close），auth 失败 false

`exec-detection.test.ts`（顶层 `before`：不可达或 auth 失败 → `t.skip` 全部，消息给出授权指引）：
1. 探测判定：`probeAndDetect(client)` → 断言 `kind`/`sub` 按 `process.platform`（win32→powershell/powershell；darwin→posix/darwin；其他→posix/gnu）。探测后 `putCachedDialect(sessionKey, detected)`。
2. exec echo round-trip：`execRemote(client, "echo XPLAT_MARKER_<rand>", { sessionKey })` → code 0 且 stdout 含 marker（引号内不拆分）。
3. 引号 round-trip：按 dialect.kind 选命令：posix `printf 'a b'`；powershell `Write-Output 'a b'` → stdout 等于 `a b`。
4. 管道 round-trip：posix `ls | wc -l`；powershell `(Get-ChildItem | Measure-Object).Count` → code 0 且 stdout 非空。
5. 路径含空格：posix `printf '%s' '/tmp/a b'`；powershell `Write-Output 'C:/a b'` → 原样返回。
6. cmd 方言（若探测为 cmd，仅 CI 兜底）：`echo XPLAT_CMD` → code 0。

- [ ] **Step 2: 红灯/跳过确认**

`npm run build:test` 后跑 `node --test dist/__tests__/xplat/exec-detection.test.js`（本机未授权 → skip 且不炸）。

- [ ] **Step 3: 实现 helper + 本机授权跑通**

按 helper 契约实现；本机追加 pubkey 授权后 `npm run test:xplat` 全绿（posix/darwin 分支）。

- [ ] **Step 4: 绿灯（本机 darwin 分支真实执行）**
- [ ] **Step 5: 回归 + 提交**

```bash
git commit -m "feat: xplat matrix harness with detection and exec round-trip tests"
```

---

## Task 2: cwd / 后台任务 / kill 矩阵测试

**Files:**
- Add: `src/__tests__/xplat/lifecycle.test.ts`

- [ ] **Step 1: 写失败测试**

1. cwd：`resolveRemoteCwd(client, tmpPath, undefined, sessionKey)` 返回合法绝对路径（posix 以 `/` 开头；windows 匹配盘符）；再 `execRemote(client, pwdCmd, { cwd: tmpPath, sessionKey })`（posix `pwd -P`、powershell `(Get-Location).Path`）输出与解析路径一致。
2. 后台 + kill（镜像 daemon 流程）：
   - 取 `getDialect(sessionKey)`，构造命令（posix `sleep 30`、powershell `Start-Sleep -Seconds 30`）
   - `client.exec(dialect.buildBackground(cmd))`，stderr 匹配 `pidMarkerPattern()` 捕获 pid（数字，非 "unavailable"）
   - 断言进程存活：posix `execRemote "kill -0 <pid>"` code 0；powershell `Get-Process -Id <pid>` code 0
   - `client.exec(dialect.buildKill(pid))` 后轮询断言进程消失（posix `kill -0` 非 0；powershell `Get-Process` 非 0）

- [ ] **Step 2: 红灯**（新测试文件，本机跑：cwd 用例绿、后台/kill 用例真实执行）
- [ ] **Step 3: 实现**（若 helper 已有则此步仅为按失败信息修 helper/命令细节）
- [ ] **Step 4: 绿灯**
- [ ] **Step 5: 回归 + 提交**

```bash
git commit -m "feat: xplat cwd and background/kill lifecycle tests"
```

---

## Task 3: 目录传输 round-trip + 文件工具矩阵测试

**Files:**
- Add: `src/__tests__/xplat/transfer-filetools.test.ts`

- [ ] **Step 1: 写失败测试**

1. 目录传输 round-trip：
   - 本地临时目录建 `a.txt`（内容含换行+中文）、`sub/b c.txt`、`sub/nested/d.bin`（随机字节）
   - `uploadFolder(client, localDir, remoteDir, { sessionKey })` → `downloadFolder(client, remoteDir, localOut, { sessionKey })`
   - 断言两目录递归内容逐字节一致（文件名含空格路径可往返）
2. 文件工具各一例（构造 + 真实执行 + 解析断言）：
   - `buildStatCommand(tmpFile, { kind })` → 输出走 stat 解析函数，断言 size/mtime 存在
   - `buildListDirCommand(tmpDir, false, { kind })` → 解析后含刚建的文件名
   - `buildReadFileContentCommand(tmpFile, 0, 4, { kind })` → 内容 = 文件前 4 字节
   - `buildGrepCommand({ path: tmpDir, pattern: 'needle', ... }, { kind })` → 解析命中 1 处
   - `buildFindCommand({ path: tmpDir, name: 'b c.txt', ... }, { kind })` → 解析命中 1 处
   - `buildExistsCommand(absentPath, sessionKey)` 真实执行 → `not_found`；`buildExistsCommand(tmpFile, sessionKey)` → `exists`
   - 解析函数从 `mcp-file-tools`/`remote-file-tools` 现有导出取（与 P7 一致）

- [ ] **Step 2: 红灯**
- [ ] **Step 3: 实现**（多为接线/修命令细节；禁止改产品逻辑来迁就测试）
- [ ] **Step 4: 绿灯**
- [ ] **Step 5: 回归 + 提交**

```bash
git commit -m "feat: xplat folder transfer and file-tools matrix tests"
```

---

## Task 4: package.json test:xplat + cross-platform.yml workflow + 本机收尾

**Files:**
- Modify: `package.json`
- Add: `.github/workflows/cross-platform.yml`

- [ ] **Step 1: 加脚本与 workflow**

`package.json`：
```json
"test:xplat": "npm run build:test && node --test --test-force-exit dist/__tests__/xplat/*.test.js"
```

`.github/workflows/cross-platform.yml`：
- `on: push/PR → main|master + workflow_dispatch`，`runs-on` matrix `[ubuntu-latest, windows-latest, macos-latest]`
- 每 runner 先 `actions/checkout@v4` + `actions/setup-node@v4`（node 22）+ `npm ci`
- 生成一次性 ed25519 密钥（`ssh-keygen -t ed25519 -f $RUNNER_TEMP/xplat_key -N '' -q`），pubkey 注入 authorized_keys，私钥经 env 传给测试：
  - ubuntu：`sudo service ssh start`；`mkdir -p ~/.ssh && cat pub >> ~/.ssh/authorized_keys && chmod 600`
  - macos：`sudo systemsetup -setremotelogin on`；`sudo -u $USER mkdir -p ~/.ssh` + 追加 pub + 修权限
  - windows（pwsh）：`Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0`；设置 `DefaultShell` 注册表为 `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`；`Start-Service sshd`；pubkey 写 `C:\ProgramData\ssh\administrators_authorized_keys`（icacls 收紧 ACL）
- `env: XPLAT_SSH_HOST: 127.0.0.1 / XPLAT_SSH_PORT: 22 / XPLAT_SSH_USER: ${{ ... }} / XPLAT_SSH_KEY: <key path>`（windows user 取 runner 用户名）
- 跑 `npm run test:xplat`
- 独立必过检查：三 runner 全绿才算过

- [ ] **Step 2: 本机验证**：本机授权密钥跑 `npm run test:xplat` 全绿（darwin 分支）；`test:fast`+`test:transfer` 回归不回归
- [ ] **Step 3: 清理**：删除追加进 `~/.ssh/authorized_keys` 的 `xplat-local-test` 行与临时密钥
- [ ] **Step 4: 提交**

```bash
git commit -m "ci: add cross-platform sshd matrix workflow and test:xplat script"
```

---

## 阶段验收（P9 本批完成定义）

1. `npm run build:test` 零错误（xplat 目录编译通过）。
2. 本机（darwin/posix）`npm run test:xplat` 全绿；无 sshd/未授权时整体 skip 不炸。
3. `test:fast`（591）+ `test:transfer`（72）零回归；xplat 不进 `test:all` 常规 glob。
4. 三 runner workflow 提交到 `main` 后应能在 GitHub Actions 全绿（本机无法跑 CI，验收 1-3 为准，CI 结果回填）。

## 后续阶段

P10 真实 188 手测清单 + 能力矩阵文档；P11 边界收尾；P12 清理收口。
