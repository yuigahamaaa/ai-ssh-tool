# SSH-Tool 功能与测试设计审核报告

> 审核日期: 2026-05-21
> 审核视角: 使用者体验 + 测试完备性

---

## 一、功能架构总览

```
SSHGateway (门面)
├── SSHSessionManager (会话管理, 上限50)
│   └── SSHConnection (N-hop SSH 链)
├── ProfileManager (配置持久化)
└── RemoteTools (远程工具集)
    ├── RemoteFs (SFTP 文件操作)
    └── remoteExec (远程命令执行)

SSHDaemon (守护进程)
├── IPC Protocol (命名管道/Unix Socket)
├── DaemonClient (CLI 侧 IPC 客户端)
└── Session 复用 (MD5 哈希配置文件)
```

模块划分清晰，职责单一，`SSHGateway` 作为门面屏蔽了内部复杂度。

---

## 二、功能审核

### 2.1 连接能力

| 能力 | 状态 | 评价 |
|------|------|------|
| 直连 (0-hop) | ✅ | 正常 |
| 单跳板机 (1-hop) | ✅ | 通过 `forwardOut` 隧道 |
| 多跳板机 (N-hop) | ✅ | 逐级隧道，反向清理 |
| 密码认证 | ✅ | |
| 私钥认证 | ✅ | |
| 私钥密码 (passphrase) | ✅ | |
| 超时控制 | ✅ | 连接级 + 命令级 |
| Keepalive | ✅ | 30s 间隔, 3 次上限 |
| 终端 resize | ✅ | |

**问题:**

1. **无 SSH config 文件支持** — 不能读取 `~/.ssh/config`，用户必须手动构造 JSON 配置。对已有 SSH 配置的用户不友好。
2. **无 ssh-agent 转发** — 不支持 `AgentForwarding`，无法用本地 agent 中的密钥做二次跳转认证。
3. **无 ProxyCommand 支持** — 只支持 `forwardOut` 隧道，不支持 SOCKS5 或自定义代理命令。
4. **连接无重连机制** — 网络闪断后 session 直接进入 `error` 状态，需手动重连。Daemon 模式下也不会自动重连。

### 2.2 会话管理

| 能力 | 状态 | 评价 |
|------|------|------|
| 多会话并发 | ✅ | 上限可配置 |
| 会话状态追踪 | ✅ | 5 种状态 |
| 事件订阅 | ✅ | 支持单会话和全局 |
| 活动时间戳 | ✅ | |
| 最大连接数限制 | ✅ | 默认 50 |

**问题:**

5. **会话无自动恢复** — Daemon 的 `connect` action 基于配置文件哈希复用，但如果底层连接已断开（如服务器重启），不会检测连接有效性就直接复用。`isConnected()` 方法存在但 Daemon 层未使用。
6. **`disconnect` 后 session 仍可被 `getSession` 访问到** — `session-manager.ts:104` 将 session 从 map 中删除，但 `disconnect` 抛出的 `disconnected` 事件在删除之前就已触发，如果有其他代码在事件回调中查询 session，会得到 `undefined`。

### 2.3 远程工具 (RemoteTools)

| 工具 | 状态 | 安全性评价 |
|------|------|-----------|
| `remote_read_file` | ✅ | 正常 |
| `remote_write_file` | ✅ | 正常 |
| `remote_exec` | ✅ | 正常 |
| `remote_list_dir` | ✅ | 正常 |
| `remote_exists` | ✅ | 正常 |
| `remote_stat` | ✅ | 正常 |
| `remote_grep` | ✅ | 使用 `JSON.stringify` 转义参数 |
| `remote_find` | ✅ | 使用 `JSON.stringify` 转义参数 |
| `remote_cd` | ✅ | 验证目录存在 |

**问题:**

7. **`remote_grep` 命令注入风险** — [remote-tools.ts:187](src/remote-tools.ts#L187) 中 `params.path` 用 `JSON.stringify` 包裹后传给 shell，但如果 `grep` 版本不支持 `--include` 的这种引号格式，可能产生歧义。虽然不是严重的注入漏洞（因为本身就是远程执行），但构造上不够健壮。
8. **`remote_find` 的 `maxDepth` 未做数值校验** — 如果传入负数或非整数，`find` 命令会报错，但错误信息不够友好。
9. **`remote_exec` 的 `cwd` 默认为 `/home/{username}`** — [gateway.ts:165](src/gateway.ts#L165) 如果远程用户 home 目录不在标准路径（如 macOS 的 `/Users/`），首次使用 `remote_cd` 前的命令会失败。
10. **`readFile` 不支持二进制文件** — 强制 `encoding: "utf-8"`，读取二进制文件会产生乱码。
11. **`writeFile` 无覆盖确认** — 直接覆盖，无法保护已有文件。

### 2.4 Daemon 模式

| 能力 | 状态 | 评价 |
|------|------|------|
| 后台守护进程 | ✅ | |
| IPC 通信 | ✅ | Windows 命名管道 / Unix Socket |
| 会话复用 | ✅ | 配置文件 MD5 哈希 |
| 空闲超时断开 | ✅ | 默认 10 分钟 |
| 自动启动 | ✅ | 首次 exec 时自动拉起 |
| PID 文件管理 | ✅ | |
| 优雅关闭 | ✅ | SIGTERM/SIGINT |

**问题:**

12. **配置文件 key 顺序影响会话复用** — [daemon.test.ts:131](src/__tests__/daemon.test.ts#L131) 测试中已记录此行为，但对用户来说是个坑：同一个服务器配置，手动调整 JSON key 顺序后会创建新会话而非复用。应使用 deep-equal 或规范化的 JSON 序列化。
13. **Daemon 无健康检查** — `ping` 仅检查 IPC 通道是否畅通，不检查底层 SSH 连接是否存活。
14. **空闲超时检查间隔 30s** — 对于 10 分钟超时来说合理，但如果用户将超时设得很短（如 1 分钟），30s 的检查间隔可能导致连接存在最多 1 分 29 秒。
15. **Daemon 日志缺失** — 无文件日志输出，排查 daemon 问题只能看进程是否存活。
16. **PID 文件无 stale 检测** — 如果 daemon 异常崩溃（SIGKILL），PID 文件残留会导致下次启动时 `isRunning()` 误判为 true。`ensureDaemon` 中虽有重试逻辑，但未先清理 stale PID。

### 2.5 Profile 管理

| 能力 | 状态 | 评价 |
|------|------|------|
| CRUD 操作 | ✅ | |
| 按名称/标签搜索 | ✅ | |
| 最近使用排序 | ✅ | |
| 密码混淆 | ⚠️ | XOR 混淆，非加密 |

**问题:**

17. **XOR 密码"加密"安全性极低** — [profile-manager.ts](src/profile-manager.ts) 使用 XOR 混淆，密钥为硬编码字符串 `"opencode-ssh"`。任何有此代码的人都能还原密码。文档中应明确警告这是混淆而非加密，或直接移除此功能，改为只支持私钥认证。
18. **Profile 文件权限未限制** — `~/.opencode/ssh/profiles.json` 可能包含密码明文/XOR 混淆值，但未设置文件权限为 600。在多用户系统上存在信息泄露风险。

### 2.6 CLI 体验

**问题:**

19. **存在两个 CLI 入口** — `cli/ssh-exec.ts` 和 `cli/index.ts`，命令体系不同，用户容易混淆。`index.ts` 使用 `#!/usr/bin/env bun`，强依赖 Bun 运行时。
20. **长命令需要转义** — `--command "cd /app && ls"` 在 Windows cmd 和 bash 中行为不同，跨平台使用需注意。
21. **无 `--verbose` / `--debug` 标志** — 连接失败时缺乏调试信息输出。

---

## 三、测试设计审核

### 3.1 现状（已更新）

| 维度 | 覆盖情况 | 评分 |
|------|----------|------|
| 测试文件数 | 9 | |
| 测试用例数 | 161 | |
| 测试框架 | `node:test` + `node:assert/strict` | |
| 覆盖模块 | 全部核心模块 | |

### 3.2 已覆盖测试

| 测试文件 | 模块 | 用例数 | 评价 |
|----------|------|--------|------|
| `daemon.test.ts` | IPC Protocol、Config Hash、IPC 类型 | 13 | ✅ 协议层完备 |
| `session-manager.test.ts` | SSHSessionManager 全 API | 20 | ✅ 生命周期、上限、事件 |
| `remote-shell.test.ts` | remoteExec、execOnChain | 10 | ✅ mock ssh2 Client |
| `profile-manager.test.ts` | ProfileManager CRUD、搜索、加密 | 18 | ✅ 含持久化验证 |
| `daemon-lifecycle.test.ts` | Daemon IPC 生命周期 | 6 | ✅ ping/list/shutdown/并发 |
| `connection.test.ts` | SSHConnection 连接链、状态、事件 | 13 | ✅ 验证+失败清理 |
| `remote-fs.test.ts` | RemoteFs SFTP 文件操作 | 17 | ✅ mock SFTPWrapper |
| `remote-tools.test.ts` | RemoteTools 9 个远程工具 | 22 | ✅ 工具名/schema/功能 |
| `gateway.test.ts` | SSHGateway 门面、defaultGateways | 17 | ✅ 链构建、profile |

### 3.3 仍未覆盖的模块

| 模块 | 风险 | 说明 |
|------|------|------|
| CLI 参数解析 | 🟢 低 | `ssh-exec.ts` 的参数解析逻辑 |
| Daemon 空闲超时清扫 | 🟡 中 | 定时器驱动，需时间 mock |
| 配置文件哈希的连接复用 | 🟡 中 | 需完整 Daemon + SSH 集成 |

### 3.4 已修复的测试设计缺陷

- ✅ #22 SSHSessionManager 已有 20 个单元测试
- ✅ #23 引入 mock 层（mock ssh2 Client/SFTPWrapper）
- ✅ #24 空洞断言已修复为规范化哈希比较
- ✅ SSHConnection、RemoteFs、RemoteTools、SSHGateway 均已覆盖

---

## 四、使用者体验审核

### 4.1 优点

- **快速上手** — 3 步即可使用，配置文件格式直观
- **文档完善** — SKILL.md 中文文档，含速查表、示例、错误排查
- **Daemon 复用** — 持久化模式减少重复连接开销
- **示例配置** — 直连和 2-hop 示例配置文件可直接参考
- **跨平台** — Windows 命名管道 + Unix Socket，setup.bat/sh 覆盖

### 4.2 体验痛点

| 编号 | 痛点 | 影响 |
|------|------|------|
| P1 | 密码明文存储在 JSON 配置文件中 | 安全风险，特别是分享配置时 |
| P2 | 无连接状态的 CLI 反馈 | `daemon exec` 长时间无输出时用户不知是否在连接中 |
| P3 | 无 `--dry-run` 模式 | 无法预览将执行的操作 |
| P4 | 无连接超时的 CLI 可配置 | CLI 层未暴露 `--timeout` 参数 |
| P5 | 无 `daemon restart` 命令 | 需要 stop + start 两步操作 |
| P6 | 错误信息无 i18n | 混合中英文，不统一 |

---

## 五、建议优先级

### P0 — 必须修复

| 编号 | 建议 |
|------|------|
| #16 | Daemon 的 config hash 改用 `JSON.stringify(JSON.parse(content))` 规范化，消除 key 顺序影响 |
| #17 | 密码存储要么移除，要么改用系统 keychain (如 `keytar`)，至少文档中加醒目安全警告 |
| #22 | 为 `SSHSessionManager` 补充单元测试（纯 mock，无网络依赖） |
| #24 | 修复空洞断言，改为有意义的测试或删除 |

### P1 — 强烈建议

| 编号 | 建议 |
|------|------|
| #5 | Daemon 连接复用前检查 `isConnected()`，断开则自动重连 |
| #12 | 使用 deep-equal 比较配置对象而非原始文件哈希 |
| #18 | Profile 文件写入后设置 `chmod 600` |
| #19 | 统一 CLI 入口，移除或合并 `cli/index.ts` |
| #23 | 引入 mock 层（如 `mock-ssh2`），补充核心模块测试 |
| #25 | 基于 Docker sshd 配置编写集成测试 |

### P2 — 建议改进

| 编号 | 建议 |
|------|------|
| #1 | 支持解析 `~/.ssh/config` 文件 |
| #4 | 添加自动重连机制（指数退避） |
| #7 | `remote_grep`/`remote_find` 参数转义改用 `shellescape` 库 |
| #9 | `remote_exec` 的默认 cwd 改用 `$(getent passwd $USER | cut -d: -f6)` 动态获取 |
| #10 | `readFile` 增加 binary 模式支持 |
| #20 | CLI 参数添加 `--verbose` / `--debug` 输出级别 |
| #26 | 补充错误场景测试（超时、认证失败、连接断开） |
| #27 | 补充并发场景测试 |

---

## 六、测试设计建议方案

### 6.1 单元测试（无网络依赖）

```
__tests__/
├── ipc-protocol.test.ts       ← 已有，保持
├── session-manager.test.ts    ← 新增，mock SSHConnection
├── profile-manager.test.ts    ← 新增，mock fs
├── remote-tools.test.ts       ← 新增，mock RemoteFs + remoteExec
├── config-hash.test.ts        ← 从 daemon.test.ts 拆出
└── cli-args.test.ts           ← 新增，测试参数解析
```

### 6.2 集成测试（需 Docker SSH）

```
__tests__/integration/
├── connection.test.ts         ← 直连 Docker sshd
├── daemon-lifecycle.test.ts   ← 启动/连接/exec/超时/关闭
├── session-reuse.test.ts      ← 同配置复用验证
└── remote-fs.test.ts          ← SFTP 读写验证
```

### 6.3 关键测试场景清单

```
□ 单 hop 直连成功
□ N-hop 隧道连接成功
□ 认证失败 → 正确错误信息
□ 连接超时 → 正确清理
□ 并发 5 个会话 → 各自独立
□ 第 51 个会话 → 拒绝并报错
□ Daemon 空闲超时 → 自动断开
□ Daemon 配置变更 → 新建会话
□ Daemon 异常退出 → PID 清理
□ SFTP 读写大文件 (10MB+)
□ 命令执行超时
□ 特殊字符路径 (空格、中文、emoji)
□ remote_grep 注入尝试
□ Profile CRUD + 持久化
□ 会话断开后事件传播
```

---

## 七、总结

| 维度 | 评分 | 说明 |
|------|------|------|
| 功能完整度 | ⭐⭐⭐⭐ | 核心 SSH 能力齐全，N-hop 链、Daemon、远程工具集完备 |
| 代码质量 | ⭐⭐⭐⭐ | 模块划分清晰，TypeScript 类型完善，事件驱动架构合理 |
| 文档质量 | ⭐⭐⭐⭐⭐ | 中文文档详尽，有速查表、示例、错误排查 |
| 测试覆盖 | ⭐⭐⭐⭐ | 161 个用例，全部核心模块覆盖，mock 层完备 |
| 安全性 | ⭐⭐ | 密码 XOR 混淆无实际保护，Profile 文件无权限控制 |
| 使用体验 | ⭐⭐⭐⭐ | 上手简单，Daemon 复用高效，缺调试和状态反馈 |

**总体评价**: 功能设计优秀，测试覆盖已从 76 个用例提升至 161 个，核心模块（Connection、SessionManager、RemoteFs、RemoteTools、Gateway）均有单元测试。剩余短板在安全方面 — 密码存储方案需要重新考虑。
