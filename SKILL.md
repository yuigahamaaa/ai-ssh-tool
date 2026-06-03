# AI SSH Tool - 远程执行工具 v2.0

专为 AI Agent 设计的 SSH 工具，支持多级跳板机、MCP 协议、文件/文件夹传输、后台执行。

---

## 🚀 快速入门（AI 初学者指南）

### 我是谁？

我是一个专门帮你管理远程服务器的工具！你可以用我来：
- ✅ 在远程服务器上执行命令
- ✅ 上传和下载文件/文件夹
- ✅ 管理多个服务器配置（Profile）
- ✅ 在后台运行长时间任务
- ✅ 建立端口转发访问内部服务

### 我的工作方式

我通过 **MCP 协议** 与你通信。你只需要调用我的工具函数，我就会帮你完成操作！

---

## 📖 核心概念讲解

### 1. Profile（配置文件）

Profile 是一个服务器的连接配置，包含：
- 服务器地址 (host)
- 用户名 (username)
- 认证方式（密码或私钥）
- 可选的跳板机配置

**为什么需要 Profile？**
- 方便管理多个服务器
- 不需要每次都输入完整配置
- 支持动态注册和切换

### 2. 两种使用方式

**方式 A：使用已保存的 Profile**
```json
{
  "profile_name": "my-server"
}
```

**方式 B：动态传入配置**
```json
{
  "profile_json": "{\"id\":\"default\",\"name\":\"default\",\"chain\":[{\"host\":\"192.168.1.100\",\"port\":22,\"username\":\"root\",\"privateKey\":\"-----BEGIN OPENSSH PRIVATE KEY-----...\"}]}"
}
```

### 3. 路径格式

- **本地路径**：你的电脑上的文件路径，如 `/Users/you/project`
- **远程路径**：服务器上的文件路径，如 `/var/www/html`

---

## 🛠️ MCP 工具列表（AI 常用工具速查表）

### 📋 基础工具

| 工具名 | 功能 | 常用参数 |
|--------|------|----------|
| `ssh_exec` | 在远程执行命令 | `command`, `cwd`, `profile_name` |
| `ssh_read_file` | 读取远程文件 | `path`, `offset`, `limit` |
| `ssh_write_file` | 写入远程文件 | `path`, `content` |
| `ssh_list_dir` | 列出目录内容 | `path`, `show_hidden` |
| `ssh_exists` | 检查路径是否存在 | `path` |
| `ssh_stat` | 获取文件/目录信息 | `path` |
| `ssh_grep` | 在文件中搜索 | `pattern`, `path` |
| `ssh_find` | 查找文件 | `path`, `name`, `type` |

### 📤 文件传输工具

| 工具名 | 功能 | 常用参数 |
|--------|------|----------|
| `ssh_upload` | 上传本地文件/文件夹到远程 | `local_path`, `remote_path` |
| `ssh_download` | 下载远程文件/文件夹到本地 | `remote_path`, `local_path` |

### 🔄 后台任务工具

| 工具名 | 功能 | 常用参数 |
|--------|------|----------|
| `ssh_exec_background` | 在后台执行命令 | `command`, `cwd` |
| `ssh_exec_status` | 查看后台任务状态 | `task_id` |
| `ssh_exec_cancel` | 取消后台任务 | `task_id` |
| `ssh_list_tasks` | 列出所有任务 | `hostname` |

### 🔐 Profile 管理工具

| 工具名 | 功能 | 常用参数 |
|--------|------|----------|
| `ssh_list_profiles` | 列出所有配置文件 | 无 |
| `ssh_add_profile` | **动态添加配置** | `name`, `alias`, `chain` |
| `ssh_get_profile` | 获取配置详情 | `profile_id/name/alias` |
| `ssh_remove_profile` | 删除配置 | `profile_id/name` |

### 🌐 网络工具

| 工具名 | 功能 | 常用参数 |
|--------|------|----------|
| `ssh_local_forward` | 本地端口转发 | `local_port`, `remote_host`, `remote_port` |
| `ssh_remote_forward` | 远程端口转发 | `remote_port`, `local_host`, `local_port` |
| `ssh_get_host_load` | 获取服务器负载 | 无 |

### 📡 会话管理工具

| 工具名 | 功能 | 常用参数 |
|--------|------|----------|
| `ssh_list_sessions` | 列出所有会话 | 无 |
| `ssh_disconnect` | 断开指定会话 | `session_id` |
| `ssh_cd` | 切换工作目录 | `path` |

---

## 🎯 实际使用示例（AI 学习案例）

### 案例 1：首次连接服务器

**步骤 1：添加一个新的 Profile**
```json
{
  "name": "ssh_add_profile",
  "parameters": {
    "name": "生产服务器",
    "alias": "prod",
    "chain": "[{\"host\":\"192.168.1.100\",\"port\":22,\"username\":\"root\",\"privateKey\":\"-----BEGIN OPENSSH PRIVATE KEY-----\\n...\\n-----END OPENSSH PRIVATE KEY-----\"}]"
  }
}
```

**步骤 2：执行命令检查服务器**
```json
{
  "name": "ssh_exec",
  "parameters": {
    "command": "uname -a && uptime",
    "profile_name": "prod"
  }
}
```

### 案例 2：上传网站代码到服务器

```json
{
  "name": "ssh_upload",
  "parameters": {
    "local_path": "/Users/me/my-website",
    "remote_path": "/var/www/html",
    "overwrite": "overwrite",
    "profile_name": "prod"
  }
}
```

### 案例 3：后台运行长时间任务

**步骤 1：启动后台任务**
```json
{
  "name": "ssh_exec_background",
  "parameters": {
    "command": "npm run build && npm start",
    "cwd": "/var/www/html",
    "profile_name": "prod"
  }
}
```

**步骤 2：查看任务状态**
```json
{
  "name": "ssh_exec_status",
  "parameters": {
    "task_id": "abc123"
  }
}
```

### 案例 4：访问内部数据库（端口转发）

```json
{
  "name": "ssh_local_forward",
  "parameters": {
    "local_port": 5432,
    "remote_host": "127.0.0.1",
    "remote_port": 5432,
    "profile_name": "prod"
  }
}
```

现在你可以通过 `localhost:5432` 访问远程数据库了！

### 案例 5：下载日志文件

```json
{
  "name": "ssh_download",
  "parameters": {
    "remote_path": "/var/log/nginx/access.log",
    "local_path": "/Users/me/Downloads/access.log",
    "profile_name": "prod"
  }
}
```

---

## 🔑 认证方式详解

### 方式 1：SSH 私钥（推荐，最安全）

```json
{
  "chain": [{
    "host": "192.168.1.100",
    "port": 22,
    "username": "root",
    "privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAACFwAAAAdzc2gtcn\nNhAAAAAwEAAQAAAgEAx...\n-----END OPENSSH PRIVATE KEY-----"
  }]
}
```

### 方式 2：密码（仅测试环境）

```json
{
  "chain": [{
    "host": "192.168.1.100",
    "port": 22,
    "username": "root",
    "password": "your-password"
  }]
}
```

### 方式 3：通过跳板机（N-hop）

```json
{
  "chain": [
    {
      "host": "bastion.company.com",
      "port": 22,
      "username": "ops",
      "privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----\n...跳板机密钥...\n-----END OPENSSH PRIVATE KEY-----"
    },
    {
      "host": "10.0.0.50",
      "port": 22,
      "username": "deploy",
      "privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----\n...目标机密钥...\n-----END OPENSSH PRIVATE KEY-----"
    }
  ]
}
```

---

## ⚠️ 安全注意事项

1. **不要把私钥提交到 Git！**
2. **不要在对话中发送密码或私钥！**
3. 使用 `profile_name` 比直接传入 `profile_json` 更安全
4. Profile 文件权限已设置为 600（仅你可读写）
5. 生产环境必须使用 SSH 私钥，禁止使用密码！

---

## 📊 返回值说明

### 成功响应
```json
{
  "content": [
    {
      "type": "text",
      "text": "命令执行结果或状态信息"
    }
  ]
}
```

### 错误响应
```json
{
  "content": [
    {
      "type": "text",
      "text": "Error: 错误描述"
    }
  ]
}
```

---

## 🎈 小贴士

1. **使用短别名**：为常用服务器设置 `alias`，可以快速访问
2. **先检查再操作**：用 `ssh_exists` 检查路径是否存在
3. **后台任务管理**：长时间运行的任务用 `ssh_exec_background`
4. **服务器负载**：执行任务前可以用 `ssh_get_host_load` 检查负载
5. **清理会话**：不用的会话记得用 `ssh_disconnect` 断开

---

## 📝 完整工具参数参考

### ssh_exec
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| command | string | 是 | 要执行的命令 |
| cwd | string | 否 | 工作目录 |
| timeout | number | 否 | 超时时间（毫秒） |
| profile_name | string | 否 | Profile 名称 |
| profile_json | string | 否 | Profile JSON 字符串 |

### ssh_upload / ssh_download
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| local_path | string | 是（upload） | 本地路径 |
| remote_path | string | 是（download） | 远程路径 |
| compression_level | number | 否 | 压缩级别 1-9 |
| overwrite | string | 否 | ask/skip/overwrite/rename/backup |
| skip_symlinks | boolean | 否 | 是否跳过符号链接 |
| profile_name | string | 否 | Profile 名称 |
| profile_json | string | 否 | Profile JSON 字符串 |

### ssh_add_profile
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | string | 是 | Profile 显示名称 |
| alias | string | 否 | 短别名 |
| chain | string | 是 | 连接链的 JSON 字符串 |
| tags | array | 否 | 标签数组 |

---

## 💡 AI 使用建议

**最佳实践流程：**

1. **列出现有 Profile** → `ssh_list_profiles`
2. **如果没有合适的** → `ssh_add_profile` 添加新配置
3. **检查服务器状态** → `ssh_get_host_load`
4. **执行操作** → `ssh_exec` / `ssh_upload` / `ssh_download`
5. **查看结果** → 根据工具返回判断是否成功
6. **清理资源** → `ssh_disconnect`（如果不再需要）

**常见场景：**
- ✅ 部署代码到服务器
- ✅ 查看服务器日志
- ✅ 运行定时任务
- ✅ 访问内部服务
- ✅ 备份文件

---

**祝你使用愉快！🚀**

如果有任何问题，随时问我！我会帮助你理解和使用这个工具。
