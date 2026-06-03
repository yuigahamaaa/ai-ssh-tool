<div align="center">

# ssh-tool

**SSH tool designed for AI agents — multi-hop jump hosts, MCP server, file/folder transfer, background execution, unified task management, and host load monitoring.**

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-161%20passing-brightgreen)](#testing)

**[English](#english)** | **[中文](#中文)**

</div>

---

<a id="english"></a>

## English

### Why

AI coding agents (Claude, Cursor, Copilot, etc.) need to work on remote servers through SSH. Existing tools like `node-ssh` or raw `ssh2` are library-level — they don't provide:

- Multi-hop jump host chains (corporate bastion → internal network)
- Persistent connection reuse (avoid repeated handshakes)
- MCP protocol integration for native AI tool calling
- Folder transfer with automatic compression
- Background command execution with status polling
- **Unified task tracking (both exec and background)**
- **Cross-process task visibility**
- **Host load monitoring for smart task scheduling**
- **Automatic command timeout termination**

**ai-ssh-tool** fills this gap. A complete SSH remote execution platform designed from the ground up for AI agents.

### Features

| Feature | Description |
|---------|-------------|
| **N-hop jump hosts** | Declarative JSON config, connect through any number of bastions |
| **Daemon mode** | Background process keeps connections alive, commands execute instantly |
| **MCP Server** | Standard Model Context Protocol — 21 tools for AI agents |
| **File streaming** | Upload/download large files without loading into memory |
| **Folder transfer** | Compress → transfer → decompress, fully automated |
| **Unified task management** | Track both `ssh_exec` and `ssh_exec_background` tasks |
| **Cross-process task visibility** | Tasks persist to disk, visible across multiple MCP/Daemon instances |
| **Host load monitoring** | Get CPU, memory, process count, and running tasks |
| **Auto timeout termination** | Automatically kill remote commands on timeout |
| **Atomic writes** | No corrupted task files even if process dies mid-write |
| **Smart cleanup** | Automatic old task removal to prevent garbage buildup |
| **SSH Config** | Auto-parse `~/.ssh/config` with ProxyJump support |
| **Profile management** | Save and reuse connection configs |
| **Cross-platform** | Windows (named pipes) + Unix (socket) |
| **Debug logging** | Per-session log files for troubleshooting |

---

### 🔐 Security Best Practices (IMPORTANT!)

**Always use SSH keys instead of passwords in production!**

#### ✅ Recommended: SSH Key Authentication (Most Secure)

```json
{
  "target": {
    "host": "192.168.1.100",
    "username": "root",
    "privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----\n...your private key content...\n-----END OPENSSH PRIVATE KEY-----"
  }
}
```

#### ⚠️ Password Usage (For testing only!)

```json
{
  "target": {
    "host": "192.168.1.100",
    "username": "root",
    "password": "your-password"
  }
}
```

**⚠️ Critical Warnings:**
- **NEVER commit config files with passwords to Git!**
- Add your config files to `.gitignore`!
- ProfileManager uses XOR obfuscation (NOT encryption) for stored passwords - it only prevents casual viewing
- Always use SSH keys in production!

#### 🛡️ Security Measures

| Measure | Description |
|---------|-------------|
| File permissions | `profiles.json` has 600 permissions (owner-only read) |
| Directory permissions | `~/.opencode/ssh/` has 700 permissions (owner-only access) |
| Password obfuscation | XOR obfuscation (NOT encryption, just prevents casual viewing) |
| Task file permissions | Task JSON files have 600 permissions |

---

### Quick Start

```bash
# Install
git clone https://github.com/yuigahamaaa/ai-ssh-tool.git
cd ai-ssh-tool
npm install
npm run build

# Create config
echo '{"target":{"host":"192.168.1.100","username":"root","password":"your-password"}}' > my-server.json

# Execute command
node dist/cli/ssh-exec.js --config my-server.json --command "uname -a"
```

---

### 🎯 Key New Features

#### 1. Unified Task Management

All tasks (both `ssh_exec` and `ssh_exec_background`) are now tracked in a unified system. You can see every command running on a remote machine, whether it's a short-lived exec or a long-running background task.

```typescript
// Get status of any task
const task = taskManager.getStatus(taskId);

// List all tasks on a specific host
const tasks = taskManager.list("server1.example.com");

// Get all running tasks
const runningTasks = tasks.filter(t => t.status === "running");
```

#### 2. Host Load Monitoring

Use `ssh_get_host_load` to get a complete picture of the remote machine before deciding to run a task:

```typescript
const loadInfo = {
  hostname: "server1.example.com",
  uptime: "10:30:00 up 2 days, 14:32, 1 user, load average: 0.85, 0.90, 0.95",
  memory: "Mem:   16384000k total,   8192000k used,   8192000k free",
  processCount: "127",
  tasks: [
    { id: "abc123", type: "exec", command: "sleep 60", status: "running" },
    { id: "def456", type: "background", command: "python train.py", status: "running" }
  ]
};
```

**AI Agent Decision Logic:**
```python
# Smart task scheduling based on load
def schedule_task(load_info):
    # Parse load average (1-minute, 5-minute, 15-minute)
    load_avg_1m = float(load_info.uptime.split("load average:")[1].split(",")[0].strip())
    
    # Count running tasks
    running_tasks = sum(1 for t in load_info.tasks if t.status == "running")
    
    if load_avg_1m > 2.0:
        return "WAIT"  # High CPU load, wait
    if len(running_tasks) > 5:
        return "WAIT"  # Too many tasks, wait
    return "EXECUTE"   # Good to go!
```

#### 3. Cross-Process Task Visibility

Tasks are persisted to `~/.ssh-tool/exec-tasks/` with atomic writes, so:
- Multiple MCP servers can see each other's tasks
- Daemon and CLI can share task information
- Task state survives process restarts
- No corrupted files even if process dies mid-write

#### 4. Automatic Timeout Termination

When a command times out:
1. We first send `TERM` signal for graceful termination
2. Wait 100ms for cleanup
3. Send `KILL` if still running
4. Clean up resources

```typescript
// auto-kill on timeout
const result = await remoteExec(client, command, { timeout: 30000 });
```

---

### Usage Modes

#### 1. CLI — Direct Execution

```bash
# Single command
node dist/cli/ssh-exec.js --config server.json --command "df -h"

# Inline JSON config
node dist/cli/ssh-exec.js --config-json '{"target":{"host":"10.0.0.1","username":"root"}}' --command "uptime"

# Use saved profile name
node dist/cli/ssh-exec.js --profile-name my-server --command "uptime"

# Use inline profile JSON
node dist/cli/ssh-exec.js --profile-json '{"name":"my-server","chain":[{"name":"target","host":"10.0.0.1","port":22,"auth":{"username":"root","password":"pass"}}]}' --command "uptime"

# Interactive shell
node dist/cli/ssh-exec.js --config server.json --shell
node dist/cli/ssh-exec.js --profile-name my-server --shell
```

#### 2. Daemon — Persistent Connections (Recommended)

```bash
# First call auto-starts daemon, subsequent calls reuse connection
node dist/cli/ssh-exec.js daemon exec --config server.json --command "free -h"
node dist/cli/ssh-exec.js daemon exec --config server.json --command "docker ps"

# Or use profile
node dist/cli/ssh-exec.js daemon exec --profile-name my-server --command "free -h"

# Manage sessions
node dist/cli/ssh-exec.js daemon sessions
node dist/cli/ssh-exec.js daemon stop
```

#### 3. MCP Server — AI Agent Integration (Recommended)

```bash
# Start MCP server (stdio mode)
node dist/mcp-server.js --config server.json

# Or via CLI
node dist/cli/ssh-exec.js mcp --config server.json
```

**Claude Desktop / Cursor / OpenCode config:**

Claude Desktop / Cursor:
```json
{
  "mcpServers": {
    "ssh-remote": {
      "command": "node",
      "args": ["/path/to/ai-ssh-tool/dist/mcp-server.js", "--config", "/path/to/server.json"]
    }
  }
}
```

OpenCode:
```json
{
  "mcpServers": {
    "ssh-remote": {
      "command": "node",
      "args": ["/path/to/ai-ssh-tool/dist/mcp-server.js", "--config", "/path/to/server.json"]
    }
  }
}
```

#### 4. File & Folder Transfer

The unified `upload` and `download` actions auto-detect whether the path is
a file or a folder — no need to choose a separate command for each.

```bash
# Upload a file or folder (auto-detected)
node dist/cli/ssh-exec.js daemon transfer --config server.json \
  --action upload --local ./app.tar.gz --remote /tmp/app.tar.gz
node dist/cli/ssh-exec.js daemon transfer --config server.json \
  --action upload --local ./my-project --remote /opt/my-project

# Download a file or folder (auto-detected)
node dist/cli/ssh-exec.js daemon transfer --config server.json \
  --action download --remote /var/log/syslog --local ./syslog.txt
node dist/cli/ssh-exec.js daemon transfer --config server.json \
  --action download --remote /opt/my-project --local ./downloaded
```

#### 5. Background Execution (Detach)

```bash
# Start a long-running command in background
node dist/cli/ssh-exec.js daemon bg-exec --config server.json \
  --sub start --command "nohup python train.py > train.log 2>&1 &"

# Check status
node dist/cli/ssh-exec.js daemon bg-exec --config server.json \
  --sub status --task-id <taskId>

# Read output
node dist/cli/ssh-exec.js daemon bg-exec --config server.json \
  --sub output --task-id <taskId>

# Cancel
node dist/cli/ssh-exec.js daemon bg-exec --config server.json \
  --sub cancel --task-id <taskId>
```

---

### MCP Tools (21 total)

| Category | Tool | Description |
|----------|------|-------------|
| Execution | `ssh_exec` | Run shell command on remote server |
| File Read | `ssh_read_file` | Read file content |
| File Write | `ssh_write_file` | Write content to file |
| Directory | `ssh_list_dir` | List directory contents |
| Check | `ssh_exists` | Check if path exists |
| Stats | `ssh_stat` | Get file/dir stats |
| Search | `ssh_grep` | Search patterns in files |
| Find | `ssh_find` | Find files by name/type |
| Upload | `ssh_upload` | Upload file or folder (auto-detect: file→SFTP, folder→tar+gzip) |
| Download | `ssh_download` | Download file or folder (auto-detect: file→SFTP, folder→tar+gzip) |
| Background | `ssh_exec_background` | Start detached command |
| Status | `ssh_exec_status` | Get background task status and output |
| Cancel | `ssh_exec_cancel` | Cancel running task |
| List Tasks | `ssh_list_tasks` | List all tasks (exec + background, cross-process visible) |
| Host Load | `ssh_get_host_load` | Get remote host load: CPU, memory, process count, running tasks |
| Port Forward | `ssh_local_forward` | Local port forwarding (local:port -> remote:port |
| Remote Forward | `ssh_remote_forward` | Remote port forwarding (remote:port -> local:port |
| Stop Forward | `ssh_stop_forward` | Stop port forwarding by id |
| List Forwards | `ssh_list_forwards` | List active port forwards |
| Change Dir | `ssh_cd` | Change working directory on remote |
| Profiles | `ssh_list_profiles` | List saved connection profiles |
| Sessions | `ssh_list_sessions` | List active SSH sessions |
| Disconnect | `ssh_disconnect` | Disconnect a session |

---

### Configuration

**Direct connection:**

```json
{
  "target": { "host": "10.0.0.1", "port": 22, "username": "root", "password": "xxx" }
}
```

**Via jump hosts:**

```json
{
  "gateways": [
    { "host": "bastion.corp.com", "username": "ops", "password": "xxx" },
    { "host": "internal-gw.local", "username": "admin", "password": "yyy" }
  ],
  "target": { "host": "10.3.3.3", "username": "root", "password": "zzz" }
}
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `target.host` | Yes | — | Server hostname/IP |
| `target.username` | Yes | — | SSH username |
| `target.password` | No | — | Password (or use privateKey) |
| `target.port` | No | 22 | SSH port |
| `target.privateKey` | No | — | Private key content |
| `gateways` | No | [] | Jump host chain |
| `timeout` | No | 30000 | Connection timeout (ms) |

---

### Command Reference

| Command | Description |
|---------|-------------|
| `--config <file>` | SSH config file path |
| `--config-json '<JSON>'` | Inline JSON config |
| `--profile-name <name>` | Use saved profile name |
| `--profile-json '<JSON>'` | Inline profile JSON |
| `--command "<cmd>"` | Command to execute |
| `--shell` | Interactive shell |
| `--debug` | Enable debug logging |
| `daemon start` | Start daemon |
| `daemon stop` | Stop daemon |
| `daemon exec` | Execute via daemon |
| `daemon sessions` | List active sessions |
| `daemon disconnect <id>` | Disconnect session |
| `daemon ping` | Check daemon status |
| `daemon transfer` | File/folder transfer |
| `daemon bg-exec` | Background execution |
| `mcp` | Start MCP server |

---

### Testing

```bash
npm test
```

161 unit tests across 9 test suites covering all core modules.

| Test File | Module | Cases |
|-----------|--------|-------|
| `daemon.test.ts` | IPC Protocol, Config Hash | 14 |
| `session-manager.test.ts` | Session Manager | 20 |
| `remote-shell.test.ts` | Remote Exec | 10 |
| `profile-manager.test.ts` | Profile CRUD | 18 |
| `daemon-lifecycle.test.ts` | Daemon IPC Lifecycle | 6 |
| `connection.test.ts` | SSH Connection Chain | 13 |
| `remote-fs.test.ts` | SFTP File Operations | 17 |
| `remote-tools.test.ts` | Remote Tools Suite | 22 |
| `gateway.test.ts` | Gateway Facade | 17 |

---

### Debugging

```bash
node dist/cli/ssh-exec.js --debug --config server.json --command "ls"
# Generates: logs/debug-192.168.1.100-ls-20260531-021557.log
```

| Log Keyword | Issue | Fix |
|-------------|-------|-----|
| `All configured authentication methods failed` | Auth failure | Check username/password |
| `getaddrinfo ENOTFOUND` | DNS failure | Check IP address |
| `Timed out while waiting for handshake` | Connection timeout | Check network/firewall |
| `ENOENT .ssh-exec-daemon.sock` | Daemon not running | `daemon start` |

---

### Project Structure

```
src/
├── connection.ts        # SSH connection chain (N-hop)
├── session-manager.ts   # Multi-session management
├── gateway.ts           # Main facade
├── daemon.ts            # Background daemon process
├── daemon-client.ts     # IPC client for daemon
├── ipc-protocol.ts      # IPC message framing
├── mcp-server.ts        # MCP protocol server
├── file-transfer.ts     # File/folder transfer (streaming)
├── background-exec.ts   # Detached command execution (wrapper)
├── exec-task-manager.ts # UNIFIED TASK MANAGER (all exec + background)
├── remote-fs.ts         # SFTP file operations
├── remote-shell.ts      # Remote command execution
├── remote-tools.ts      # Tool definitions for AI
├── profile-manager.ts   # Connection profile storage
├── ssh-config.ts        # ~/.ssh/config parser
├── logger.ts            # Debug logging
├── check-deps.ts        # Dependency checker
├── types.ts             # TypeScript type definitions
└── cli/
    ├── ssh-exec.ts      # CLI entry point
    └── daemon-commands.ts
```

---

### Comparison

| Capability | This Tool | Raw SSH | node-ssh | VS Code Remote |
|------------|-----------|---------|----------|----------------|
| N-hop jump hosts | JSON declarative | ProxyJump | jumpHost | Auto |
| Connection reuse | Daemon auto | Manual | Not supported | Auto |
| AI tool integration | 21 MCP tools | None | None | Copilot |
| Folder transfer | Auto compress | Needs scp | None | Built-in |
| Background exec | Detach mode | screen/tmux | None | None |
| **Unified task tracking** | ✅ All tasks | ❌ | ❌ | ❌ |
| **Cross-process visibility** | ✅ | ❌ | ❌ | ❌ |
| **Host load monitoring** | ✅ | ❌ | ❌ | ❌ |
| **Auto timeout termination** | ✅ | ❌ | ❌ | ❌ |
| Runtime | Node.js | System | Node.js | VS Code |

---

### License

MIT

---

<a id="中文"></a>

## 中文

### 为什么需要这个工具

AI 编程助手（Claude、Cursor、Copilot 等）需要通过 SSH 操作远程服务器。现有的 `node-ssh` 或原生 `ssh2` 只是库级别的封装，缺少：

- 多级跳板机链路（公司堡垒机 → 内网服务器）
- 持久连接复用（避免重复握手）
- MCP 协议集成（AI 原生工具调用）
- 文件夹自动压缩传输
- 后台命令执行 + 状态轮询
- **统一任务追踪（exec 和 background 都追踪）**
- **跨进程任务可见性**
- **主机负载监控，智能任务调度**
- **命令超时自动终止**

**ai-ssh-tool** 专为解决这些问题而生，是一个为 AI Agent 从零设计的完整 SSH 远程执行平台。

### 核心能力

| 能力 | 说明 |
|------|------|
| **N 级跳板机** | JSON 声明式配置，支持任意级跳转 |
| **Daemon 持久化** | 后台进程保持连接，命令秒级执行 |
| **MCP Server** | 标准 MCP 协议，21 个工具供 AI 调用 |
| **流式文件传输** | 大文件上传/下载，不占内存 |
| **文件夹传输** | 压缩 → 传输 → 解压，全自动 |
| **统一任务管理** | 同时追踪 `ssh_exec` 和 `ssh_exec_background` 任务 |
| **跨进程任务可见** | 任务持久化到磁盘，多 MCP/Daemon 实例都可见 |
| **主机负载监控** | 获取 CPU、内存、进程数、运行中任务 |
| **超时自动终止** | 命令超时后自动终止远程进程 |
| **原子写入** | 即使进程中途挂掉，也不会产生损坏的任务文件 |
| **智能清理** | 自动清理旧任务，防止垃圾堆积 |
| **SSH Config** | 自动解析 `~/.ssh/config`，支持 ProxyJump |
| **配置管理** | 保存和复用连接配置 |
| **跨平台** | Windows（命名管道）+ Unix（Socket） |
| **调试日志** | 每个会话独立日志文件，便于排查 |

---

### 🔐 安全最佳实践（必读！）

**生产环境请务必使用 SSH 密钥，不要使用密码！**

#### ✅ 推荐方式：SSH 密钥认证（最安全）

```json
{
  "target": {
    "host": "192.168.1.100",
    "username": "root",
    "privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----\n...你的私钥内容...\n-----END OPENSSH PRIVATE KEY-----"
  }
}
```

#### ⚠️ 密码认证（仅用于测试环境！）

```json
{
  "target": {
    "host": "192.168.1.100",
    "username": "root",
    "password": "你的密码"
  }
}
```

**⚠️ 重要警告：**
- **永远不要把包含密码的配置文件提交到 Git！**
- 把你的配置文件添加到 `.gitignore`！
- ProfileManager 使用 XOR 混淆（**不是加密**）存储密码 - 仅防止随手查看
- 生产环境必须使用 SSH 密钥！

#### 🛡️ 已有的安全措施

| 措施 | 说明 |
|------|------|
| 文件权限 | `profiles.json` 权限为 600（仅所有者可读） |
| 目录权限 | `~/.opencode/ssh/` 权限为 700（仅所有者可访问） |
| 密码混淆 | XOR 混淆（非加密，仅防随手看） |
| 任务文件权限 | 任务 JSON 文件权限为 600 |

---

### 🎯 新增核心功能

#### 1. 统一任务管理

现在所有任务（`ssh_exec` 和 `ssh_exec_background`）都在统一系统中追踪。你可以看到远程机器上运行的每一个命令，不管是短时间的 exec 还是长期运行的 background。

```typescript
// 获取任意任务状态
const task = taskManager.getStatus(taskId);

// 列出特定主机上的所有任务
const tasks = taskManager.list("server1.example.com");

// 获取所有运行中的任务
const runningTasks = tasks.filter(t => t.status === "running");
```

#### 2. 主机负载监控

使用 `ssh_get_host_load` 在决定是否执行任务前获取远程机器的完整状态：

```typescript
const loadInfo = {
  hostname: "server1.example.com",
  uptime: "10:30:00 up 2 days, 14:32, 1 user, load average: 0.85, 0.90, 0.95",
  memory: "Mem:   16384000k total,   8192000k used,   8192000k free",
  processCount: "127",
  tasks: [
    { id: "abc123", type: "exec", command: "sleep 60", status: "running" },
    { id: "def456", type: "background", command: "python train.py", status: "running" }
  ]
};
```

**AI Agent 决策逻辑：**
```python
# 基于负载的智能任务调度
def schedule_task(load_info):
    # 解析负载平均值（1分钟、5分钟、15分钟）
    load_avg_1m = float(load_info.uptime.split("load average:")[1].split(",")[0].strip())
    
    # 统计运行中的任务
    running_tasks = sum(1 for t in load_info.tasks if t.status == "running")
    
    if load_avg_1m > 2.0:
        return "WAIT"  # CPU 负载高，等待
    if len(running_tasks) > 5:
        return "WAIT"  # 任务太多，等待
    return "EXECUTE"   # 可以执行！
```

#### 3. 跨进程任务可见性

任务通过原子写入持久化到 `~/.ssh-tool/exec-tasks/`，所以：
- 多个 MCP 服务器可以互相看到任务
- Daemon 和 CLI 可以共享任务信息
- 任务状态在进程重启后仍然保留
- 即使进程中途挂掉也不会产生损坏的文件

#### 4. 超时自动终止

当命令超时时：
1. 首先发送 `TERM` 信号让进程优雅终止
2. 等待 100ms 让进程清理
3. 如果还在运行，发送 `KILL` 强制终止
4. 清理所有资源

```typescript
// 超时自动终止
const result = await remoteExec(client, command, { timeout: 30000 });
```

---

### 快速开始

```bash
# 安装
git clone https://github.com/yuigahamaaa/ai-ssh-tool.git
cd ai-ssh-tool
npm install
npm run build

# 创建配置
echo '{"target":{"host":"192.168.1.100","username":"root","password":"你的密码"}}' > my-server.json

# 执行命令
node dist/cli/ssh-exec.js --config my-server.json --command "uname -a"
```

---

### 使用方式

#### 1. CLI 直接执行

```bash
# 执行单条命令
node dist/cli/ssh-exec.js --config server.json --command "df -h"

# 直接传 JSON（不需要配置文件）
node dist/cli/ssh-exec.js --config-json '{"target":{"host":"10.0.0.1","username":"root"}}' --command "uptime"

# 使用保存的配置
node dist/cli/ssh-exec.js --profile-name my-server --command "uptime"

# 使用直接传 profile JSON
node dist/cli/ssh-exec.js --profile-json '{"name":"my-server","chain":[{"name":"target","host":"10.0.0.1","port":22,"auth":{"username":"root","password":"pass"}}]}' --command "uptime"

# 交互式 shell
node dist/cli/ssh-exec.js --config server.json --shell
node dist/cli/ssh-exec.js --profile-name my-server --shell
```

#### 2. Daemon 持久化模式（推荐）

```bash
# 首次自动启动 daemon，后续复用连接，无需重复握手
node dist/cli/ssh-exec.js daemon exec --config server.json --command "free -h"
node dist/cli/ssh-exec.js daemon exec --config server.json --command "docker ps"

# 管理会话
node dist/cli/ssh-exec.js daemon sessions
node dist/cli/ssh-exec.js daemon stop
```

#### 3. MCP Server — AI Agent 集成（推荐）

```bash
# 启动 MCP 服务器（stdio 模式）
node dist/mcp-server.js --config server.json

# 或通过 CLI 启动
node dist/cli/ssh-exec.js mcp --config server.json
```

**Claude Desktop / Cursor / OpenCode 配置示例：**

Claude Desktop / Cursor:
```json
{
  "mcpServers": {
    "ssh-remote": {
      "command": "node",
      "args": ["/path/to/ai-ssh-tool/dist/mcp-server.js", "--config", "/path/to/server.json"]
    }
  }
}
```

OpenCode:
```json
{
  "mcpServers": {
    "ssh-remote": {
      "command": "node",
      "args": ["/path/to/ai-ssh-tool/dist/mcp-server.js", "--config", "/path/to/server.json"]
    }
  }
}
```

#### 4. 文件 / 文件夹传输

`upload` 和 `download` 自动判断路径是文件还是文件夹，无需再选子命令。

```bash
# 上传文件 / 文件夹（自动判断）
node dist/cli/ssh-exec.js daemon transfer --config server.json \
  --action upload --local ./app.tar.gz --remote /tmp/app.tar.gz
node dist/cli/ssh-exec.js daemon transfer --config server.json \
  --action upload --local ./my-project --remote /opt/my-project

# 下载文件 / 文件夹（自动判断）
node dist/cli/ssh-exec.js daemon transfer --config server.json \
  --action download --remote /var/log/syslog --local ./syslog.txt
node dist/cli/ssh-exec.js daemon transfer --config server.json \
  --action download --remote /opt/my-project --local ./downloaded
```

#### 5. 后台执行（detach 模式）

```bash
# 启动后台命令，立即返回 task handle
node dist/cli/ssh-exec.js daemon bg-exec --config server.json \
  --sub start --command "nohup python train.py > train.log 2>&1 &"

# 查询任务状态
node dist/cli/ssh-exec.js daemon bg-exec --config server.json \
  --sub status --task-id <taskId>

# 读取输出日志
node dist/cli/ssh-exec.js daemon bg-exec --config server.json \
  --sub output --task-id <taskId>

# 取消任务
node dist/cli/ssh-exec.js daemon bg-exec --config server.json \
  --sub cancel --task-id <taskId>
```

---

### MCP 工具列表（共 21 个）

| 类别 | 工具名 | 说明 |
|------|--------|------|
| 执行 | `ssh_exec` | 在远程服务器执行 shell 命令 |
| 读文件 | `ssh_read_file` | 读取远程文件内容 |
| 写文件 | `ssh_write_file` | 写入远程文件 |
| 目录 | `ssh_list_dir` | 列出目录内容 |
| 检查 | `ssh_exists` | 检查路径是否存在 |
| 信息 | `ssh_stat` | 获取文件/目录 stat 信息 |
| 搜索 | `ssh_grep` | 在远程文件中搜索正则 |
| 查找 | `ssh_find` | 按名称/类型查找文件 |
| 上传 | `ssh_upload` | 上传文件 / 文件夹（自动判断：文件→SFTP，目录→tar+gzip） |
| 下载 | `ssh_download` | 下载文件 / 文件夹（自动判断：文件→SFTP，目录→tar+gzip） |
| 后台 | `ssh_exec_background` | 启动后台命令 |
| 状态 | `ssh_exec_status` | 查询后台任务状态和输出 |
| 取消 | `ssh_exec_cancel` | 取消运行中的任务 |
| 任务列表 | `ssh_list_tasks` | 列出所有任务（exec + background，跨进程可见） |
| 主机负载 | `ssh_get_host_load` | 获取远程主机负载（CPU、内存、进程数、运行中任务） |
| 端口转发 | `ssh_local_forward` | 本地端口转发（本地端口 → 远程端口） |
| 远程转发 | `ssh_remote_forward` | 远程端口转发（远程端口 → 本地端口） |
| 停止转发 | `ssh_stop_forward` | 按 id 停止端口转发 |
| 转发列表 | `ssh_list_forwards` | 列出活跃的端口转发 |
| 切换目录 | `ssh_cd` | 切换远程工作目录 |
| 配置列表 | `ssh_list_profiles` | 列出保存的连接配置 |
| 会话列表 | `ssh_list_sessions` | 列出活跃的 SSH 会话 |
| 断开连接 | `ssh_disconnect` | 断开指定会话 |

---

### 配置说明

**直连：**

```json
{
  "target": { "host": "10.0.0.1", "port": 22, "username": "root", "password": "xxx" }
}
```

**通过跳板机：**

```json
{
  "gateways": [
    { "host": "bastion.corp.com", "username": "ops", "password": "xxx" },
    { "host": "internal-gw.local", "username": "admin", "password": "yyy" }
  ],
  "target": { "host": "10.3.3.3", "username": "root", "password": "zzz" }
}
```

| 字段 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `target.host` | 是 | — | 服务器地址 |
| `target.username` | 是 | — | 登录用户名 |
| `target.password` | 否 | — | 密码（和 privateKey 二选一） |
| `target.port` | 否 | 22 | SSH 端口 |
| `target.privateKey` | 否 | — | 私钥内容 |
| `gateways` | 否 | [] | 跳板机列表 |
| `timeout` | 否 | 30000 | 连接超时（毫秒） |

---

### 命令速查

| 命令 | 说明 |
|------|------|
| `--config <文件>` | 配置文件路径 |
| `--config-json '<JSON>'` | 直接传 JSON 配置 |
| `--profile-name <名称>` | 使用保存的配置名称 |
| `--profile-json '<JSON>'` | 直接传 profile JSON |
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

### 测试

```bash
npm test
```

161 个单元测试，覆盖 9 个核心模块。

| 测试文件 | 覆盖模块 | 用例数 |
|----------|----------|--------|
| `daemon.test.ts` | IPC 协议、配置哈希 | 14 |
| `session-manager.test.ts` | 会话管理器 | 20 |
| `remote-shell.test.ts` | 远程命令执行 | 10 |
| `profile-manager.test.ts` | 配置文件管理 | 18 |
| `daemon-lifecycle.test.ts` | Daemon IPC 生命周期 | 6 |
| `connection.test.ts` | SSH 连接链 | 13 |
| `remote-fs.test.ts` | SFTP 文件操作 | 17 |
| `remote-tools.test.ts` | 远程工具集 | 22 |
| `gateway.test.ts` | Gateway 门面 | 17 |

---

### 调试

```bash
node dist/cli/ssh-exec.js --debug --config server.json --command "ls"
# 生成日志: logs/debug-192.168.1.100-ls-20260531-021557.log
```

| 日志关键字 | 问题 | 处理 |
|-----------|------|------|
| `All configured authentication methods failed` | 认证失败 | 检查用户名/密码 |
| `getaddrinfo ENOTFOUND` | DNS 解析失败 | 检查 IP 地址 |
| `Timed out while waiting for handshake` | 连接超时 | 检查网络/防火墙 |
| `ENOENT .ssh-exec-daemon.sock` | Daemon 未启动 | 执行 `daemon start` |

---

### 项目结构

```
src/
├── connection.ts        # SSH 连接链（N 级跳转）
├── session-manager.ts   # 多会话管理
├── gateway.ts           # 主门面
├── daemon.ts            # 后台守护进程
├── daemon-client.ts     # IPC 客户端
├── ipc-protocol.ts      # IPC 消息协议
├── mcp-server.ts        # MCP 协议服务器
├── file-transfer.ts     # 文件/文件夹传输（流式）
├── background-exec.ts   # 后台命令执行（包装器）
├── exec-task-manager.ts # 统一任务管理器（所有 exec + background）
├── remote-fs.ts         # SFTP 文件操作
├── remote-shell.ts      # 远程命令执行
├── remote-tools.ts      # AI 工具定义
├── profile-manager.ts   # 连接配置管理
├── ssh-config.ts        # ~/.ssh/config 解析
├── logger.ts            # 调试日志
├── check-deps.ts        # 依赖检查
├── types.ts             # TypeScript 类型定义
└── cli/
    ├── ssh-exec.ts      # CLI 入口
    └── daemon-commands.ts
```

---

### 与其他方案对比

| 能力 | 本工具 | 原生 SSH | node-ssh | VS Code Remote |
|------|--------|----------|----------|----------------|
| N 级跳板机 | JSON 声明式 | ProxyJump | jumpHost | 自动 |
| 连接复用 | Daemon 自动 | 手动 | 不支持 | 自动 |
| AI 工具集成 | 21 个 MCP 工具 | 无 | 无 | Copilot |
| 文件夹传输 | 自动压缩 | 需 scp | 无 | 内置 |
| 后台执行 | detach 模式 | screen/tmux | 无 | 无 |
| **统一任务追踪** | ✅ 所有任务 | ❌ | ❌ | ❌ |
| **跨进程可见性** | ✅ | ❌ | ❌ | ❌ |
| **主机负载监控** | ✅ | ❌ | ❌ | ❌ |
| **超时自动终止** | ✅ | ❌ | ❌ | ❌ |
| 运行时 | Node.js | 系统自带 | Node.js | VS Code |

---

### 许可证

MIT
