# AI Agent 使用 SOP

这份文档是给使用 `ssh-tool` MCP 的 AI Agent 看的。目标是让多个 AI 会话共用同一台 VM 时，默认避免互相抢占。

## 默认原则

1. 默认使用 `ssh_exec`。它已经接入共享调度器。
2. 测试、构建、安装、脚本、部署、迁移、服务启动默认串行。
3. `if_busy="run_anyway"` 只在确认任务彼此独立时使用。
4. `scheduler="bypass"` 是紧急逃生口，少用。
5. queued 不是失败，不要重复提交同一命令。
6. wait timeout 不是失败，用同一个 `taskId` 查状态。
7. 输出被截断时读 `stdoutPath` / `stderrPath`，不要重跑命令。
8. 跨调用保持目录用 `ssh_cd` 或显式 `cwd`，不要依赖远端 shell 的 `cd`。

## 返回结构读取规则

调度相关 MCP 工具统一返回 JSON envelope。AI 应优先读取这些字段：

```json
{
  "ok": true,
  "kind": "schedule_decision",
  "data": {},
  "agentGuidance": []
}
```

- `ok`：工具调用是否成功。
- `kind`：结果类型，例如 `schedule_decision`、`task_status`、`wait_result`、`cancel_result`、`queue_status`。
- `data`：该工具的主要结构化结果。
- `agentGuidance`：给 AI 的下一步建议。排队、等待超时、输出截断时必须优先遵守。

兼容说明：`ssh_exec` / `ssh_schedule` 仍会把 `action`、`taskId`、`result` 等调度字段保留在顶层，旧提示词可以继续读；新提示词优先读 `data` 和 `agentGuidance`。

## 推荐工作流

### 轻量检查

```json
{
  "name": "ssh_exec",
  "parameters": {
    "command": "pwd && git status --short",
    "profile_name": "dev"
  }
}
```

轻量读命令通常会立即执行，也可以和重任务并发。

### 测试/构建/安装

```json
{
  "name": "ssh_exec",
  "parameters": {
    "command": "npm test",
    "intent": "test",
    "cost": "large",
    "reason": "Verify scheduler changes before reporting.",
    "profile_name": "dev"
  }
}
```

如果返回：

```json
{
  "ok": true,
  "kind": "schedule_decision",
  "action": "queued",
  "taskId": "t_xxx",
  "queuePosition": 1,
  "data": {
    "action": "queued",
    "taskId": "t_xxx",
    "queuePosition": 1
  },
  "agentGuidance": [
    "Task was queued. Do not immediately resubmit the same command..."
  ]
}
```

不要重跑 `npm test`。保存 `taskId`，先做代码阅读、日志分析或文档整理。稍后调用：

```json
{
  "name": "ssh_wait_task",
  "parameters": {
    "task_id": "t_xxx",
    "timeout": 60000
  }
}
```

或者：

```json
{
  "name": "ssh_queue_status",
  "parameters": {
    "limit": 20
  }
}
```

`ssh_wait_task` 返回 `kind: "wait_result"`。如果 `data.waitTimedOut=true`，任务仍在 queued/running，继续用同一个 `taskId` 等或查状态；如果已经结束，`data.output` 会包含 stdout/stderr tail 和完整输出路径。

### 等待超时

如果 `ssh_exec` 返回 `waitTimedOut: true`，表示前台等待超时，任务仍在调度器中。下一步应该查同一个任务：

```json
{
  "name": "ssh_exec_status",
  "parameters": {
    "task_id": "t_xxx"
  }
}
```

不要直接重跑原命令。

### 输出被截断

如果返回：

```json
{
  "result": {
    "truncated": true,
    "stdoutPath": "/home/user/.ssh-tool/scheduler/outputs/t_xxx.stdout",
    "stderrPath": "/home/user/.ssh-tool/scheduler/outputs/t_xxx.stderr"
  }
}
```

内联输出只是 tail。需要完整日志时读取这些路径，或对仍被追踪的任务调用：

```json
{
  "name": "ssh_exec_status",
  "parameters": {
    "task_id": "t_xxx",
    "mode": "full"
  }
}
```

## 并发策略

默认不要并发执行 heavy 命令。只有满足以下条件时才考虑 `if_busy="run_anyway"`：

- 不共享同一个工作目录。
- 不争抢同一个包管理器缓存、构建目录、数据库、端口或全局配置。
- 不会同时修改同一批文件。
- 即使同时运行，也不会让 VM CPU/内存过载。

示例：

```json
{
  "name": "ssh_exec",
  "parameters": {
    "command": "pytest tests/unit/test_parser.py",
    "intent": "test",
    "cost": "large",
    "if_busy": "run_anyway",
    "reason": "Runs isolated unit tests in a separate worktree; safe to run concurrently.",
    "profile_name": "dev"
  }
}
```

## 虚拟工作目录

`ssh_cd` 不是远端 shell 的持久 `cd`。它会在调度器里按 `AI agent + host` 保存默认 cwd；后续未显式传 `cwd` 的 `ssh_exec` / `ssh_schedule` 会自动使用这个目录。

设置当前 AI 会话在某个 host 上的默认目录：

```json
{
  "name": "ssh_cd",
  "parameters": {
    "path": "/repo/project",
    "profile_name": "dev"
  }
}
```

这个 cwd 按 `AI agent + host` 隔离，不影响其他 AI，也不会改变共享 SSH 会话的真实 shell 状态。

如果不确定当前默认目录，先调用 `ssh_get_cwd`。同时，执行相关返回会带 `cwdState`，其中：

- `effectiveCwd`：本次命令实际运行目录
- `virtualCwd`：当前 AI 会话在该 host 上保存的默认目录
- `source`：cwd 来源是 `explicit`、`virtual` 或 `none`

## 常见错误

| 错误做法 | 正确做法 |
|---|---|
| queued 后重复提交同一命令 | 保存 `taskId`，稍后 wait/status |
| 看到 wait timeout 就重跑 | 用 `ssh_exec_status(taskId)` |
| 日志 tail 不够就重跑测试 | 读取 `stdoutPath` / `stderrPath` |
| 为了快给测试加 bypass | 默认排队；确认独立才 `run_anyway` |
| 多次调用里依赖 `cd` 状态 | 用 `ssh_cd` 或显式 `cwd` |
| 服务/watch/log 命令先用前台跑到超时 | 一开始用 `ssh_exec_background`，再用 `ssh_exec_status` |
| 普通读写文件用 shell cat/echo/base64 | 用 `ssh_read_file` / `ssh_write_file`，完整或二进制文件用传输工具 |

## 快速判断表

| 命令类型 | 建议 |
|---|---|
| `pwd`, `ls`, `rg`, `git status` | 直接 `ssh_exec` |
| 读取/写入文本文件 | `ssh_read_file` / `ssh_write_file` |
| 完整文件、大文件、二进制、压缩包 | `ssh_upload` / `ssh_download` |
| `npm run dev`, `tail -f`, watch/server/log stream | `ssh_exec_background` + `ssh_exec_status` |
| 测试、构建、安装、迁移、部署且可以稍后看结果 | `ssh_schedule` + `ssh_wait_task` / `ssh_exec_status` |
| `npm test`, `pytest`, `go test`, `cargo test` | `intent="test"`, 默认串行 |
| `npm run build`, `make`, `cargo build` | `intent="build"`, 默认串行 |
| `npm install`, `pip install`, `apt install` | `intent="install"`, 默认串行 |
| `python script.py`, `bash script.sh` | 默认视为 heavy script |
| `kubectl apply`, migration, deploy | 通常 exclusive/risky，必要时 `force=true` |
