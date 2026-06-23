# SSH Tool - AI 远程执行工具 v2.0

专为 AI Agent 设计的 SSH 工具，支持多级跳板机、MCP 协议、文件传输、后台执行、智能调度器。

> 📄 生产环境部署、架构设计、性能调优等详细说明请查看 [README.md](./README.md)
> 📄 AI Agent 上手 SOP 请查看 [docs/AI_AGENT_USAGE.zh-CN.md](./docs/AI_AGENT_USAGE.zh-CN.md)
> 📄 调度器设计文档请查看 [docs/AI_COLLABORATIVE_SCHEDULER_DESIGN.zh-CN.md](./docs/AI_COLLABORATIVE_SCHEDULER_DESIGN.zh-CN.md)

---

## 项目目录结构

```
ssh-tool/
├── src/                    # 核心源码
│   ├── mcp-server.ts       # MCP 工具入口（AI 调用的接口）
│   ├── scheduler/          # 共享调度器（默认执行路径）
│   ├── profile-manager.ts  # Profile 管理（读取/保存配置）
│   ├── exec-task-manager.ts# legacy 本地任务存储（兼容旧后台执行）
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
4. **平台数据目录** → `<platform-data-dir>/profiles/<name>.json`（可用 `SSH_TOOL_DATA_DIR` 覆盖）
5. **旧版目录** → `~/.opencode/ssh/<name>.json`

> 💡 最简单的方式：把 `.json` 配置文件放到项目根目录的 `profiles/` 文件夹，然后传文件名即可。

---

## MCP 工具一览

### 基础命令

| 工具 | 功能 | 核心参数 |
|------|------|----------|
| `ssh_exec` | 执行会结束的远程命令（通过调度器并等待结果） | `command` |
| `ssh_read_file` | 结构化读取远程文本文件，优先于 `ssh_exec cat/sed/head` | `path` |
| `ssh_write_file` | 结构化写入远程文本文件，优先于 shell echo/cat/base64 | `path`, `content` |
| `ssh_list_dir` | 列出目录 | `path` |
| `ssh_exists` | 检查路径存在 | `path` |
| `ssh_stat` | 文件信息 | `path` |
| `ssh_grep` | 搜索文件内容 | `pattern`, `path` |
| `ssh_find` | 查找文件 | `path`, `name` |

### 文件工具返回契约

文件类 MCP 工具返回统一 JSON envelope：`ok`、`kind`、`data`、`error`、`agentGuidance`。AI 应优先读取结构化字段，不要解析展示文本。

- `ssh_read_file`: `data.content` 是带行号文本；同时看 `binaryDetected`、`truncated`、`sizeBytes`、`totalLines`、`contentBytes`、`maxContentBytes`。若 `binaryDetected=true` 或需要完整无损文件，使用 `ssh_download`，不要自行 shell/base64。
- `ssh_list_dir`: 读 `data.entries[]` 的 `name`、`path`、`type`、`sizeBytes`、`mode`、`mtime`。
- `ssh_stat`: 读 `data.path`、`type`、`sizeBytes`、`mode`、`owner`、`group`、`mtime`。
- `ssh_grep`: 读 `data.matches[]` 的 `file`、`line`、`text`，并用 `count`/`noMatches` 判断结果。
- `ssh_find`: 读 `data.results[]` 的 `path`、`type`、`sizeBytes`、`mtime`，并用 `count`/`noResults` 判断结果。

### 调度器 & 队列管理（新增！）

| 工具 | 功能 | 核心参数 |
|------|------|----------|
| `ssh_exec` | 执行命令（走调度器，等待完成） | `command`, `scheduler` |
| `ssh_schedule` | 提交重任务并快速返回 taskId（异步） | `command`, `intent`, `cost` |
| `ssh_queue_status` | 查看队列状态 | `host_id`, `limit` |
| `ssh_wait_task` | 等待任务完成 | `task_id`, `timeout` |
| `ssh_dequeue_task` | 从队列移除任务 | `task_id` |
| `ssh_cd` | 设置当前 AI 会话在该 host 上的默认 cwd | `path` |
| `ssh_get_cwd` | 查询当前 AI 会话在该 host 上的默认 cwd | 连接参数 |

### 项目命令配方

| 工具 | 功能 | 核心参数 |
|------|------|----------|
| `ssh_command_list` | 按 project 列出已保存命令，运行记忆里的命令前先查 | `project` |
| `ssh_command_get` | 按 `project + name` 查询命令配方 | `project`, `name` |
| `ssh_command_register` | 保存或覆盖可复用项目命令 | `project`, `name`, `command`, `cwd`, `execution` |
| `ssh_command_update` | 局部修改命令、cwd、说明或执行模式 | `project`, `name` |
| `ssh_command_delete` | 删除过期命令配方 | `project`, `name` |
| `ssh_command_run` | 查询或托管运行命令；默认 managed，返回 taskId | `project`, `name`, `run_mode` |

命令配方使用版本化 JSON envelope 保存，当前 `schemaVersion=1`，并兼容旧的数组格式。默认存储在 scheduler 状态目录（通常是 `<platform-data-dir>/scheduler/state/commands.json`；可用 `SSH_TOOL_DATA_DIR` 覆盖）。保存、修改、删除会使用跨进程文件锁，并在写入前重新读取最新文件再合并，避免多个 MCP 会话互相覆盖。

未显式设置 `execution.mode` 时默认 `background`，适合测试、构建、脚本、服务等长命令；短命令可显式设为 `exec`。`ssh_command_run(run_mode="managed")` 走共享 scheduler/background，不绕过同一台 VM 上其他人的任务，会按现有 `intent`、`cost`、`if_busy` 和锁规则排队或串行。`log.mode` 固定为 `managed`，日志由 scheduler/output store 托管，AI 用 `taskId` 调 `ssh_exec_status` 查看，不需要默认下载到本地。

### 文件传输

| 工具 | 功能 | 核心参数 |
|------|------|----------|
| `ssh_upload` | 上传文件/文件夹 | `local_path`, `remote_path` |
| `ssh_download` | 下载文件/文件夹 | `remote_path`, `local_path` |

#### 传输工具使用契约

- `ssh_upload` / `ssh_download` 是二进制安全、无损传输路径。完整文件、大文件、压缩包、二进制文件必须优先用它们；不要自行 `base64`、`cat`、`echo` 传输，除非用户明确要求。
- 返回值是统一 envelope：读取 `data.success`、`action`、`targetType`、`sourcePath`、`requestedPath`、`finalPath`、`sourceBytes`、`bytesTransferred`、`checksum`、`verification`、`overwriteStrategy`、`skipped`、`overwritten`、`renamed`、`backupPath`。
- 后续读写、执行、解压、校验时用 `data.finalPath`，不要猜目标路径；`rename` 或目录目标识别会让它不同于 `requestedPath`。
- 覆盖策略只有非交互式 `overwrite`（默认）、`skip`、`rename`、`backup`；没有 `ask`。
- 上传文件：`remote_path=/dir/name.ext` 表示精确文件名，`/dir/` 或已存在远端目录表示保留本地 basename。
- 下载文件：`local_path=/dir/name.ext` 表示精确文件名，已有目录或以 `/` 结尾表示保留远端 basename。
- 下载文件夹：`local_path` 是父目录；若解压出的同名目录存在，按 `skip/rename/backup` 处理，并查看 `finalPath`。

### 后台任务

| 工具 | 功能 | 核心参数 |
|------|------|----------|
| `ssh_exec_background` | 首选用于服务、watch、tail -f、长构建等长运行命令 | `command` |
| `ssh_exec_status` | 查看任意 scheduler taskId 的状态和输出 | `task_id` |
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
| `ssh_get_host_load` | 主机负载 + scheduler 状态 | - |
| `ssh_list_sessions` | 列出会话 | - |
| `ssh_disconnect` | 断开会话 | `session_id` |
| `ssh_cd` | 设置当前 AI 会话在该 host 上的默认 cwd | `path` |
| `ssh_get_cwd` | 查询当前 AI 会话在该 host 上的默认 cwd | 连接参数 |

---

## 给 AI Agent 的默认操作规则

1. 运行项目常用命令前，先用 `ssh_command_list` / `ssh_command_get` 查保存过的配方，不要靠对话记忆重构。
2. 发现可复用项目命令时，用 `ssh_command_register` 保存；命令、cwd 或执行模式变化时用 `ssh_command_update`；过期时用 `ssh_command_delete`。
3. 命令配方默认适合长命令：优先用 `ssh_command_run(run_mode="managed")`，它会托管给 scheduler/background 并返回 `taskId`；只想自己执行时用 `run_mode="lookup"`。
4. 会很快结束的检查命令用 `ssh_exec`，例如 `pwd`、`ls`、`git status`、短 `rg`、短脚本。
5. 服务启动、watch mode、`tail -f`、日志流、长时间运行的 dev server，第一次就用 `ssh_exec_background`，然后用 `ssh_exec_status` 查看。
6. 测试、构建、安装、脚本、迁移、部署这类重任务，若不使用命令配方且不需要立即等完整结果，优先用 `ssh_schedule` 提交并保存 `taskId`。
7. 读写普通文本文件优先用 `ssh_read_file` / `ssh_write_file`，不要用 `ssh_exec cat/sed/echo/base64` 代替；完整文件、二进制、大文件优先用 `ssh_upload` / `ssh_download`。
8. 不要绕过调度器。只有确认两个任务互不竞争 CPU、端口、工作目录、依赖缓存、数据库或全局状态时，才使用 `if_busy: "run_anyway"`。
9. `scheduler: "bypass"` 是紧急逃生口，不是常规并发开关。它仍会登记任务，但会跳过排队。
10. 如果返回 `action: "queued"`，不要重复提交同一个命令。保存 `taskId`，先做不依赖该结果的读文件、搜索、方案整理，再用 `ssh_wait_task`、`ssh_exec_status` 或 `ssh_queue_status` 查询。
11. 如果返回 `waitTimedOut: true`，命令没有失败，只是前台等待超时。用 `ssh_exec_status` 查看同一个 `taskId`，不要直接重跑；如果这是服务/watch/log 命令，下次一开始就用 `ssh_exec_background`。
12. 如果返回 `result.truncated: true`，内联 stdout/stderr 只是 tail。完整输出在 `result.stdoutPath` / `result.stderrPath`，需要时读取文件或用 `ssh_exec_status(mode="full")`。
13. 不要用远端 `cd` 期待跨工具调用保持目录。用 `ssh_cd` 设置当前 AI 会话的默认 cwd，或每次显式传 `cwd`；不确定时用 `ssh_get_cwd` 或读返回的 `cwdState`。

### 返回结构读取规则

调度相关 MCP 工具统一返回 JSON envelope：

```json
{
  "ok": true,
  "kind": "schedule_decision",
  "data": {},
  "agentGuidance": []
}
```

AI 优先读 `ok`、`kind`、`data`、`agentGuidance`。`ssh_exec` / `ssh_schedule` 为兼容旧提示词，仍会把 `action`、`taskId`、`result` 等调度字段保留在顶层。

---

## 调度器使用指南（新增！）

### ssh_exec 工作原理

`ssh_exec` 现在默认通过调度器执行，行为如下：

1. **调度决策**：`schedule()` 函数决定任务是立即执行还是排队
2. **等待完成**：当决策是 `run_now` 时，内部会 `waitTask` 等待任务执行完毕
3. **返回结果**：最终返回调度决策；若已完成，会带 `result`
4. **输出保护**：内联输出默认只返回尾部，完整 stdout/stderr 落盘并通过路径暴露

```json
// 轻量命令通常会立即执行
{
  "name": "ssh_exec",
  "parameters": { "command": "uptime", "profile_name": "prod" }
}
// 返回：
{
  "ok": true,
  "kind": "schedule_decision",
  "action": "run_now",
  "taskId": "task-xxx",
  "data": {
    "action": "run_now",
    "taskId": "task-xxx"
  },
  "agentGuidance": [],
  "result": {
    "stdout": " 10:00:00 up 1 day",
    "stderr": "",
    "code": 0,
    "truncated": false,
    "stdoutBytes": 20,
    "stderrBytes": 0,
    "stdoutPath": "<platform-data-dir>/scheduler/outputs/t_xxx.stdout",
    "stderrPath": "<platform-data-dir>/scheduler/outputs/t_xxx.stderr"
  }
}
```

```json
// 排队场景（有其他任务在执行）
{
  "name": "ssh_exec",
  "parameters": { "command": "npm run build", "profile_name": "prod" }
}
// 返回：
{
  "ok": true,
  "kind": "schedule_decision",
  "action": "queued",
  "taskId": "task-xxx",
  "queuePosition": 1,
  "data": {
    "action": "queued",
    "taskId": "task-xxx",
    "queuePosition": 1
  },
  "agentGuidance": [
    "Task was queued. Do not immediately resubmit the same command..."
  ],
  "reason": "Host has conflicting tasks; command queued.",
  "recommendedNextStep": "Do unrelated read-only work; call ssh_wait_task or ssh_queue_status later."
}
```

`ssh_exec_status` 返回 `kind: "task_status"`，适用于 `ssh_exec`、`ssh_exec_background`、`ssh_schedule`、`ssh_wait_task` 返回的任意 scheduler `taskId`。主数据在 `data.task` 和 `data.output`。`ssh_wait_task` 返回 `kind: "wait_result"`，若 `data.waitTimedOut=true`，不要重跑原命令；继续等待或查同一个 `taskId`。

### 高级参数

| 参数 | 可选值 | 说明 |
|------|--------|------|
| `scheduler` | `"auto"`（默认） / `"bypass"` | `auto`=走调度器排队；`bypass`=跳过排队直接执行（仍会记录任务状态） |
| `intent` | `"inspect"` / `"search"` / `"test"` / `"build"` / `"install"` / `"server"` / `"deploy"` / `"migration"` / `"cleanup"` / `"custom"` | 任务意图（用于调度决策） |
| `cost` | `"tiny"` / `"small"` / `"medium"` / `"large"` / `"exclusive"` | 预估成本（用于调度决策） |
| `urgency` | `"low"` / `"normal"` / `"high"` / `"urgent"` | 紧急程度（用于记录和后续策略扩展） |
| `if_busy` | `"run_anyway"` / `"wait"` / `"queue"` / `"fail"` | 主机忙时策略：默认 heavy/medium 会 `queue`；`run_anyway` 是显式并发许可 |
| `force` | `true` / `false` | `true`=强制执行有风险的命令 |

### 任务分类说明

| cost | 描述 | 并发性 |
|------|------|--------|
| `tiny` | 简单读命令（ls, cat, uptime 等） | 可与其他任务并发 |
| `small` | 轻量任务 | 可与其他任务并发 |
| `medium` | 普通任务（默认分类） | 默认会排队，避免未知命令抢占 |
| `large` | 耗时任务（test, build, install, script 等） | 默认串行；除非显式 `if_busy="run_anyway"` |
| `exclusive` | 独占任务（会修改全局状态） | 独占主机，阻塞所有其他任务 |

### 输出读取规则

`ssh_exec` 和 `ssh_exec_status` 默认返回 bounded tail，避免把 AI 上下文塞爆。返回里会包含：

- `stdoutBytes` / `stderrBytes`：真实输出字节数
- `truncated`：内联输出是否被截断
- `stdoutPath` / `stderrPath`：完整输出文件路径

当 `truncated=true` 时，优先读取 `stdoutPath` / `stderrPath` 中和错误相关的片段；不要因为没看到完整日志就重跑测试或构建。

### 虚拟工作目录（ssh_cd）

`ssh_cd` 不会在远端共享 shell 中留下一个持久 `cd` 状态。它会把默认 cwd 按 `当前 AI agent + host` 存起来；后续 `ssh_exec` / `ssh_schedule` 没有显式传 `cwd` 时，工具内部会自动在这个目录下执行命令。

```json
// 设置当前 Agent 在目标主机的工作目录
{
  "name": "ssh_cd",
  "parameters": { "path": "/var/www/html", "profile_name": "prod" }
}
// 后续同一个 AI + 同一个 host 的命令会默认在该目录下执行
{
  "name": "ssh_exec",
  "parameters": { "command": "ls -la", "profile_name": "prod" }
}
// 如果不确定当前默认目录，先查询
{
  "name": "ssh_get_cwd",
  "parameters": { "profile_name": "prod" }
}
```

> 💡 虚拟目录按 `Agent + Host` 隔离，不同 Agent 互不影响，也不会改变共享 SSH 会话的真实 shell 状态。

注意：远端 shell 里的 `cd /repo` 只影响当前这条命令。跨工具调用要保持目录，请用 `ssh_cd` 或显式传 `cwd`。当你不确定当前目录时，优先读返回里的 `cwdState` 或调用 `ssh_get_cwd`，不要只靠上下文记忆。

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
服务、watch mode、`tail -f`、日志流、长构建、迁移这类可能持续很久的命令，第一次就用后台执行：

```json
// 启动
{ "name": "ssh_exec_background", "parameters": { "command": "npm run build", "profile_name": "prod" } }
// 查询状态
{ "name": "ssh_exec_status", "parameters": { "task_id": "abc123" } }
// 查看主机负载和 scheduler 状态
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

### 案例 7：调度器高级用法（新增！）

#### 场景 7.1：普通执行（默认走调度器）
```json
{
  "name": "ssh_exec",
  "parameters": {
    "command": "ls -la",
    "profile_name": "prod"
  }
}
```

#### 场景 7.2：指定 intent 和 cost（影响调度）
```json
{
  "name": "ssh_exec",
  "parameters": {
    "command": "npm run build",
    "intent": "build",
    "cost": "large",
    "profile_name": "prod"
  }
}
```

#### 场景 7.3：显式允许并发（确认互不影响时）
```json
{
  "name": "ssh_exec",
  "parameters": {
    "command": "pytest tests/unit/test_parser.py",
    "intent": "test",
    "cost": "large",
    "if_busy": "run_anyway",
    "reason": "Only runs isolated unit tests in a separate worktree; safe to run concurrently.",
    "profile_name": "prod"
  }
}
```

#### 场景 7.4：用 bypass 跳过排队（少用）
```json
{
  "name": "ssh_exec",
  "parameters": {
    "command": "uptime",
    "scheduler": "bypass",
    "profile_name": "prod"
  }
}
```

#### 场景 7.5：查看队列状态
```json
{
  "name": "ssh_queue_status",
  "parameters": {
    "limit": 20
  }
}
```

#### 场景 7.6：异步提交任务 + 自己 wait
```json
// 提交
{
  "name": "ssh_schedule",
  "parameters": {
    "command": "npm run build",
    "intent": "build",
    "profile_name": "prod"
  }
}
// 之后查询
{
  "name": "ssh_wait_task",
  "parameters": { "task_id": "task-xxx", "timeout": 120000 }
}
```

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
