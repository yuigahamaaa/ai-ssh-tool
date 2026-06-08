# 调度器 MVP 实现计划

>&gt; 日期：2026-06-04
&gt; 目标读者：接手实现的 AI / 工程师
&gt; 配套阅读：[AI 协作调度器设计文档](./AI_COLLABORATIVE_SCHEDULER_DESIGN.zh-CN.md)、[调度器设计评审意见](./SCHEDULER_REVIEW_NOTES.md)
&gt; 状态：✅ MVP 已完成

## 1. 本文目标

本文不是重新讨论大设计，而是给出可以直接执行的 MVP 施工图。

核心要求：

1. MCP 和 CLI 只是包装层，不能各写一套调度逻辑。
2. 调度权威在 daemon。
3. `ssh_exec` 默认走 scheduler。
4. `ssh_schedule` 是显式调度工具，但底层和 `ssh_exec` 共享。
5. `scheduler="bypass"` 可以绕过排队，但仍必须登记任务状态。
6. `ssh_cd` 做成 agent + host 级 virtual cwd，不修改远端全局 shell 状态。

## 2. MVP 做什么

### 2.1 必须实现

- daemon 内新增 scheduler service。
- `ssh_exec` 默认进入 scheduler。
- 新增 `ssh_schedule`。
- 新增 `ssh_queue_status`。
- 新增 `ssh_wait_task`。
- 新增 `ssh_dequeue_task`。
- CLI 和 MCP 都调用同一套 daemon IPC。
- 所有 exec task 创建时立即持久化。
- 所有 task 结束时持久化最终状态。
- bypass task 仍登记为 running/completed task。
- 简单命令分类。
- 简单并发控制：
  - 同一 host 默认只允许 1 个 `large` / `exclusive` running task。
  - `tiny` read/search/inspect 可以在 large 运行时并发。
  - 未能分类的命令默认 `medium`。
  - `medium` 默认在 host 总槽位未满时可运行；如果不确定，排队。
- 简单队列：
  - FIFO。
  - 默认最大队列长度 50。
  - task 完成后自动 pump queue。
- virtual cwd：
  - `ssh_cd` 更新 `agentId + hostId -> virtualCwd`。
  - `ssh_exec` / `ssh_schedule` 未传 `cwd` 时使用 virtual cwd。
  - 响应返回 `effectiveCwd`。

### 2.2 MVP 不做

- 不做 agent heartbeat。
- 不做复杂 priority。
- 不开放裸数字 `priority` 给 AI。
- 不做 confirmationToken。
- 不做 event log jsonl。
- 不做多策略预设。
- 不做远端 supervisor。
- 不做 daemon 重启后重新接管 running task。
- 不做复杂命令 AST 解析。
- 不做跨用户/跨机器分布式调度。

## 3. 关键原则

### 3.1 一个底层，两个包装

MCP 和 CLI 都必须通过同一个 `DaemonClient.schedule()` / IPC `schedule` 进入 daemon。

禁止：

- 在 `src/mcp-server.ts` 本地实现一套队列。
- 在 `src/cli/ssh-exec.ts` 本地实现一套队列。
- MCP 直连 SSH 执行 scheduler 任务。
- CLI 直连 SSH 执行 scheduler 任务。

允许：

- `--shell` 继续使用直连交互式 shell。
- `scheduler="bypass"` 走 daemon 执行，但跳过 scheduler 准入和队列。

### 3.2 daemon 是必选依赖

MCP 和 CLI 在执行 scheduler 命令前应自动拉起 daemon。

使用现有：

- `DaemonClient.ensureDaemon()`

不要做：

- daemon 不可用时 fallback 到本地直连执行。

原因：fallback 会让调度失效，其他 AI 看不到这次执行。

### 3.3 AI 申报意图，工具兜底

AI 可以传：

- `reason`
- `intent`
- `cost`
- `urgency`
- `if_busy`

调度器需要做兜底：

- AI 不传时自动分类。
- 分类失败时默认 `medium`。
- AI 明显低估时提升 cost。
- 危险命令无 `force=true` 时返回 `needs_confirmation`。

## 4. 文件级修改计划

### 4.1 新增文件

```text
src/scheduler/types.ts
src/scheduler/command-classifier.ts
src/scheduler/scheduler-service.ts
src/scheduler/persistence-store.ts
src/scheduler/output-store.ts
src/scheduler/virtual-cwd-store.ts
```

MVP 可以不单独拆 `queue-manager.ts` / `lock-manager.ts`。先把简单队列和简单锁逻辑放在 `scheduler-service.ts`，等稳定后再拆。

### 4.2 修改文件

```text
src/ipc-protocol.ts
src/daemon.ts
src/daemon-client.ts
src/mcp-server.ts
src/cli/ssh-exec.ts
src/cli/daemon-commands.ts
src/exec-task-manager.ts
src/session-manager.ts
src/profile-manager.ts
src/types.ts
```

### 4.3 文档后续更新

MVP 完成后更新：

```text
README.md
SKILL.md
profiles/README.md
```

## 5. 数据结构

### 5.1 AgentIdentity

```ts
export interface AgentIdentity {
  id: string
  name?: string
  clientType: "mcp" | "cli"
}
```

MVP 不做 heartbeat，因此不需要 `lastSeenAt`。

生成规则：

- MCP server 启动时生成一个稳定到进程生命周期的 `agentId`。
- CLI 每次命令生成一个 `agentId`，例如 `cli-${process.pid}-${Date.now()}`。

### 5.2 HostIdentity

```ts
export interface HostIdentity {
  id: string
  profileKey: string
  targetHost: string
  targetUser: string
  displayName: string
}
```

`profileKey` 必须基于有序 chain 生成，不能排序 hop。

### 5.3 TaskIntent / TaskCost / Urgency

```ts
export type TaskIntent =
  | "inspect"
  | "search"
  | "test"
  | "build"
  | "install"
  | "server"
  | "deploy"
  | "migration"
  | "cleanup"
  | "custom";

export type TaskCost = "tiny" | "small" | "medium" | "large" | "exclusive";

export type TaskUrgency = "low" | "normal" | "high" | "urgent";
```

### 5.4 ScheduleRequest

```ts
export interface ScheduleRequest {
  agent: AgentIdentity
  host: HostIdentity
  sessionId: string
  command: string
  cwd?: string
  reason?: string
  intent?: TaskIntent
  cost?: TaskCost
  urgency?: TaskUrgency
  ifBusy?: "run_anyway" | "wait" | "queue" | "fail"
  scheduler?: "auto" | "bypass"
  timeoutMs?: number
  force?: boolean
}
```

### 5.5 CommandClassification

```ts
export interface CommandClassification {
  intent: TaskIntent
  cost: TaskCost
  blocking: boolean
  mutates: boolean
  risky: boolean
  source: "agent" | "auto" | "default" | "agent_overridden_by_policy"
  reason: string
}
```

### 5.6 ScheduledTask

```ts
export type ScheduledTaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout"
  | "stale";

export interface ScheduledTask {
  id: string
  agentId: string
  agentName?: string
  hostId: string
  profileKey: string
  sessionId: string
  command: string
  effectiveCwd?: string
  reason?: string
  classification: CommandClassification
  scheduler: "auto" | "bypass"
  status: ScheduledTaskStatus
  queuePosition?: number
  queuedAt?: number
  startedAt?: number
  finishedAt?: number
  updatedAt: number
  pid?: number | null
  exitCode?: number | null
  signal?: string | null
  stdoutTail: string
  stderrTail: string
  stdoutBytes: number
  stderrBytes: number
  decisionReason?: string
}
```

### 5.7 ScheduleDecision

```ts
export interface ScheduleDecision {
  action: "run_now" | "queued" | "wait_recommended" | "rejected" | "needs_confirmation"
  taskId?: string
  queuePosition?: number
  effectiveCwd?: string
  classification?: CommandClassification
  blockers?: ScheduledTaskSummary[]
  reason: string
  recommendedNextStep?: string
  result?: {
    stdout: string
    stderr: string
    code: number
    signal?: string
  }
}
```

### 5.8 QueueStatus

```ts
export interface QueueStatus {
  hostId?: string
  running: ScheduledTaskSummary[]
  queued: ScheduledTaskSummary[]
  recent: ScheduledTaskSummary[]
  virtualCwd?: string
  limits: {
    maxQueueSize: number
    maxTotalRunning: number
    maxLargeRunning: number
  }
}
```

### 5.9 VirtualCwdState

```ts
export interface VirtualCwdState {
  key: string // `${agentId}:${hostId}`
  agentId: string
  hostId: string
  cwd: string
  updatedAt: number
}
```

## 6. IPC 设计

### 6.1 新增 IPCRequest action

修改 `src/ipc-protocol.ts`：

```ts
| { id: string; action: "schedule"; params: ScheduleRequest }
| { id: string; action: "queueStatus"; params: { agent?: AgentIdentity; hostId?: string; limit?: number } }
| { id: string; action: "waitTask"; params: { taskId: string; timeoutMs?: number; output?: "tail" | "full" } }
| { id: string; action: "dequeueTask"; params: { taskId: string; agent?: AgentIdentity } }
| { id: string; action: "setCwd"; params: { agent: AgentIdentity; host: HostIdentity; cwd: string } }
```

### 6.2 createRequest 更新

`createRequest()` 需要包含新 action。

### 6.3 DaemonClient 方法

修改 `src/daemon-client.ts`：

```ts
schedule(req: ScheduleRequest): Promise<IPCResponse>
queueStatus(params: { agent?: AgentIdentity; hostId?: string; limit?: number }): Promise<IPCResponse>
waitTask(taskId: string, timeoutMs?: number): Promise<IPCResponse>
dequeueTask(taskId: string, agent?: AgentIdentity): Promise<IPCResponse>
setCwd(agent: AgentIdentity, host: HostIdentity, cwd: string): Promise<IPCResponse>
```

## 7. SchedulerService 伪代码

### 7.1 schedule()

```ts
async function schedule(req: ScheduleRequest): Promise<ScheduleDecision> {
  const effectiveCwd = req.cwd ?? virtualCwdStore.get(req.agent.id, req.host.id)
  const classification = classifyCommand(req.command, {
    intent: req.intent,
    cost: req.cost,
    force: req.force,
  })

  if (classification.risky && !req.force) {
    return {
      action: "needs_confirmation",
      effectiveCwd,
      classification,
      reason: "该命令可能修改重要状态，需要 force=true 才能执行。",
      recommendedNextStep: "确认风险后重试，并传 force=true。"
    }
  }

  const task = createTask(req, effectiveCwd, classification)
  persistence.saveTask(task)

  if (req.scheduler === "bypass") {
    startTask(task)
    return {
      action: "run_now",
      taskId: task.id,
      effectiveCwd,
      classification,
      reason: "scheduler=bypass，已跳过队列直接执行，但任务仍已登记。"
    }
  }

  const blockers = findBlockers(task)
  if (blockers.length === 0) {
    startTask(task)
    return {
      action: "run_now",
      taskId: task.id,
      effectiveCwd,
      classification,
      reason: "当前 host 没有冲突任务，已开始执行。"
    }
  }

  const ifBusy = req.ifBusy ?? defaultIfBusy(classification)
  if (ifBusy === "run_anyway") {
    startTask(task)
    return {
      action: "run_now",
      taskId: task.id,
      effectiveCwd,
      classification,
      blockers,
      reason: "if_busy=run_anyway，存在冲突但仍执行。"
    }
  }

  if (ifBusy === "fail") {
    task.status = "cancelled"
    persistence.saveTask(task)
    return {
      action: "rejected",
      effectiveCwd,
      classification,
      blockers,
      reason: "当前 host 忙碌，且 if_busy=fail。"
    }
  }

  if (ifBusy === "wait") {
    task.status = "cancelled"
    persistence.saveTask(task)
    return {
      action: "wait_recommended",
      effectiveCwd,
      classification,
      blockers,
      reason: "当前 host 有冲突任务，建议等待。",
      recommendedNextStep: "调用 ssh_wait_task 等待 blocker，或稍后重试。"
    }
  }

  enqueue(task)
  return {
    action: "queued",
    taskId: task.id,
    queuePosition: task.queuePosition,
    effectiveCwd,
    classification,
    blockers,
    reason: "当前 host 有冲突任务，已加入队列。",
    recommendedNextStep: "先做不依赖该命令结果的只读检查；稍后调用 ssh_wait_task 或 ssh_queue_status。"
  }
}
```

### 7.2 findBlockers()

MVP 规则：

```ts
function findBlockers(task: ScheduledTask): ScheduledTaskSummary[] {
  if (task.scheduler === "bypass") return []
  if (task.classification.cost === "tiny") {
    return runningExclusiveTasks(task.hostId)
  }
  if (task.classification.cost === "small") {
    return totalRunning(task.hostId) >= maxTotalRunning ? runningTasks(task.hostId) : []
  }
  if (task.classification.cost === "medium") {
    return totalRunning(task.hostId) >= maxTotalRunning ? runningTasks(task.hostId) : []
  }
  if (task.classification.cost === "large") {
    return runningLargeOrExclusive(task.hostId)
  }
  if (task.classification.cost === "exclusive") {
    return runningTasks(task.hostId)
  }
}
```

默认限制：

```ts
const maxQueueSize = 50
const maxTotalRunning = 4
const maxLargeRunning = 1
```

### 7.3 pumpQueue()

```ts
function pumpQueue(hostId: string): void {
  for (const task of queuedTasksByFifo(hostId)) {
    const blockers = findBlockers(task)
    if (blockers.length > 0) continue
    startTask(task)
  }
  recomputeQueuePositions(hostId)
}
```

### 7.4 startTask()

```ts
function startTask(task: ScheduledTask): void {
  task.status = "running"
  task.startedAt = Date.now()
  task.updatedAt = Date.now()
  persistence.saveTask(task)

  const command = task.effectiveCwd
    ? `cd ${shellQuote(task.effectiveCwd)} && ${task.command}`
    : task.command

  remoteExecWithTracking(task.sessionId, command, task)
    .then(result => finishTask(task.id, result))
    .catch(error => failTask(task.id, error))
}
```

注意：

- `shellQuote` 必须使用安全转义，不能手写脆弱拼接。
- 如果现有 `remoteExec` 已支持 `cwd` 参数，优先复用 `cwd` 参数，而不是在 scheduler 里拼字符串。

## 8. 命令分类 MVP

文件：`src/scheduler/command-classifier.ts`

### 8.1 高置信度分类

```ts
ls/pwd/cat/head/tail/sed -n        -> inspect, tiny
rg/grep/find                       -> search, tiny
npm test/pnpm test/yarn test       -> test, large
pytest/go test/cargo test          -> test, large
npm run build/pnpm build/cargo build -> build, large
npm install/pnpm install/yarn install/pip install -> install, large
npm run dev/npm start/docker compose up -> server, large
kubectl apply/terraform apply/prisma migrate -> deploy|migration, exclusive, risky
rm -rf/dropdb/truncate/systemctl restart -> cleanup|deploy, exclusive, risky
```

### 8.2 默认分类

无法分类：

```ts
intent = "custom"
cost = "medium"
blocking = true
mutates = false
risky = false
source = "default"
```

### 8.3 Agent 覆盖

如果 agent 传了 `intent/cost`：

- 默认尊重 agent。
- 但高置信度规则可以提升 cost，不能降低 cost。
- 例如 `npm test` + `cost=tiny` -> 改为 `large`，source=`agent_overridden_by_policy`。

## 9. PersistenceStore

文件：`src/scheduler/persistence-store.ts`

### 9.1 路径

```text
~/.ssh-tool/scheduler/tasks/<taskId>.json
~/.ssh-tool/scheduler/state/queue.json
~/.ssh-tool/scheduler/state/virtual-cwd.json
```

### 9.2 原子写

必须使用 temp file + rename。

### 9.3 daemon 启动恢复

启动时：

- 读取 task JSON。
- `queued` 任务恢复到队列。
- `running` 任务标记为 `stale`。
- `completed/failed/cancelled/timeout/stale` 保留最近一段时间。

MVP 不尝试重新接管 running task。

## 10. OutputStore

文件：`src/scheduler/output-store.ts`

MVP 可以先不保存完整输出文件，只维护：

- `stdoutTail`
- `stderrTail`
- `stdoutBytes`
- `stderrBytes`

tail 上限：

```ts
const outputTailLimit = 64 * 1024
```

如果实现完整输出文件，必须加大小上限，避免 dev server 输出无限增长。

## 11. virtual cwd

文件：`src/scheduler/virtual-cwd-store.ts`

### 11.1 setCwd

```ts
set(agentId: string, hostId: string, cwd: string): VirtualCwdState
```

要求：

- 通过 SSH 验证目录存在。
- 建议执行 `cd <path> && pwd` 得到规范化路径。
- 存储规范化后的 cwd。

### 11.2 resolveCwd

```ts
resolve(agentId: string, hostId: string, explicitCwd?: string): string | undefined
```

优先级：

1. explicit `cwd`
2. virtual cwd
3. undefined

### 11.3 ssh_cd 响应

返回文案必须清楚：

```json
{
  "success": true,
  "cwd": "/repo",
  "message": "已设置当前 AI 会话在该 host 上的默认 cwd；不会影响其他 AI。"
}
```

## 12. daemon 改造

文件：`src/daemon.ts`

### 12.1 初始化

在 `SSHDaemon` constructor 中创建：

```ts
private scheduler = new SchedulerService(...)
```

SchedulerService 需要能拿到：

- `gateway`
- `sessions`
- persistence store

### 12.2 handleRequest 新增 case

```ts
case "schedule":
  resp = await this.handleSchedule(req)
  break
case "queueStatus":
  resp = await this.handleQueueStatus(req)
  break
case "waitTask":
  resp = await this.handleWaitTask(req)
  break
case "dequeueTask":
  resp = await this.handleDequeueTask(req)
  break
case "setCwd":
  resp = await this.handleSetCwd(req)
  break
```

### 12.3 连接解析

MCP/CLI 包装层可以先调用现有 `connect` / `connectJson` 得到 `sessionId`，再调用 `schedule`。

MVP 不强制把 profile 解析塞进 `schedule` IPC。

## 13. daemon-client 改造

文件：`src/daemon-client.ts`

新增 helper：

```ts
async schedule(req: ScheduleRequest): Promise<ScheduleDecision>
async queueStatus(...)
async waitTask(...)
async dequeueTask(...)
async setCwd(...)
```

这些 helper 内部调用 `send(createRequest(...))`。

## 14. MCP 改造

文件：`src/mcp-server.ts`

### 14.1 共享包装函数

新增内部 helper：

```ts
async function scheduleCommand(params): Promise<ScheduleDecision>
```

职责：

1. 解析 profile。
2. 确保 daemon 启动。
3. 连接 host 获取 sessionId。
4. 构造 AgentIdentity。
5. 构造 HostIdentity。
6. 调 `DaemonClient.schedule()`。

MCP 的 `ssh_exec` 和 `ssh_schedule` 都调用这个 helper。

### 14.2 ssh_exec schema

新增参数：

```ts
scheduler?: "auto" | "bypass"
reason?: string
intent?: TaskIntent
cost?: TaskCost
urgency?: "low" | "normal" | "high" | "urgent"
if_busy?: "run_anyway" | "wait" | "queue" | "fail"
force?: boolean
cwd?: string
timeout?: number
```

默认：

```ts
scheduler = "auto"
```

### 14.3 ssh_schedule schema

和 `ssh_exec` 几乎一样，但工具描述强调“显式调度”。

### 14.4 ssh_cd

改为调用 daemon `setCwd`。

不要再说“切换远端当前目录”。要说“设置当前 AI 会话默认 cwd”。

### 14.5 ssh_queue_status / ssh_wait_task / ssh_dequeue_task

新增 MCP tools，直接调用 DaemonClient。

## 15. CLI 改造

### 15.1 普通 ssh-exec 命令

文件：`src/cli/ssh-exec.ts`

当前普通模式会本地直连执行：

```ts
execCommand(config, command)
```

MVP 改为：

- 非 `--shell` 的普通 `--command` 默认也走 daemon scheduler。
- `--shell` 保持现有直连。

原因：CLI 和 MCP 行为必须一致，否则 CLI 会绕过共享状态。

### 15.2 CLI 参数

普通和 daemon exec 都支持：

```text
--scheduler auto|bypass
--reason <text>
--intent <intent>
--cost <cost>
--urgency low|normal|high|urgent
--if-busy run_anyway|wait|queue|fail
--force
--cwd <path>
--timeout <ms>
```

### 15.3 daemon subcommands

文件：`src/cli/daemon-commands.ts`

`handleDaemonExec()` 改成调用 `DaemonClient.schedule()`，不再调用 `client.exec()`。

新增：

```text
ssh-exec daemon queue-status ...
ssh-exec daemon wait-task --task-id <id> [--timeout <ms>]
ssh-exec daemon dequeue-task --task-id <id>
ssh-exec daemon cd --path <path>
```

### 15.4 CLI 输出

如果 action 是 `run_now` 且 result 已完成：

- stdout 写 stdout。
- stderr 写 stderr。
- exitCode 作为 process exit code。

如果 action 是 `queued`：

- stderr 打印 queue 信息。
- stdout 打印 JSON 或 task id。
- exitCode = 0。

MVP 可以统一输出 JSON，避免复杂兼容：

```json
{
  "action": "queued",
  "taskId": "t_x",
  "queuePosition": 1,
  "reason": "...",
  "recommendedNextStep": "..."
}
```

## 16. exec-task-manager 修正

文件：`src/exec-task-manager.ts`

无论 scheduler 是否接管，都先修这些：

1. 所有任务 start 时立即 save。
2. 所有任务 finish 时 save。
3. completed task 不要马上删除 task file。
4. retention 可配置或至少延长。
5. task record 增加 host/profile/session/cwd 信息。

注意：scheduler MVP 可以逐步替代 ExecTaskManager，但不要在第一步大删。

## 17. session/profile 修正

### 17.1 session hash

文件：`src/session-manager.ts`

当前 hash 生成不要排序 hop。改成保留 chain 顺序。

### 17.2 profile flat/auth 兼容

文件：`src/profile-manager.ts`

当前文档示例里有 flat 格式：

```json
{ "host": "...", "username": "root", "privateKey": "..." }
```

类型里是：

```json
{ "host": "...", "auth": { "username": "root" } }
```

MVP 要么统一文档，要么在 `ProfileManager.loadFromFile()` normalize：

```ts
flat -> auth
```

推荐 normalize，兼容已有 profiles。

## 18. 验收测试

### 18.1 单元测试

新增：

```text
src/__tests__/scheduler-classifier.test.ts
src/__tests__/scheduler-service.test.ts
src/__tests__/scheduler-persistence.test.ts
src/__tests__/virtual-cwd.test.ts
```

必须覆盖：

- `npm test` -> large test。
- `rg foo src` -> tiny search。
- unknown command -> medium custom。
- agent 把 `npm test` 标为 tiny 时被提升。
- risky command 无 force -> needs_confirmation。
- large task 阻塞 large task。
- tiny task 不被 large task 阻塞。
- queue FIFO。
- pumpQueue 启动下一个任务。
- virtual cwd 按 agent + host 隔离。

### 18.2 daemon IPC 测试

新增或扩展：

```text
src/__tests__/daemon-ipc.test.ts
src/__tests__/daemon-scheduler.test.ts
```

必须覆盖：

1. `schedule` 返回 run_now。
2. 第二个 large task 返回 queued。
3. `queueStatus` 显示 running + queued。
4. running 完成后 queued 自动开始。
5. `waitTask` 等待完成。
6. `dequeueTask` 移除 queued task。
7. `setCwd` 后 schedule 不传 cwd 时使用 virtual cwd。

### 18.3 MCP 测试

扩展：

```text
src/__tests__/mcp-server.test.ts
```

必须覆盖：

- `ssh_exec` 默认 scheduler auto。
- `ssh_exec` scheduler bypass 仍登记 task。
- `ssh_schedule` 和 `ssh_exec` 走同一 helper。
- `ssh_cd` 返回 virtual cwd 文案。
- `ssh_queue_status` 可读到任务。

### 18.4 CLI 测试

如果现有测试框架不方便跑完整 CLI，可以先测参数解析 helper。

必须人工验收：

```bash
npm run build
node dist/cli/ssh-exec.js daemon start
node dist/cli/ssh-exec.js --profile-name test --command "sleep 5" --intent test --cost large
node dist/cli/ssh-exec.js --profile-name test --command "sleep 5" --intent test --cost large
node dist/cli/ssh-exec.js daemon queue-status --profile-name test
```

预期第二个 large task queued。

## 19. 实现顺序

严格按这个顺序做：

1. 修 `ExecTaskManager` 立即持久化和最终状态持久化。
2. 修 session hash 保留 hop 顺序。
3. 修 profile normalize。
4. 新增 scheduler types。
5. 新增 command classifier。
6. 新增 persistence store。
7. 新增 virtual cwd store。
8. 新增 scheduler service，先用 mock/simple runner 测调度逻辑。
9. 接 daemon IPC。
10. 接 DaemonClient。
11. 接 CLI daemon exec。
12. 接普通 CLI `--command` 默认 scheduler。
13. 接 MCP `ssh_schedule`。
14. 改 MCP `ssh_exec` 默认 scheduler。
15. 改 MCP/CLI `ssh_cd` virtual cwd。
16. 加 `queue-status` / `wait-task` / `dequeue-task`。
17. 补测试。
18. 更新 README/SKILL。

不要一上来同时改 MCP、CLI、daemon、scheduler、profile。先让底层单测过，再接入口。

## 20. 完成定义

MVP 完成必须满足：

1. MCP 和 CLI 的 `ssh_exec` 默认都走 daemon scheduler。
2. MCP 和 CLI 没有各自维护队列。
3. 两个 large task 在同一 host 上不会默认并发。
4. tiny search/read 可以和 large 并发。
5. bypass task 可见。
6. queued task 可查询、可等待、可取消排队。
7. task 创建和完成状态都持久化。
8. daemon 重启后 queued task 恢复，running task 标记 stale。
9. `ssh_cd` 不影响其他 agent。
10. `ssh_exec` / `ssh_schedule` 响应包含 `effectiveCwd` 和 classification。
11. `npm run build` 通过。
12. 相关 scheduler/daemon/MCP 单测通过。

## 21. 完成总结

### 21.1 已完成功能

✅ **核心调度器**
- 完整的 `SchedulerService` 实现，支持任务分类、并发控制、FIFO 队列
- 命令自动分类器，支持 13+ 高置信度规则
- 持久化存储，支持 daemon 重启后恢复任务状态
- 虚拟工作目录（virtual cwd），按 agent + host 隔离

✅ **daemon 集成**
- 扩展 IPC 协议，支持 `schedule`/`queueStatus`/`waitTask`/`dequeueTask`/`setCwd`
- `SSHDaemon` 集成调度器服务
- 任务执行与现有 `ExecTaskManager` 兼容

✅ **MCP & CLI 包装**
- MCP 工具：`ssh_exec`（默认走调度器）、`ssh_schedule`、`ssh_queue_status`、`ssh_wait_task`、`ssh_dequeue_task`、`ssh_cd`
- CLI 命令：所有 `--command` 执行默认走调度器，支持完整参数集
- 共享底层 `DaemonClient.schedule()` 接口

✅ **测试覆盖**
- L0 单元测试：分类器、调度服务、持久化、虚拟 CWD（38 个测试用例）
- L1 集成测试：daemon-scheduler（15 个测试用例）
- 回归验证：所有现有 135 个测试通过

### 21.2 关键指标

- 新增代码文件：12+
- 新增测试文件：5
- 新增测试用例：53
- 总测试用例：188（全部通过 ✅）

### 21.3 后续优化方向（非 MVP）

1. 复杂优先级与策略
2. Agent 心跳与超时处理
3. 事件日志 JSONL
4. 远端 Supervisor 与任务重新接管
5. 跨用户/跨机器分布式调度
6. 可选端侧小模型 advisor：只在复杂命令/低置信度分类时给 `intent/cost/risk/priorityHint` 建议，默认关闭，不能替代规则分类器和 policy engine

详细后续计划参见：[AI 协作调度器设计文档](./AI_COLLABORATIVE_SCHEDULER_DESIGN.zh-CN.md)
