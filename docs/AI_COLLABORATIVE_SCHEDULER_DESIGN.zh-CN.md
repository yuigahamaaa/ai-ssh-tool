# AI 协作调度器设计文档

> 日期：2026-06-03
> 范围：把 `ai-ssh-tool` 从“共享 SSH 执行器”升级为“多 AI 共享虚拟机的协作调度层”。

## 1. 背景

当前项目已经具备 SSH 执行、MCP 工具、daemon 连接复用、后台任务、任务可见性和主机负载查询能力。这是很好的基础，但还没有真正解决多 AI 共享同一台虚拟机时最关键的问题：

> 多个 AI 会话共用一台 VM。它们应该知道 VM 当前在做什么；遇到阻塞性工作时能选择等待；需要执行重任务时能进入队列；等待期间能先去做其他不冲突的事情。

现在的实现更多依赖 AI 主动调用 `ssh_list_tasks` 或 `ssh_get_host_load`，再自行判断是否等待。实际使用中，AI 不会稳定地这么做。它们经常直接调用 `ssh_exec`，导致测试、构建、安装、服务启动等命令互相抢占资源。

所以核心改造方向是：

> 调度能力必须成为执行路径的一部分，而不是可选的观察工具。

## 2. 当前问题

### 2.1 可见性不等于调度

当前工具包括：

- `ssh_exec`
- `ssh_exec_background`
- `ssh_list_tasks`
- `ssh_get_host_load`
- `ssh_exec_status`
- `ssh_exec_cancel`

这些工具可以让 AI 观察部分状态，但不会强制或稳定引导 AI 协作。两个 AI 可以同时看到主机空闲，然后同时启动昂贵命令。

### 2.2 普通 exec 任务跨进程可见性不可靠

当前 `ExecTaskManager` 会立即持久化 background 任务，但普通 `exec` 任务只在输出到达时才机会性写盘。一个无输出的阻塞命令可能不会及时被其他 MCP 进程看到。

### 2.3 跨进程控制能力不足

磁盘 JSON 可以让其他进程读到任务，但取消任务和 stream 控制仍依赖当前进程内存里的 `RunningTaskEntry`。这意味着另一个 MCP 进程可能“看得到任务”，但无法可靠控制任务。

### 2.4 缺少队列、锁、租约和准入控制

当前没有一等公民的数据结构表示：

- 排队中的命令
- VM 级锁
- 工作目录锁
- 并发槽位
- AI agent 租约
- 调度策略
- 等待建议

没有这些抽象，工具就无法默认做出“等待还是入队”的判断。

### 2.5 AI 工具体验鼓励直接执行

`ssh_exec` 是最明显的工具名，所以 AI 会优先调用它。安全的协作路径应该成为默认路径；直接执行应该变成兼容模式或明确的逃生通道。

## 3. 设计目标

### 3.1 产品目标

1. 让协调执行成为 AI agent 的默认路径。
2. 让多个 AI 可以共享一台 VM，避免无意抢占。
3. 让 AI 能在 run now、wait、queue、do other work 之间做出更稳定的选择。
4. 让阻塞性工作有足够语义信息，方便其他 AI 判断。
5. 支持保守自动化，也支持显式绕过。
6. 保持工具调用模型简单，适合 AI 使用。

### 3.2 工程目标

1. 把协调权移动到 daemon。
2. 任务状态和队列状态只有一个权威来源。
3. 持久化足够状态，支持 daemon 重启后的恢复。
4. 不依赖 MCP 本地进程内存来控制任务。
5. 分阶段添加调度能力，尽量不破坏现有工具。
6. 数据模型为后续策略扩展预留空间。

### 3.3 V1 非目标

1. 不做跨用户、跨机器的强分布式调度。
2. 不做 Kubernetes 级别资源隔离。
3. 不保证本地 daemon 死亡后仍能完整接管远端进程。
4. 不做通用 workflow engine。
5. 不把不可信 AI 当成安全隔离对象。

## 4. 核心原则

关键变化：

> AI 应该提交“执行意图”给调度器，而不是默认直接裸跑命令。

旧路径：

```json
{ "tool": "ssh_exec", "command": "npm test" }
```

新默认路径不是要求 AI 一定换工具名，而是让最常用的 `ssh_exec` 底层默认进入 scheduler。也就是说：

```json
{
  "tool": "ssh_exec",
  "command": "npm test",
  "cwd": "/repo",
  "reason": "验证刚才修改是否通过测试",
  "intent": "test",
  "cost": "large",
  "if_busy": "queue",
  "scheduler": "auto"
}
```

同时保留一个显式调度工具 `ssh_schedule`，它和 `ssh_exec` 的 scheduler 模式走同一套底层逻辑：

```json
{
  "tool": "ssh_schedule",
  "command": "npm test",
  "cwd": "/repo",
  "reason": "验证刚才修改是否通过测试",
  "intent": "test",
  "cost": "large",
  "if_busy": "queue"
}
```

`ssh_exec` 的 `scheduler="bypass"` 是显式逃生通道，但 bypass 任务仍应登记到 daemon 的任务看板中，避免其他 AI 看漏正在运行的命令。

调度器返回：

- `running`：命令立即开始执行
- `queued`：命令已进入队列
- `wait_recommended`：建议等待某些正在运行的任务
- `rejected`：策略拒绝
- `needs_confirmation`：风险较高，需要显式确认

## 5. 目标架构

```text
MCP Server(s)
  |
  | 调度感知工具
  v
DaemonClient
  |
  | IPC
  v
SSHDaemon
  |
  +-- SessionRegistry
  +-- SchedulerService
  |     +-- TaskRegistry
  |     +-- QueueManager
  |     +-- LockManager
  |     +-- PolicyEngine
  |     +-- HostLoadMonitor
  |     +-- EventLog
  |
  +-- ExecRunner
  +-- OutputStore
  +-- PersistenceStore
```

### 5.1 daemon 作为协调权威

daemon 应该拥有：

- 活跃 SSH session
- 活跃任务
- 排队任务
- VM 锁
- 工作目录锁
- agent 心跳
- 调度决策
- 任务取消
- 任务输出存储

MCP server 应该变成薄客户端。迁移期间可以保留本地连接缓存，但协作执行路径应通过 daemon IPC。

### 5.2 持久化用于恢复，而不是主要协调机制

`~/.ssh-tool/` 下的文件用于状态恢复和审计，不应该成为主要协调机制。主要协调在 daemon 内存中完成，每次状态变化后原子持久化。

推荐目录：

```text
~/.ssh-tool/
  state/
    scheduler.json
    agents.json
    locks.json
  tasks/
    <taskId>.json
  output/
    <taskId>.stdout
    <taskId>.stderr
  events/
    scheduler-YYYY-MM-DD.jsonl
```

## 6. 数据模型

### 6.1 Agent 身份

每个 MCP server 或 CLI client 都应该声明身份。

```ts
interface AgentIdentity {
  id: string
  name?: string
  clientType: "mcp" | "cli" | "api"
  sessionThreadId?: string
  startedAt: number
  lastSeenAt: number
  defaultProfile?: string
}
```

用途：

- 展示任务归属。
- 避免误取消其他 AI 的任务。
- 支持队列公平性。
- 支持清理失联 agent。

### 6.2 Host 身份

主机匹配必须稳定且明确，不能只依赖 `client._client._config.host`。

```ts
interface HostIdentity {
  id: string
  profileKey: string
  targetHost: string
  targetPort: number
  targetUser: string
  chain: {
    host: string
    port: number
    username: string
  }[]
  displayName: string
}
```

`profileKey` 应基于有序 SSH 链路生成。多跳顺序不能排序，因为 `A -> B -> target` 和 `B -> A -> target` 是不同链路。

### 6.3 任务意图

AI 需要告诉调度器它想做什么。如果不提供，调度器应自动分类。

```ts
type TaskIntent =
  | "inspect"
  | "search"
  | "read"
  | "edit"
  | "build"
  | "test"
  | "lint"
  | "install"
  | "deploy"
  | "migration"
  | "server"
  | "benchmark"
  | "cleanup"
  | "custom"
```

### 6.4 任务成本

```ts
type TaskCost = "tiny" | "small" | "medium" | "large" | "exclusive"
```

默认建议：

| 意图 | 默认成本 | 说明 |
|---|---:|---|
| `read`, `inspect`, `search` | `tiny` | 通常可以并发 |
| `lint` | `small` | 中等 CPU |
| `build` | `medium` | CPU 和 IO 较重 |
| `test` | `medium` 或 `large` | 取决于命令 |
| `install` | `large` | 包管理器通常会修改共享状态 |
| `deploy`, `migration` | `exclusive` | 应要求独占锁 |
| `server` | `large` | 长时间运行，可能占用端口 |
| `benchmark` | `exclusive` | 需要稳定机器负载 |

### 6.5 调度请求

```ts
interface ScheduleRequest {
  agent: AgentIdentity
  host: HostIdentity
  command: string
  cwd?: string
  env?: Record<string, string>
  intent?: TaskIntent
  cost?: TaskCost
  blocking?: boolean
  priority?: number
  timeoutMs?: number
  maxQueueWaitMs?: number
  ifBusy?: "run_anyway" | "wait" | "queue" | "fail"
  lockScope?: "none" | "host" | "workdir" | "custom"
  lockKey?: string
  outputMode?: "summary" | "tail" | "full"
  reason?: string
}
```

### 6.6 任务记录

```ts
type ScheduledTaskStatus =
  | "queued"
  | "admitted"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout"
  | "skipped"
  | "stale";

interface ScheduledTask {
  id: string
  agentId: string
  hostId: string
  command: string
  cwd?: string
  intent: TaskIntent
  cost: TaskCost
  status: ScheduledTaskStatus
  blocking: boolean
  priority: number
  queuePosition?: number
  queuedAt?: number
  admittedAt?: number
  startedAt?: number
  finishedAt?: number
  updatedAt: number
  pid?: number
  exitCode?: number | null
  signal?: string | null
  lockIds: string[]
  stdoutBytes: number
  stderrBytes: number
  stdoutTail?: string
  stderrTail?: string
  decisionReason?: string
}
```

### 6.7 锁记录

```ts
type LockScope = "host" | "workdir" | "custom";

interface SchedulerLock {
  id: string
  scope: LockScope
  key: string
  hostId: string
  ownerAgentId: string
  ownerTaskId?: string
  reason?: string
  createdAt: number
  expiresAt: number
  renewedAt: number
}
```

锁必须有 TTL。活跃任务需要续租。daemon 负责释放过期锁。

## 7. 调度策略

### 7.1 决策输入

策略引擎考虑：

- 正在运行的任务
- 排队任务
- 活跃锁
- 主机 CPU load
- 内存压力
- 进程数量
- 命令意图
- 命令成本
- 工作目录
- agent 优先级
- 是否阻塞
- 是否修改共享状态

### 7.2 默认并发槽位

```ts
interface HostConcurrencyPolicy {
  maxTotalRunning: number
  maxLargeRunning: number
  maxExclusiveRunning: number
  maxPerWorkdirMutations: number
  loadAverageSoftLimit: number
  loadAverageHardLimit: number
  memoryFreeSoftLimitMb?: number
}
```

小型共享 VM 推荐默认值：

```json
{
  "maxTotalRunning": 4,
  "maxLargeRunning": 1,
  "maxExclusiveRunning": 1,
  "maxPerWorkdirMutations": 1,
  "loadAverageSoftLimit": 2.0,
  "loadAverageHardLimit": 4.0
}
```

### 7.3 准入规则

规则需要确定、可解释：

1. `tiny` 的 read/search/inspect 任务，只要没有 hard load 或独占锁，就可以并发运行。
2. `small` 任务在总槽位可用时可以运行。
3. `medium` 任务在总槽位可用且 load 低于 soft limit 时可以运行。
4. `large` 任务要求同一 host 上没有其他 large/exclusive 任务。
5. `exclusive` 任务需要 host lock。
6. 同一 `cwd` 下的修改型任务需要 workdir lock。
7. 包管理器命令应视为修改共享状态，至少是 `large`。
8. deploy、migration、benchmark 默认是 `exclusive`。

### 7.4 命令自动分类

如果 AI 没有传 `intent` 或 `cost`，调度器需要自动分类。

| 命令模式 | 意图 | 成本 | 锁 |
|---|---|---:|---|
| `ls`, `pwd`, `cat`, `sed -n`, `head`, `tail` | `inspect` | `tiny` | 无 |
| `rg`, `grep`, `find` | `search` | `tiny` 或 `small` | 无 |
| `npm test`, `pnpm test`, `pytest`, `go test`, `cargo test` | `test` | `medium` | workdir |
| `npm install`, `pnpm install`, `pip install`, `cargo build` | `install`/`build` | `large` | workdir |
| `docker compose up`, `npm run dev` | `server` | `large` | custom port/workdir |
| `kubectl apply`, `terraform apply`, `prisma migrate` | `deploy`/`migration` | `exclusive` | host |
| `rm -rf`, `dropdb`, `truncate`, `systemctl restart` | `cleanup`/`deploy` | `exclusive` | host + confirmation |

第一版可以用模式表实现。后续可以把分类结果返回给 AI，让 AI 修正。

未来可以考虑接入端侧小模型作为可选分类顾问，但它不应该替代规则分类器。当前调度器已经采用保守策略：无法高置信度识别时默认按更重、更安全的方式排队，因此本地模型不是 MVP 必需能力。

如果后续要做，建议遵守这些边界：

- 默认关闭，只在用户显式配置后启用。
- 只在规则分类低置信度、命令结构复杂、或队列优先级难判断时调用。
- 模型只输出建议，例如 `intent`、`cost`、`risk`、`priorityHint`、`confidence` 和简短原因。
- 最终决策仍由 policy engine 做；模型不能绕过 large/exclusive 串行、确认机制、锁和队列上限。
- 必须有很短的 deadline，例如 200-500ms；超时、解析失败、模型不可用时直接回退规则分类器。
- 结果可缓存，按 normalized command、cwd/project hints、历史队列场景复用。
- 离线内网环境应通过单独模型 bundle 或内部制品库安装，不把几百 MB 模型塞进主包。

适合的架构是：

```text
Rule classifier
  -> confidence low?
  -> optional local advisor model
  -> policy engine final decision
```

这样本地模型只提升复杂命令的分类和排序准确度，不会让调度器变慢、变黑箱，或破坏保守设计。

### 7.5 调度决策

```ts
type ScheduleDecision =
  | {
      action: "run_now"
      taskId: string
      reason: string
    }
  | {
      action: "queued"
      taskId: string
      queuePosition: number
      estimatedWaitMs?: number
      blockingTasks: ScheduledTaskSummary[]
      reason: string
    }
  | {
      action: "wait_recommended"
      blockingTasks: ScheduledTaskSummary[]
      retryAfterMs: number
      reason: string
    }
  | {
      action: "rejected"
      reason: string
      suggestedAction?: string
    }
  | {
      action: "needs_confirmation"
      reason: string
      risks: string[]
      confirmationToken: string
    };
```

响应必须告诉 AI 下一步怎么做。

示例：

```json
{
  "action": "queued",
  "taskId": "t_9a1c2e",
  "queuePosition": 2,
  "blockingTasks": [
    {
      "id": "t_88ab01",
      "agentName": "codex-1",
      "command": "npm test",
      "cwd": "/repo",
      "intent": "test",
      "startedAt": 1780477220000,
      "durationMs": 84000,
      "stdoutTail": "running integration tests..."
    }
  ],
  "reason": "已有一个大型测试任务正在 /repo 运行。你的命令已入队，以避免 CPU 和工作目录冲突。",
  "recommendedNextStep": "继续做文件检查或方案整理。稍后调用 ssh_queue_status 或 ssh_wait_task。"
}
```

## 8. MCP 工具设计

### 8.1 新增主工具

#### `ssh_schedule`

提交命令给共享 VM 调度器。它是显式调度工具，底层逻辑也会被 `ssh_exec` 的默认 scheduler 模式复用。

参数：

```ts
{
  command: string
  cwd?: string
  intent?: TaskIntent
  cost?: TaskCost
  blocking?: boolean
  urgency?: "low" | "normal" | "high" | "urgent"
  timeout?: number
  if_busy?: "run_anyway" | "wait" | "queue" | "fail"
  lock_scope?: "none" | "host" | "workdir" | "custom"
  lock_key?: string
  profile_name?: string
  profile_file?: string
  profile_json?: string
  reason?: string
  force?: boolean
}
```

默认行为：

- `medium`、`large`、`exclusive` 任务：`if_busy = "queue"`
- `tiny` inspect/search 任务：`if_busy = "run_anyway"`
- build/test/install/deploy/migration/server：`blocking = true`
- `urgency = "normal"`
- V1 不建议开放裸数字 `priority`。用 `urgency` + `reason` 表达紧急程度，避免 AI 通过随意填高优先级插队。

#### `ssh_wait_task`

等待某个任务完成，或等待到超时。

参数：

```ts
{
  task_id: string
  timeout?: number
  return_output?: "tail" | "full" | "summary"
}
```

#### `ssh_queue_status`

展示运行中任务、排队任务、锁和主机负载。

参数：

```ts
{
  profile_name?: string
  profile_file?: string
  include_completed?: boolean
  limit?: number
}
```

#### `ssh_dequeue_task`

在任务开始前移除排队任务。

```ts
{
  task_id: string
}
```

#### `ssh_acquire_lock`

显式申请 host/workdir/custom 锁。

```ts
{
  scope: "host" | "workdir" | "custom"
  key?: string
  ttl_ms?: number
  reason?: string
  profile_name?: string
}
```

#### `ssh_release_lock`

释放显式锁。

```ts
{
  lock_id: string
}
```

#### `ssh_recent_activity`

以 AI 友好的形式返回最近 VM 活动。

```ts
{
  since_ms?: number
  profile_name?: string
  include_output_tail?: boolean
}
```

### 8.2 现有工具调整

#### `ssh_exec`

`ssh_exec` 从第一版调度器接入开始就默认走 scheduler。原因是 AI 最自然、最频繁调用的就是 `ssh_exec`；如果只新增 `ssh_schedule`，AI 仍可能继续直接执行，协作效果会打折。

新增参数：

```ts
{
  scheduler?: "auto" | "bypass"
  reason?: string
  intent?: TaskIntent
  cost?: TaskCost
  urgency?: "low" | "normal" | "high" | "urgent"
  if_busy?: "run_anyway" | "wait" | "queue" | "fail"
  force?: boolean
}
```

默认：

```ts
scheduler = "auto"
```

行为：

- `scheduler="auto"`：进入 scheduler，根据当前 VM 状态决定立即执行、排队、建议等待、拒绝或要求确认。
- `scheduler="bypass"`：绕过准入和队列，直接执行；但仍要登记成 running task，让 `ssh_queue_status` 和 `ssh_get_host_load` 能看到。
- AI 没填 `intent/cost`：调度器只做高置信度自动分类。分类不了时默认 `medium + queue`。
- AI 填了但明显不合理：例如 `npm test` 填 `tiny`，调度器可以提升成本，并在响应中返回 `classification.source = "agent_overridden_by_policy"`。

#### `ssh_exec_background`

也应调度感知。默认创建 `blocking=true`、`if_busy="queue"` 的 scheduled task。

#### `ssh_cd`

当前 `ssh_cd` 容易制造认知误差：AI 会以为自己改变了“当前会话目录”，但 SSH exec 通常是每条命令独立执行，且多个 AI 共享同一 VM 时不应该有一个会被互相污染的全局 cwd。

V1 建议把 `ssh_cd` 改造成“虚拟工作目录设置”：

- daemon/MCP 为每个 `agentId + hostId` 维护一个 `virtualCwd`。
- `ssh_cd(path)` 只更新该 agent 在该 host 下的 `virtualCwd`，不改变远端全局 shell 状态。
- 后续 `ssh_exec` / `ssh_schedule` 如果没有显式传 `cwd`，就使用这个 `virtualCwd`。
- 实际执行时由工具内部拼接 `cd <virtualCwd> && <command>`，或传给 `ExecRunner` 统一处理。
- 每个任务记录都必须保存最终使用的 `cwd`，方便其他 AI 理解任务发生在哪。

同时，工具描述中应提示 AI：优先在每次执行命令时显式传 `cwd`；`ssh_cd` 只是设置本 agent 的默认工作目录，不会影响其他 AI。

第一版最低要求：

1. `ssh_cd` 返回清晰文案：`已设置当前 AI 会话在该 host 上的默认 cwd`。
2. `ssh_exec` / `ssh_schedule` 在响应中返回 `effectiveCwd`。
3. 不再暗示 `ssh_cd` 改变了远端全局 shell。

#### `ssh_list_tasks`

保留兼容，但 `ssh_queue_status` 是更完整替代。

#### `ssh_get_host_load`

保留，但返回 scheduler 状态：

- 运行中的 scheduled task
- 队列深度
- 活跃锁
- 建议状态：`free`、`busy`、`exclusive_locked`、`overloaded`

## 9. 工具描述中的 AI 引导

MCP 工具描述会影响 AI 选工具，因此描述必须直接引导正确行为。

`ssh_schedule` 描述建议：

> 通过共享 VM 调度器执行远程命令。测试、构建、安装、服务启动、部署、迁移，或任何可能消耗 CPU、修改文件、占用端口、运行超过几秒的命令，都应使用本工具。若 VM 忙碌，工具可能会把命令入队，并告诉你等待期间可以做什么。

`ssh_exec` 描述建议：

> 执行远程命令。默认仍会走调度器。只有在用户明确要求或命令是紧急的轻量检查时，才使用 `scheduler="bypass"`。

## 10. Daemon IPC 改造

新增 IPC action：

```ts
type SchedulerIPCRequest =
  | { id: string; action: "agentHello"; params: AgentIdentity }
  | { id: string; action: "agentHeartbeat"; params: { agentId: string } }
  | { id: string; action: "schedule"; params: ScheduleRequest }
  | { id: string; action: "waitTask"; params: { taskId: string; timeoutMs?: number } }
  | { id: string; action: "queueStatus"; params: { hostId?: string; limit?: number } }
  | { id: string; action: "cancelTask"; params: { taskId: string; mode?: "queued" | "running" | "any" } }
  | { id: string; action: "dequeueTask"; params: { taskId: string } }
  | { id: string; action: "acquireLock"; params: AcquireLockRequest }
  | { id: string; action: "releaseLock"; params: { lockId: string } }
  | { id: string; action: "recentActivity"; params: { hostId?: string; sinceMs?: number } };
```

daemon 直接暴露 scheduler 操作。MCP 不应该在本地实现排队逻辑。

## 11. SchedulerService 内部设计

### 11.1 组件

```ts
class SchedulerService {
  registerAgent(agent: AgentIdentity): void
  heartbeat(agentId: string): void
  schedule(req: ScheduleRequest): Promise<ScheduleDecision>
  waitTask(taskId: string, timeoutMs?: number): Promise<ScheduledTask>
  cancelTask(taskId: string, opts?: CancelOptions): Promise<boolean>
  dequeueTask(taskId: string): Promise<boolean>
  queueStatus(hostId?: string): SchedulerStatus
  acquireLock(req: AcquireLockRequest): Promise<SchedulerLock | ScheduleDecision>
  releaseLock(lockId: string): boolean
}
```

### 11.2 QueueManager

职责：

- 按 host 存储排队任务。
- 按 priority、queuedAt、公平性排序。
- 任务结束或锁过期时重新执行准入检查。
- 通过 `ExecRunner` 启动新准入任务。

排序规则：

1. 高优先级优先。
2. 同优先级先入队先执行。
3. 避免同一个 agent 长时间垄断队列。

### 11.3 LockManager

职责：

- 申请和释放 host/workdir/custom 锁。
- TTL 过期处理。
- 运行中任务自动续租。
- 解释锁冲突原因。

### 11.4 PolicyEngine

职责：

- 自动分类命令。
- 估算任务成本。
- 检测高风险命令。
- 决定 run/queue/wait/reject。
- 返回人类和 AI 都能理解的原因。

### 11.5 ExecRunner

职责：

- 在 daemon 拥有的 SSH session 上启动命令。
- 捕获 pid、stdout、stderr、exit code。
- 输出流写入文件。
- 更新任务注册表。
- 任务结束后释放锁。
- 任务结束后触发队列 pump。

`ExecRunner` 应替代当前 MCP 直接 `remoteExec` 和本地 `ExecTaskManager` 分裂的协作执行路径。

## 12. 执行流程

### 12.1 立即执行

```text
AI 调用 ssh_schedule
  -> MCP 发送 schedule IPC
  -> daemon 解析 profile/host/session
  -> daemon 解析 effectiveCwd：显式 cwd 优先，否则使用 agent 的 virtualCwd
  -> PolicyEngine 分类命令
  -> LockManager 检查锁
  -> QueueManager 检查槽位
  -> decision = run_now
  -> task 状态 admitted/running
  -> ExecRunner 启动命令
  -> 返回 taskId 和初始状态
```

对于短命令，`ssh_schedule` 可以选择等待完成后直接返回结果，条件是：

- cost 是 `tiny` 或 `small`
- blocking 是 false
- 预期运行时间短

但 build/test/install/server 应快速返回 task id。

### 12.2 入队

```text
AI 调用 ssh_schedule
  -> 策略发现冲突
  -> if_busy = queue
  -> task 状态 queued
  -> 返回队列位置和阻塞任务
  -> AI 去做其他工作
  -> daemon 稍后启动任务
  -> AI 轮询或 wait
```

### 12.3 等待

```text
AI 调用 ssh_wait_task
  -> daemon 持有 IPC 请求直到任务完成或超时
  -> 返回最终任务状态和输出 tail
```

### 12.4 任务完成

```text
ExecRunner 收到 close event
  -> 更新任务状态
  -> 持久化任务
  -> 释放任务锁
  -> 写 event log
  -> QueueManager pump(hostId)
  -> 可能准入下一个排队任务
```

## 13. 如何让 AI 真正变乖

这个问题不只是工程问题，也是工具体验问题。

### 13.1 让安全路径成为最明显路径

新增或强调：

- 主路径：`ssh_schedule`
- 兼容路径：`ssh_exec`，但默认 scheduler auto
- 逃生通道：`ssh_exec` + `scheduler="bypass"`

### 13.2 返回可执行建议

不要只返回 “queued”。要告诉 AI 下一步做什么。

好的响应：

```json
{
  "action": "queued",
  "taskId": "t123",
  "queuePosition": 1,
  "reason": "另一个 agent 正在 /repo 运行 npm test。",
  "recommendedNextStep": "先检查相关文件、整理方案或查看日志；之后调用 ssh_wait_task 等待任务完成。"
}
```

### 13.3 自动分类命令

AI 经常不会主动设置 `intent`。调度器必须能识别常见命令。

### 13.4 暴露冲突原因

AI 更容易响应清晰上下文：

- 谁在阻塞
- 跑的是什么命令
- 在哪个目录跑
- 已经运行多久
- 最近输出是什么
- 是否快结束

### 13.5 支持“等待时先做别的”

调度器应返回建议：

- “可以运行只读搜索。”
- “可以检查 cwd 下的文件。”
- “可以先准备 patch。”
- “稍后 wait task。”
- “60 秒后查 queue status。”

## 14. 修改方案

### Phase 0：修正当前正确性问题

目标：在加队列前，先让当前任务追踪可信。

修改：

1. 所有任务创建时立即持久化，包括普通 `exec`。
2. 所有任务结束时持久化最终状态，不只 background。
3. 不默认 30 分钟后删除完成任务；改成可配置 retention。
4. 修复 background detached 行为，或在实现前诚实改名。
5. 修复 session hash，保留 hop 顺序。
6. 统一 profile 文件格式，或同时支持 flat 和 `auth` 形式。
7. 给任务记录添加稳定 host identity。
8. 调整 `ssh_cd` 语义：先提示 AI 它不是远端全局 cd；实现时按 agent + host 缓存 virtual cwd。

涉及文件：

- `src/exec-task-manager.ts`
- `src/background-exec.ts`
- `src/session-manager.ts`
- `src/profile-manager.ts`
- `src/mcp-server.ts`
- `src/types.ts`

测试：

- 无输出普通 exec 也能被 `ssh_list_tasks` 看见。
- 普通 exec 完成后持久化最终状态。
- 多跳 hash 保留顺序。
- flat profile 能正常加载，或给出清晰校验错误。
- `ssh_cd` 不影响其他 agent；未显式传 `cwd` 的命令使用当前 agent 的 virtual cwd。

### Phase 1：daemon 内调度器骨架

目标：添加 scheduler 状态和 IPC，不立即替换所有执行路径。

新增文件：

- `src/scheduler/types.ts`
- `src/scheduler/scheduler-service.ts`
- `src/scheduler/policy-engine.ts`
- `src/scheduler/queue-manager.ts`
- `src/scheduler/lock-manager.ts`
- `src/scheduler/persistence-store.ts`
- `src/scheduler/command-classifier.ts`

修改：

- `src/daemon.ts`
- `src/ipc-protocol.ts`
- `src/daemon-client.ts`

新增 IPC：

- `schedule`
- `queueStatus`
- `waitTask`
- `cancelTask`
- `dequeueTask`

初始行为：

- `schedule` 分类命令。
- 无冲突则启动。
- 有冲突且 `if_busy=queue` 则入队。
- 任务完成后 pump 队列。

测试：

- 一个 large 任务会阻塞另一个 large 任务。
- tiny 任务可以在 large 任务运行时执行。
- exclusive 任务阻塞非 bypass 任务。
- 队列顺序确定。

### Phase 2：MCP 工具接入

目标：让 AI 自然使用 scheduler。

修改：

- `src/mcp-server.ts`

新增工具：

- `ssh_schedule`
- `ssh_wait_task`
- `ssh_queue_status`
- `ssh_dequeue_task`
- `ssh_recent_activity`
- `ssh_acquire_lock`
- `ssh_release_lock`

调整：

- `ssh_exec` 默认 scheduler auto，并复用 `ssh_schedule` 底层逻辑。
- `ssh_exec_background` 默认 scheduler queue。
- `ssh_get_host_load` 包含 scheduler state。
- `ssh_cd` 设置 agent + host 的 virtual cwd；`ssh_exec` / `ssh_schedule` 返回 `effectiveCwd`。

测试：

- MCP schedule 返回 `running`。
- MCP schedule 返回 `queued`。
- MCP wait 返回最终输出。
- 现有 `ssh_exec` 仍可用，但默认走 scheduler。
- 两个 agent 分别 `ssh_cd` 到不同目录后，默认命令互不影响。

### Phase 3：锁和策略

目标：避免工作目录和 host 级冲突。

实现：

- 修改型 medium/large 命令使用 workdir lock。
- exclusive 命令使用 host lock。
- 锁 TTL 和续租。
- agent heartbeat 和失联清理。
- 风险命令检测和 `needs_confirmation`。

测试：

- 同一 cwd 两个 install 不并发。
- 不同 cwd 的 test 在资源允许时可并发。
- deploy 按策略阻塞其他任务。
- 过期锁自动释放。

### Phase 4：输出和活动体验

目标：让状态对 AI 推理有用。

实现：

- 每个 task 的 stdout/stderr 文件。
- task summary 中包含输出 tail。
- recent activity event log。
- 估算等待时间。
- recommended next step。

测试：

- 运行中任务可读 output tail。
- recent activity 包含完成和失败任务。
- queue status 包含 blocker 和 lock reason。

### Phase 5：可选高级能力

后续想法：

- 每个 repo 的 `.ssh-tool-policy.json`。
- 端口锁检测，避免多个 dev server 抢端口。
- 从历史命令学习分类。
- 可选端侧小模型 advisor：用于复杂命令分类和 queued task priority hint，默认关闭，规则与 policy engine 仍是权威。
- 任务依赖：“task X 成功后再运行 task Y”。
- MCP resource 或 event stream 通知 agent。
- 远端轻量 supervisor，用于 daemon 重启后的运行任务恢复。

## 15. 推荐默认策略

### 15.1 小型共享开发 VM

```json
{
  "maxTotalRunning": 4,
  "maxLargeRunning": 1,
  "maxExclusiveRunning": 1,
  "maxPerWorkdirMutations": 1,
  "loadAverageSoftLimit": 2.0,
  "loadAverageHardLimit": 4.0,
  "defaultIfBusy": {
    "tiny": "run_anyway",
    "small": "run_anyway",
    "medium": "queue",
    "large": "queue",
    "exclusive": "queue"
  }
}
```

### 15.2 保守单仓库模式

```json
{
  "maxTotalRunning": 2,
  "maxLargeRunning": 1,
  "maxExclusiveRunning": 1,
  "maxPerWorkdirMutations": 1,
  "loadAverageSoftLimit": 1.5,
  "loadAverageHardLimit": 3.0
}
```

### 15.3 读多写少模式

```json
{
  "maxTotalRunning": 8,
  "maxLargeRunning": 1,
  "maxExclusiveRunning": 1,
  "maxPerWorkdirMutations": 1,
  "loadAverageSoftLimit": 3.0,
  "loadAverageHardLimit": 6.0
}
```

## 16. 示例场景

### 16.1 两个 AI 都想跑测试

Agent A：

```json
{
  "command": "npm test",
  "cwd": "/repo",
  "intent": "test"
}
```

结果：

```json
{ "action": "run_now", "taskId": "t_a" }
```

Agent B：

```json
{
  "command": "npm test",
  "cwd": "/repo",
  "intent": "test"
}
```

结果：

```json
{
  "action": "queued",
  "taskId": "t_b",
  "queuePosition": 1,
  "reason": "已有测试任务正在 /repo 运行。"
}
```

### 16.2 测试运行时另一个 AI 做检查

Agent B：

```json
{
  "command": "rg \"TODO\" src",
  "cwd": "/repo",
  "intent": "search"
}
```

结果：

```json
{
  "action": "run_now",
  "taskId": "t_c",
  "reason": "只读 tiny 任务可以并发运行。"
}
```

### 16.3 部署需要独占锁

Agent C：

```json
{
  "command": "kubectl apply -f deploy.yaml",
  "intent": "deploy"
}
```

结果：

```json
{
  "action": "needs_confirmation",
  "reason": "部署命令需要显式确认和 host lock。",
  "risks": ["可能修改生产状态", "会阻塞其他 scheduled task"]
}
```

## 17. 迁移策略

### 17.1 兼容性

保留现有工具，但尽可能路由到 scheduler：

- `ssh_exec` -> scheduler auto
- `ssh_exec_background` -> scheduler queue
- `ssh_exec_status` -> scheduler task status
- `ssh_exec_cancel` -> daemon cancel
- `ssh_list_tasks` -> scheduler tasks
- `ssh_cd` -> 设置当前 agent 在当前 host 的 virtual cwd

保留 `scheduler="bypass"` 作为紧急兼容模式。

### 17.2 文档更新

需要更新：

- `README.md`
- `SKILL.md`
- `profiles/README.md`

核心信息：

> AI agent 默认使用 `ssh_schedule` 执行命令。它能避免多个 agent 在同一台 VM 上互相抢占或过载。

### 17.3 上线顺序

1. 在 daemon IPC 后面添加 scheduler internals。
2. 添加 `ssh_schedule`、`ssh_wait_task`、`ssh_queue_status` 等 MCP 工具。
3. 同时把 `ssh_exec` 默认改成 scheduler auto，保留 `scheduler="bypass"`。
4. 把 `ssh_cd` 改成 virtual cwd，并更新工具描述避免误导 AI。
5. 更新文档。
6. 弱化 MCP 直接使用 task manager 的路径。

## 18. 测试计划

### 18.1 单元测试

Policy engine：

- 分类常见命令。
- 检测风险命令。
- 决定 run/queue/wait/reject。
- 返回可解释原因。

Queue manager：

- 同优先级 FIFO。
- 优先级排序。
- agent 公平性。
- 任务完成后启动下一个任务。

Lock manager：

- acquire/release。
- 冲突检测。
- TTL 过期。
- 续租。

Persistence：

- 原子写。
- 恢复 queued/running/completed task。
- daemon 重启后把不可接管的 running task 标记为 stale。

### 18.2 集成测试

Daemon IPC：

- `schedule` 启动任务。
- `schedule` 把任务排到 running task 后面。
- `queueStatus` 展示 running 和 queued task。
- `waitTask` 在任务完成后返回。
- `cancelTask` 取消 queued 和 running task。

MCP：

- `ssh_schedule` 响应结构。
- `ssh_exec` 默认 scheduler。
- `ssh_exec` bypass。
- `ssh_get_host_load` 包含 scheduler state。

### 18.3 多 Agent 模拟测试

创建两个或更多 fake agents：

1. Agent A schedule `sleep 2`。
2. Agent B schedule 另一个 large task。
3. 断言 B queued。
4. Agent C schedule 只读命令。
5. 断言 C 立即运行。
6. 等待 A。
7. 断言 B 开始运行。

### 18.4 失败场景测试

- daemon 在有 queued task 时重启。
- daemon 在有 running task 时重启。
- SSH 连接断开。
- agent 持有锁后消失。
- 命令超时。
- 输出超过 buffer limit。

## 19. 开放问题

1. 队列按 host、profile，还是 target user + host 分组？
   - 建议：按有序 host identity，展示时按 target host 聚合。

2. 不同 workdir 的 test 是否允许并发？
   - 建议：如果 host load 允许，可以；但小 VM 默认只允许一个 large task。

3. `ssh_exec` 是否应该默认绕过 scheduler？
   - 建议：不应该。绕过必须显式。

4. queued task 是否跨 daemon 重启保留？
   - 建议：保留。

5. running task 是否跨 daemon 重启保留？
   - 建议：标记为 `stale`，除非后续有远端 supervisor 支持重新接管。

6. 一个 AI 是否可以取消另一个 AI 的任务？
   - 建议：只有 `force=true` 时允许，并在响应里明确显示 owner 信息。

## 20. 最小可用版本

最小能解决当前痛点的版本：

1. 所有 exec 任务创建时立即持久化。
2. 新增 daemon-owned `SchedulerService`。
3. 新增 `ssh_schedule`、`ssh_queue_status`、`ssh_wait_task`。
4. `ssh_exec` 默认走 scheduler。
5. 实现简单命令分类。
6. 同一 host 默认只允许一个 large/blocking task。
7. 后续 large/blocking task 自动入队。
8. tiny read/search 任务允许并发。
9. 返回 blocker 和 recommended next step。
10. `ssh_cd` 维护 agent + host 级 virtual cwd；命令响应返回 `effectiveCwd`。

这个 MVP 应该足以阻止大多数 AI 意外抢占，并让它们在排队期间自然去做其他不冲突的事情。
