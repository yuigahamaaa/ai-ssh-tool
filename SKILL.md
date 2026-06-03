# SSH Tool - AI 远程执行工具 v2.0

专为 AI Agent 设计的 SSH 工具，支持多级跳板机、MCP 协议、文件传输、后台执行。

> 📄 生产环境部署、架构设计、性能调优等详细说明请查看 [README.md](./README.md)

---

## 项目目录结构

```
ssh-tool/
├── src/                    # 核心源码
│   ├── mcp-server.ts       # MCP 工具入口（AI 调用的接口）
│   ├── profile-manager.ts  # Profile 管理（读取/保存配置）
│   ├── exec-task-manager.ts# 统一任务管理器
│   ├── remote-shell.ts     # 远程命令执行
│   ├── file-transfer.ts    # 文件/文件夹传输
│   ├── connection.ts       # SSH 连接管理
│   ├── session-manager.ts  # 会话管理
│   ├── daemon.ts           # 守护进程
│   ├── port-forwarding.ts  # 端口转发
│   └── types.ts            # 类型定义
├── profiles/               # SSH Profile 配置目录（放 JSON 配置文件）
│   ├── example.json        # 示例配置
│   └── README.md           # Profile 使用说明
├── docs/                   # 开发文档（审核报告、测试设计等）
├── SKILL.md                # AI 使用指南（本文件）
└── README.md               # 生产环境文档
```

---

## 快速入门

### 三种连接远程服务器的方式

| 方式 | 参数 | 推荐度 | 说明 |
|------|------|--------|------|
| Profile 名称 | `profile_name: "prod"` | ⭐⭐⭐ | 先用 `ssh_add_profile` 注册，之后用名称/别名引用 |
| Profile 文件 | `profile_file: "prod.json"` | ⭐⭐⭐ | 放入 `profiles/` 目录，只传文件名即可 |
| Profile JSON | `profile_json: "{...}"` | ⭐ | 临时使用，需要手动转义 JSON |

### Profile 文件路径搜索规则

当使用 `profile_file` 或 `profile_name`（找不到已注册配置时），按以下顺序搜索 `.json` 文件：

1. **绝对路径** → 直接读取
2. **当前工作目录的 `profiles/`** → `./profiles/<name>.json`
3. **项目根目录的 `profiles/`** → `../profiles/<name>.json`（ssh-tool 上一级）
4. **用户主目录** → `~/.ssh-tool/profiles/<name>.json`

> 💡 最简单的方式：把 `.json` 配置文件放到项目根目录的 `profiles/` 文件夹，然后传文件名即可。

---

## MCP 工具一览

### 基础命令

| 工具 | 功能 | 核心参数 |
|------|------|----------|
| `ssh_exec` | 执行远程命令 | `command` |
| `ssh_read_file` | 读取远程文件 | `path` |
| `ssh_write_file` | 写入远程文件 | `path`, `content` |
| `ssh_list_dir` | 列出目录 | `path` |
| `ssh_exists` | 检查路径存在 | `path` |
| `ssh_stat` | 文件信息 | `path` |
| `ssh_grep` | 搜索文件内容 | `pattern`, `path` |
| `ssh_find` | 查找文件 | `path`, `name` |

### 文件传输

| 工具 | 功能 | 核心参数 |
|------|------|----------|
| `ssh_upload` | 上传文件/文件夹 | `local_path`, `remote_path` |
| `ssh_download` | 下载文件/文件夹 | `remote_path`, `local_path` |

### 后台任务

| 工具 | 功能 | 核心参数 |
|------|------|----------|
| `ssh_exec_background` | 后台执行 | `command` |
| `ssh_exec_status` | 查看任务状态 | `task_id` |
| `ssh_exec_cancel` | 取消任务 | `task_id` |
| `ssh_list_tasks` | 列出任务 | `hostname` |

### Profile 管理

| 工具 | 功能 | 核心参数 |
|------|------|----------|
| `ssh_list_profiles` | 列出所有配置 | - |
| `ssh_add_profile` | 添加配置 | `name`, `chain` |
| `ssh_get_profile` | 获取配置详情 | `profile_id/name/alias` |
| `ssh_remove_profile` | 删除配置 | `profile_id/name` |

### 网络 & 会话

| 工具 | 功能 | 核心参数 |
|------|------|----------|
| `ssh_local_forward` | 本地端口转发 | `local_port`, `remote_host`, `remote_port` |
| `ssh_remote_forward` | 远程端口转发 | `remote_port`, `local_host`, `local_port` |
| `ssh_stop_forward` | 停止转发 | `forward_id` |
| `ssh_list_forwards` | 列出转发 | - |
| `ssh_get_host_load` | 主机负载 | - |
| `ssh_list_sessions` | 列出会话 | - |
| `ssh_disconnect` | 断开会话 | `session_id` |
| `ssh_cd` | 切换目录 | `path` |

---

## 使用案例

### 案例 1：用 profiles/ 目录快速连接（推荐）

**步骤 1**：在项目根目录 `profiles/` 下创建 `prod.json`：
```json
{
  "name": "prod",
  "alias": "p",
  "chain": [
    { "host": "192.168.1.100", "port": 22, "username": "root", "privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----" }
  ]
}
```

**步骤 2**：调用工具，只传文件名：
```json
{ "command": "uptime", "profile_file": "prod.json" }
```
或直接用 name 查找（自动搜索 profiles/ 目录）：
```json
{ "command": "uptime", "profile_name": "prod" }
```

### 案例 2：动态注册 Profile
```json
{
  "name": "ssh_add_profile",
  "parameters": { "name": "prod", "alias": "p", "chain": "[{\"host\":\"192.168.1.100\",\"username\":\"root\",\"privateKey\":\"...\"}]" }
}
```
之后用 `profile_name: "prod"` 或 `profile_name: "p"` 访问。

### 案例 3：通过跳板机
```json
{
  "chain": [
    { "host": "bastion.company.com", "username": "ops", "privateKey": "..." },
    { "host": "10.0.0.50", "username": "deploy", "privateKey": "..." }
  ]
}
```

### 案例 4：上传代码到服务器
```json
{
  "name": "ssh_upload",
  "parameters": { "local_path": "/Users/me/my-website", "remote_path": "/var/www/html", "overwrite": "overwrite", "profile_file": "prod.json" }
}
```

### 案例 5：后台任务 + 监控
```json
// 启动
{ "name": "ssh_exec_background", "parameters": { "command": "npm run build", "profile_name": "prod" } }
// 查询状态
{ "name": "ssh_exec_status", "parameters": { "task_id": "abc123" } }
// 查看主机负载
{ "name": "ssh_get_host_load", "parameters": { "profile_name": "prod" } }
```

### 案例 6：端口转发访问内部数据库
```json
{
  "name": "ssh_local_forward",
  "parameters": { "local_port": 5432, "remote_host": "127.0.0.1", "remote_port": 5432, "profile_name": "prod" }
}
```
之后可通过 `localhost:5432` 访问远程数据库。

---

## 认证方式

- **SSH 私钥**（推荐）：在 chain 的 `privateKey` 字段填入私钥内容
- **密码**：在 chain 的 `password` 字段填入密码（仅测试环境）
- **跳板机**：chain 数组依次填入每一跳的配置

---

## 安全注意事项

1. **不要在对话中暴露私钥或密码！** 优先使用 `profile_name` 或 `profile_file`。
2. `profiles/` 目录下的配置文件可能包含敏感信息，**不要提交到 Git**。
3. Profile 文件权限已自动设置为 600（仅所有者可读写）。
4. 生产环境必须使用 SSH 私钥认证，禁止使用密码。
5. 更多安全策略和部署细节请查看 [README.md](./README.md)。
