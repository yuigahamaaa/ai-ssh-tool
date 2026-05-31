# ai-ssh-tool

> SSH tool designed for AI agents — multi-hop jump hosts, MCP server, file/folder transfer, background execution.

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

English | [中文文档](SKILL.md)

---

## Why

AI coding agents (Claude, Cursor, Copilot, etc.) need to work on remote servers through SSH. Existing tools like `node-ssh` or raw `ssh2` are library-level — they don't provide:

- Multi-hop jump host chains (corporate bastion → internal network)
- Persistent connection reuse (avoid repeated handshakes)
- MCP protocol integration for native AI tool calling
- Folder transfer with automatic compression
- Background command execution with status polling

**ai-ssh-tool** fills this gap. It's a complete SSH remote execution platform designed from the ground up for AI agents.

## Features

| Feature | Description |
|---------|-------------|
| **N-hop jump hosts** | Declarative JSON config, connect through any number of bastions |
| **Daemon mode** | Background process keeps connections alive, commands execute instantly |
| **MCP Server** | Standard Model Context Protocol — 17 tools for AI agents |
| **File streaming** | Upload/download large files without loading into memory |
| **Folder transfer** | Compress → transfer → decompress, fully automated |
| **Background exec** | Detached commands with status polling and log streaming |
| **SSH Config** | Auto-parse `~/.ssh/config` with ProxyJump support |
| **Profile management** | Save and reuse connection configs |
| **Cross-platform** | Windows (named pipes) + Unix (socket) |
| **Debug logging** | Per-session log files for troubleshooting |

## Quick Start

```bash
# Install
git clone https://github.com/YOUR_USERNAME/ai-ssh-tool.git
cd ai-ssh-tool
npm install
npm run build

# Create config
echo '{"target":{"host":"192.168.1.100","username":"root","password":"your-password"}}' > my-server.json

# Execute command
node dist/cli/ssh-exec.js --config my-server.json --command "uname -a"
```

## Usage Modes

### 1. CLI — Direct Execution

```bash
# Single command
node dist/cli/ssh-exec.js --config server.json --command "df -h"

# Inline JSON config
node dist/cli/ssh-exec.js --config-json '{"target":{"host":"10.0.0.1","username":"root"}}' --command "uptime"

# Interactive shell
node dist/cli/ssh-exec.js --config server.json --shell
```

### 2. Daemon — Persistent Connections (Recommended)

```bash
# First call auto-starts daemon, subsequent calls reuse connection
node dist/cli/ssh-exec.js daemon exec --config server.json --command "free -h"
node dist/cli/ssh-exec.js daemon exec --config server.json --command "docker ps"

# Manage sessions
node dist/cli/ssh-exec.js daemon sessions
node dist/cli/ssh-exec.js daemon stop
```

### 3. MCP Server — AI Agent Integration (Recommended)

```bash
# Start MCP server (stdio mode)
node dist/mcp-server.js --config server.json

# Or via CLI
node dist/cli/ssh-exec.js mcp --config server.json
```

**Claude Desktop / Cursor config:**

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

### 4. File & Folder Transfer

```bash
# Upload a file (streaming, supports large files)
node dist/cli/ssh-exec.js daemon transfer --config server.json \
  --action upload --local ./app.tar.gz --remote /tmp/app.tar.gz

# Download a file
node dist/cli/ssh-exec.js daemon transfer --config server.json \
  --action download --remote /var/log/syslog --local ./syslog.txt

# Upload a folder (auto compress → transfer → decompress)
node dist/cli/ssh-exec.js daemon transfer --config server.json \
  --action upload-folder --local ./my-project --remote /opt/my-project

# Download a folder
node dist/cli/ssh-exec.js daemon transfer --config server.json \
  --action download-folder --remote /opt/my-project --local ./downloaded
```

### 5. Background Execution (Detach)

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

## MCP Tools (17 total)

| Category | Tool | Description |
|----------|------|-------------|
| Execution | `remote_exec` | Run shell command on remote server |
| File Read | `remote_read_file` | Read file content |
| File Write | `remote_write_file` | Write content to file |
| Directory | `remote_list_dir` | List directory contents |
| Check | `remote_exists` | Check if path exists |
| Stats | `remote_stat` | Get file/dir stats |
| Search | `remote_grep` | Search patterns in files |
| Find | `remote_find` | Find files by name/type |
| Upload | `upload_file` | Upload file via SFTP streaming |
| Download | `download_file` | Download file via SFTP streaming |
| Upload Dir | `upload_folder` | Upload folder (compress → transfer) |
| Download Dir | `download_folder` | Download folder (transfer → decompress) |
| Background | `exec_background` | Start detached command |
| Status | `exec_status` | Get background task status and output |
| Cancel | `exec_cancel` | Cancel running task |
| List | `list_tasks` | List all background tasks |

## Configuration

### Direct Connection

```json
{
  "target": { "host": "10.0.0.1", "port": 22, "username": "root", "password": "xxx" }
}
```

### Via Jump Hosts

```json
{
  "gateways": [
    { "host": "bastion.corp.com", "username": "ops", "password": "xxx" },
    { "host": "internal-gw.local", "username": "admin", "password": "yyy" }
  ],
  "target": { "host": "10.3.3.3", "username": "root", "password": "zzz" }
}
```

### All Options

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `target.host` | Yes | — | Server hostname/IP |
| `target.username` | Yes | — | SSH username |
| `target.password` | No | — | Password (or use privateKey) |
| `target.port` | No | 22 | SSH port |
| `target.privateKey` | No | — | Private key content |
| `gateways` | No | [] | Jump host chain |
| `timeout` | No | 30000 | Connection timeout (ms) |

## Command Reference

| Command | Description |
|---------|-------------|
| `--config <file>` | SSH config file path |
| `--config-json '<JSON>'` | Inline JSON config |
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

## Testing

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

## Debugging

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

## Project Structure

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
├── background-exec.ts   # Detached command execution
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

## Comparison

| Capability | This Tool | Raw SSH | node-ssh | VS Code Remote |
|------------|-----------|---------|----------|----------------|
| N-hop jump hosts | JSON declarative | ProxyJump | jumpHost | Auto |
| Connection reuse | Daemon auto | Manual | Not supported | Auto |
| AI tool integration | 17 MCP tools | None | None | Copilot |
| Folder transfer | Auto compress | Needs scp | None | Built-in |
| Background exec | Detach mode | screen/tmux | None | None |
| Runtime | Node.js | System | Node.js | VS Code |

## License

MIT
