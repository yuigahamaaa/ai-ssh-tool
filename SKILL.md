# AI SSH Tool - 远程执行工具 v2.0

专为 AI Agent 设计的 SSH 工具，支持多级跳板机、MCP 协议、文件/文件夹传输、后台执行。

---

## 核心能力

| 能力 | 说明 |
|------|------|
| N-hop 跳板机 | JSON 声明式配置，支持任意级跳转 |
| Daemon 连接复用 | 后台进程保持连接，命令秒执行 |
| MCP Server | 标准 MCP 协议，AI agent 原生集成 |
| 文件传输 | 单文件流式传输，支持大文件 |
| 文件夹传输 | 压缩 → 传输 → 解压，全自动化 |
| 后台执行 | detach 模式，支持状态查询和日志读取 |
| SSH Config 解析 | 自动读取 `~/.ssh/config` |

---

## 安装

```bash
npm install
npm run build
```

---

## 配置

### 最简配置（直连）

```json
{
  "target": {
    "host": "192.168.1.100",
    "username": "root",
    "password": "你的密码"
  }
}
```

### 通过跳板机连接

```json
{
  "gateways": [
    { "host": "跳板机IP", "username": "用户", "password": "密码" }
  ],
  "target": {
    "host": "目标机IP",
    "username": "用户",
    "password": "密码"
  }
}
```

### 全部字段

| 字段 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `target.host` | 是 | - | 服务器地址 |
| `target.username` | 是 | - | 登录用户名 |
| `target.password` | 否 | - | 密码（和 privateKey 二选一） |
| `target.port` | 否 | 22 | SSH 端口 |
| `target.privateKey` | 否 | - | 私钥内容 |
| `gateways` | 否 | [] | 跳板机列表 |
| `timeout` | 否 | 30000 | 超时时间（毫秒） |

---

## 使用方式

### 1. CLI 直接执行

```bash
# 执行命令
node dist/cli/ssh-exec.js --config server.json --command "uname -a"

# 直接传 JSON
node dist/cli/ssh-exec.js --config-json '{"target":{"host":"10.0.0.1","username":"root"}}' --command "uptime"
```

### 2. Daemon 持久化模式（推荐）

```bash
# 首次自动启动 daemon，后续复用连接
node dist/cli/ssh-exec.js daemon exec --config server.json --command "df -h"
node dist/cli/ssh-exec.js daemon exec --config server.json --command "free -h"

# 查看会话
node dist/cli/ssh-exec.js daemon sessions

# 停止 daemon
node dist/cli/ssh-exec.js daemon stop
```

### 3. MCP Server（AI Agent 推荐）

```bash
# 启动 MCP 服务器（stdio 模式）
node dist/mcp-server.js --config server.json

# 通过 CLI 启动
node dist/cli/ssh-exec.js mcp --config server.json
```

MCP 暴露 17 个工具：
- `remote_exec` — 执行远程命令
- `remote_read_file` / `remote_write_file` — 读写文件
- `remote_list_dir` / `remote_exists` / `remote_stat` — 目录/文件操作
- `remote_grep` / `remote_find` — 搜索
- `upload_file` / `download_file` — 单文件传输（流式）
- `upload_folder` / `download_folder` — 文件夹传输（压缩）
- `exec_background` / `exec_status` / `exec_cancel` / `list_tasks` — 后台执行

### 4. 文件传输

```bash
# 上传文件
node dist/cli/ssh-exec.js daemon transfer --config server.json \
  --action upload --local ./app.tar.gz --remote /tmp/app.tar.gz

# 下载文件
node dist/cli/ssh-exec.js daemon transfer --config server.json \
  --action download --remote /var/log/syslog --local ./syslog.txt

# 上传文件夹（自动压缩传输解压）
node dist/cli/ssh-exec.js daemon transfer --config server.json \
  --action upload-folder --local ./my-project --remote /opt/my-project

# 下载文件夹
node dist/cli/ssh-exec.js daemon transfer --config server.json \
  --action download-folder --remote /opt/my-project --local ./downloaded
```

### 5. 后台执行（detach）

```bash
# 启动后台命令
node dist/cli/ssh-exec.js daemon bg-exec --config server.json \
  --sub start --command "nohup python train.py > train.log 2>&1 &"

# 查询状态
node dist/cli/ssh-exec.js daemon bg-exec --config server.json \
  --sub status --task-id <taskId>

# 读取输出
node dist/cli/ssh-exec.js daemon bg-exec --config server.json \
  --sub output --task-id <taskId>

# 取消任务
node dist/cli/ssh-exec.js daemon bg-exec --config server.json \
  --sub cancel --task-id <taskId>

# 列出所有任务
node dist/cli/ssh-exec.js daemon bg-exec --config server.json --sub list
```

---

## 命令速查

| 命令 | 说明 |
|------|------|
| `--config <文件>` | 配置文件路径 |
| `--config-json '<JSON>'` | 直接传 JSON 配置 |
| `--command "<命令>"` | 要执行的命令 |
| `--shell` | 交互式 shell |
| `--debug` | 调试日志 |
| `daemon start` | 启动 daemon |
| `daemon stop` | 停止 daemon |
| `daemon exec` | 通过 daemon 执行命令 |
| `daemon sessions` | 查看活跃会话 |
| `daemon disconnect <id>` | 断开指定连接 |
| `daemon ping` | 检查 daemon 状态 |
| `daemon transfer` | 文件/文件夹传输 |
| `daemon bg-exec` | 后台执行管理 |
| `mcp` | 启动 MCP 服务器 |

---

## MCP 集成配置

### Claude Desktop / Cursor 配置示例

```json
{
  "mcpServers": {
    "ssh-remote": {
      "command": "node",
      "args": ["/path/to/ssh-tool/dist/mcp-server.js", "--config", "/path/to/server.json"]
    }
  }
}
```

---

## 调试

```bash
# 开启调试日志
node dist/cli/ssh-exec.js --debug --config server.json --command "ls"
# 生成: logs/debug-192.168.1.100-ls-20260531-021557.log
```

| 日志关键字 | 问题 | 处理 |
|-----------|------|------|
| `All configured authentication methods failed` | 认证失败 | 检查用户名/密码 |
| `getaddrinfo ENOTFOUND` | DNS 失败 | 检查 IP 地址 |
| `Timed out while waiting for handshake` | 连接超时 | 检查网络 |
| `ENOENT .ssh-exec-daemon.sock` | Daemon 未启动 | `daemon start` |

---

## 移植

```bash
# 复制整个目录后
npm install && npm run build
```

---

## 测试

### 快速开始 - 日常开发使用
```bash
# 日常开发首选 - 快速单元测试（推荐）
npm run test:fast

# 需要时运行慢速测试
npm run test:slow

# 集成测试
npm run test:integration

# 性能测试
npm run test:performance

# 完整测试
npm run test:all
```

### 测试分组说明 (2025-06-01 更新)
| 命令 | 说明 | 适用场景 | 包含文件 |
|------|------|----------|----------|
| `npm run test:fast` | 快速单元测试 | 日常开发、CI、PR检查 | 18个核心测试 |
| `npm run test:slow` | 慢速 IPC/daemon 测试 | 发布前验证 | `daemon-lifecycle.test.ts` |
| `npm run test:integration` | 集成测试 | 冒烟测试、完整工作流 | `integration.test.ts` |
| `npm run test:performance` | 性能测试 | 性能回归检查 | `performance.test.ts` |

### 重要提示
- **日常开发请使用 `npm run test:fast`**，避免被慢速测试阻塞
- 完整测试审查报告详见：[TEST_REVIEW_20250601.md](./TEST_REVIEW_20250601.md)
- 测试设计文档：[TEST_DESIGN.md](./TEST_DESIGN.md)

### 所有测试文件清单
| 测试文件 | 覆盖模块 | 用例数 | 类型 |
|----------|----------|--------|------|
| `daemon.test.ts` | IPC Protocol、Config Hash | 14 | 快速 |
| `daemon-lifecycle.test.ts` | Daemon IPC 生命周期 | 8 | 慢速 |
| `session-manager.test.ts` | SSHSessionManager | 20 | 快速 |
| `profile-manager.test.ts` | ProfileManager CRUD | 18 | 快速 |
| `remote-shell.test.ts` | remoteExec、execOnChain | 10 | 快速 |
| `remote-fs.test.ts` | SFTP 文件操作 | 17 | 快速 |
| `remote-tools.test.ts` | RemoteTools 工具集 | 22 | 快速 |
| `connection.test.ts` | SSHConnection | 13 | 快速 |
| `gateway.test.ts` | SSHGateway 门面 | 17 | 快速 |
| `logger.test.ts` | 日志模块 | - | 快速 |
| `multi-hop-auth.test.ts` | 多跳认证 | 10+ | 快速 |
| `file-transfer.test.ts` | 文件传输 | 10+ | 快速 |
| `background-exec.test.ts` | 后台执行 | 8+ | 快速 |
| `port-forwarding.test.ts` | 端口转发 | 6+ | 快速 |
| `error-handling.test.ts` | 错误处理 | 12+ | 快速 |
| `mcp-server.test.ts` | MCP 工具集成 | 20+ | 快速 |
| `session-reuse.test.ts` | Session 复用 | 10+ | 快速 |
| `daemon-ipc.test.ts` | Daemon IPC 协议 | 20+ | 快速 |
| `agent-auth.test.ts` | Agent 认证 | 10+ | 快速 |
| `integration.test.ts` | 完整工作流集成 | 20+ | 集成 |
| `performance.test.ts` | 性能基准测试 | 10+ | 性能 |
| **总计** | | **~250+** | |

---

## 与其他方案对比

| 能力 | 本工具 | 原生 ssh | node-ssh | VS Code Remote |
|------|--------|----------|----------|----------------|
| N-hop 跳板机 | JSON 声明 | ProxyJump | jumpHost | 自动 |
| 连接复用 | Daemon 自动 | 手动 | 不支持 | 自动 |
| AI 工具集成 | 17 个 MCP 工具 | 无 | 无 | Copilot |
| 文件夹传输 | 压缩自动传输 | 需 scp | 无 | 内置 |
| 后台执行 | detach 模式 | screen/tmux | 无 | 无 |
| 运行时依赖 | Node.js | 系统自带 | Node.js | VS Code |

---

## 许可

MIT
