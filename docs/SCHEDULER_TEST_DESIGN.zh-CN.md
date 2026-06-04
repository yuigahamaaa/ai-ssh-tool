# 调度器 MVP 测试设计

> 日期：2026-06-04
> 目标读者：实现调度器 MVP 的 AI / 工程师
> 配套阅读：[调度器 MVP 实现计划](./SCHEDULER_IMPLEMENTATION_PLAN.zh-CN.md)

## 1. 测试目标

本测试设计用于验证调度器 MVP 是否真的解决多 AI 共享 VM 的抢占问题。

核心验证点：

1. `ssh_exec` 默认走 daemon scheduler。
2. MCP 和 CLI 不各自维护队列，而是共享 daemon scheduler。
3. 同一 host 上 large/exclusive task 默认不并发。
4. tiny read/search task 可以和 large task 并发。
5. queued task 可查询、可等待、可取消排队。
6. bypass task 不排队，但仍可见。
7. task 创建和结束状态都持久化。
8. daemon 重启后 queued task 可恢复，running task 标记 stale。
9. `ssh_cd` 是 agent + host 级 virtual cwd，不影响其他 agent。
10. `ssh_exec` / `ssh_schedule` 响应包含 `effectiveCwd` 和 classification。

## 2. 测试框架

沿用当前项目测试体系：

- 测试框架：`node:test`
- 断言：`node:assert/strict`
- 编译：`npm run build:test`
- 运行：`node --test dist/__tests__/*.test.js`

不要引入 Jest/Vitest 等新框架。

## 3. 建议新增测试文件

```text
src/__tests__/scheduler-classifier.test.ts
src/__tests__/scheduler-service.test.ts
src/__tests__/scheduler-persistence.test.ts
src/__tests__/virtual-cwd.test.ts
src/__tests__/daemon-scheduler.test.ts
src/__tests__/cli-scheduler.test.ts
```

同时扩展：

```text
src/__tests__/daemon-ipc.test.ts
src/__tests__/mcp-server.test.ts
src/__tests__/session-manager.test.ts
src/__tests__/profile-manager.test.ts
src/__tests__/background-exec.test.ts
```

## 4. 测试分层

### 4.1 L0：纯单元测试

不连接 SSH，不启动 daemon。

覆盖：

- command classifier
- scheduler service admission logic
- queue FIFO
- persistence store atomic write/recovery
- virtual cwd store
- session hash
- profile normalize

### 4.2 L1：daemon IPC 测试

可以使用 fake runner 或 mock SSH connection，不要求真实 SSH。

覆盖：

- IPC action encode/decode
- daemon handler
- schedule/queueStatus/waitTask/dequeueTask/setCwd
- MCP response envelope helper：`ok/kind/data/agentGuidance`

### 4.3 L2：MCP/CLI 包装测试

验证 MCP 和 CLI 都调用统一 daemon scheduler。

覆盖：

- MCP tool schema
- MCP helper 共享
- CLI 参数解析
- CLI daemon command handler

`mcp-response.test.ts` 属于 L1：它不启动 MCP server，只锁定调度相关工具的 JSON 返回契约。`mcp-server.test.ts` 属于 L2：验证工具包装是否实际使用这些契约。

### 4.4 L3：端到端验收

使用现有测试 SSH server 或人工 profile。

覆盖真实命令：

- `sleep`
- `echo`
- `cat`
- `rg`/`grep`

## 5. Command Classifier 测试

文件：`src/__tests__/scheduler-classifier.test.ts`

### 5.1 高置信度命令

| 用例 | 输入 | 期望 |
|---|---|---|
| inspect | `ls -la` | intent=`inspect`, cost=`tiny`, risky=false |
| inspect pwd | `pwd` | intent=`inspect`, cost=`tiny` |
| read | `cat package.json` | intent=`inspect`, cost=`tiny` |
| search rg | `rg "TODO" src` | intent=`search`, cost=`tiny` |
| search grep | `grep -rn foo src` | intent=`search`, cost=`tiny` |
| npm test | `npm test` | intent=`test`, cost=`large`, blocking=true |
| pnpm test | `pnpm test` | intent=`test`, cost=`large` |
| pytest | `pytest` | intent=`test`, cost=`large` |
| build | `npm run build` | intent=`build`, cost=`large` |
| install | `npm install` | intent=`install`, cost=`large`, mutates=true |
| dev server | `npm run dev` | intent=`server`, cost=`large` |
| docker compose | `docker compose up` | intent=`server`, cost=`large` |
| deploy | `kubectl apply -f deploy.yaml` | intent=`deploy`, cost=`exclusive`, risky=true |
| migration | `prisma migrate deploy` | intent=`migration`, cost=`exclusive`, risky=true |
| destructive | `rm -rf /tmp/foo` | intent=`cleanup`, cost=`exclusive`, risky=true |

### 5.2 默认分类

```ts
classifyCommand("./scripts/custom.sh")
```

期望：

- intent=`custom`
- cost=`medium`
- blocking=true
- source=`default`
- risky=false

### 5.3 Agent 覆盖

用例：

```ts
classifyCommand("npm test", { intent: "test", cost: "tiny" })
```

期望：

- cost 被提升到 `large`
- source=`agent_overridden_by_policy`
- reason 包含为什么提升

用例：

```ts
classifyCommand("echo ok", { intent: "inspect", cost: "tiny" })
```

期望：

- 尊重 agent
- source=`agent`

### 5.4 风险命令 force

风险分类本身不应因为 `force=true` 改变 risky，只改变 scheduler decision。

期望：

- `classification.risky === true`
- scheduler later decides whether needs_confirmation

## 6. SchedulerService 测试

文件：`src/__tests__/scheduler-service.test.ts`

使用 fake runner：

```ts
class FakeRunner {
  started: string[] = []
  pending = new Map<string, () => void>()
  start(task) {
    this.started.push(task.id)
    return new Promise(resolve => this.pending.set(task.id, () => resolve({ code: 0, stdout: "", stderr: "" })))
  }
  finish(taskId) {
    this.pending.get(taskId)?.()
  }
}
```

### 6.1 large 阻塞 large

步骤：

1. Agent A schedule `npm test`, cost large。
2. Agent B schedule `npm test`, cost large。

期望：

- A `action=run_now`
- B `action=queued`
- B queuePosition=1
- runner.started 只有 A

### 6.2 tiny 不被 large 阻塞

步骤：

1. A schedule large。
2. B schedule `rg foo src` tiny。

期望：

- B `action=run_now`
- runner.started 包含 A 和 B

### 6.3 exclusive 阻塞所有普通任务

步骤：

1. A schedule `kubectl apply ...` with force=true。
2. B schedule `rg foo src`。

期望：

- A run_now
- B queued 或 wait_recommended，取决于默认 ifBusy
- blockers 包含 A

### 6.4 risky 无 force

步骤：

1. schedule `rm -rf /tmp/foo` without force。

期望：

- action=`needs_confirmation`
- 没有 runner.start
- 不进入 queued

### 6.5 queue FIFO

步骤：

1. A large running。
2. B large queued。
3. C large queued。
4. A finish。

期望：

- B 先启动。
- C 仍 queued。

### 6.6 queue max size

设置 `maxQueueSize=2`。

步骤：

1. A large running。
2. B large queued。
3. C large queued。
4. D large schedule。

期望：

- D action=`rejected`
- reason 包含 queue full

### 6.7 if_busy 行为

分别测试：

- `ifBusy=queue` -> queued
- `ifBusy=wait` -> wait_recommended，不入队
- `ifBusy=fail` -> rejected
- `ifBusy=run_anyway` -> run_now，即使存在 blockers

### 6.8 bypass 行为

步骤：

1. A large running。
2. B large with scheduler=bypass。

期望：

- B run_now
- B task.scheduler=`bypass`
- B 出现在 running tasks
- B 不影响 queue admission 计数或按设计标记不参与准入

### 6.9 finish 后状态

步骤：

1. A run_now。
2. fake runner finish A。

期望：

- A status=`completed`
- finishedAt 有值
- exitCode=0
- persistence.saveTask 被调用至少两次：running 和 completed

## 7. Persistence 测试

文件：`src/__tests__/scheduler-persistence.test.ts`

使用临时目录，不写真实 `~/.ssh-tool`。

### 7.1 task atomic write

步骤：

1. saveTask(task)。
2. 读取文件。

期望：

- JSON 正确。
- 文件权限尽量为 600。
- 没有残留 tmp 文件。

### 7.2 restore queued

步骤：

1. 写入 queued task JSON。
2. 新建 PersistenceStore restore。

期望：

- queued task 被恢复。

### 7.3 restore running as stale

步骤：

1. 写入 running task JSON。
2. restore。

期望：

- task status=`stale`
- decisionReason 或 reason 说明 daemon restart 后不可接管

### 7.4 corrupted file ignored

步骤：

1. 写入非法 JSON。
2. restore。

期望：

- 不 throw。
- 可记录 warning。

### 7.5 virtual cwd persistence

步骤：

1. 保存 `agentA:host1 -> /repo-a`。
2. reload。

期望：

- 能恢复 cwd。

## 8. Virtual Cwd 测试

文件：`src/__tests__/virtual-cwd.test.ts`

### 8.1 agent 隔离

步骤：

1. agentA host1 set `/repo-a`。
2. agentB host1 set `/repo-b`。

期望：

- resolve(agentA, host1) = `/repo-a`
- resolve(agentB, host1) = `/repo-b`

### 8.2 host 隔离

步骤：

1. agentA host1 set `/repo-a`。
2. agentA host2 set `/repo-b`。

期望：

- host1 和 host2 不互相影响。

### 8.3 explicit cwd 优先

步骤：

1. virtual cwd = `/repo-a`。
2. schedule with explicit cwd `/tmp`。

期望：

- effectiveCwd=`/tmp`

### 8.4 no cwd

没有 explicit cwd，也没有 virtual cwd。

期望：

- effectiveCwd undefined。

## 9. IPC 测试

扩展：`src/__tests__/daemon-ipc.test.ts`

### 9.1 createRequest 支持新 action

测试：

- `schedule`
- `queueStatus`
- `waitTask`
- `dequeueTask`
- `setCwd`

期望：

- params 正确保留。

### 9.2 encode/decode 新 request

对每个新 action 做 encode -> parse。

期望：

- action 和 params 完整。

## 10. Daemon Scheduler 测试

文件：`src/__tests__/daemon-scheduler.test.ts`

可以先用 fake SSH / fake runner 注入 daemon；如果当前 daemon 不支持注入，需要在实现时为测试留 constructor 选项。

### 10.1 schedule run_now

步骤：

1. daemon handle schedule tiny command。

期望：

- IPC response ok。
- data.action=`run_now`。

### 10.2 schedule queued

步骤：

1. schedule large A。
2. schedule large B。

期望：

- B queued。
- queueStatus 显示 A running, B queued。

### 10.3 waitTask

步骤：

1. schedule short task。
2. waitTask(taskId)。

期望：

- waitTask 返回 completed。

### 10.4 dequeueTask

步骤：

1. large A running。
2. large B queued。
3. dequeue B。

期望：

- B status=`cancelled` 或从 queue 移除。
- queueStatus 不再显示 B queued。

### 10.5 setCwd

步骤：

1. setCwd agentA host1 `/repo`。
2. schedule without cwd。

期望：

- decision.effectiveCwd=`/repo`。

## 11. MCP 测试

扩展：`src/__tests__/mcp-server.test.ts`

新增纯格式契约测试：`src/__tests__/mcp-response.test.ts`

### 11.1 tool schema

验证 `ssh_exec` 新参数存在：

- scheduler
- reason
- intent
- cost
- urgency
- if_busy
- force
- cwd

验证新增工具：

- `ssh_schedule`
- `ssh_queue_status`
- `ssh_wait_task`
- `ssh_dequeue_task`

### 11.2 ssh_exec 默认 scheduler

mock `DaemonClient.schedule()`。

步骤：

1. 调 MCP `ssh_exec`，不传 scheduler。

期望：

- schedule 被调用。
- request.scheduler=`auto`。

### 11.3 统一返回 envelope

覆盖 `src/mcp-response.ts`。

步骤：

1. 构造 queued `ScheduleDecision`。
2. 调 `scheduleDecisionEnvelope()`。
3. 构造 completed/failed/running task 和 output。
4. 调 `guidanceForTaskStatus()`、`guidanceForWaitResult()`、`mcpEnvelope()`。

期望：

- 返回包含 `ok=true`。
- 返回包含 `kind`，例如 `schedule_decision`、`task_status`、`wait_result`、`cancel_result`。
- 返回包含 `data`，且 `data` 保留原始结构。
- 返回包含 `agentGuidance`。
- `ssh_exec` / `ssh_schedule` 使用的 schedule envelope 同时保留顶层 `action`、`taskId`、`result`，兼容旧提示词。
- queued/wait timeout/truncated output 的 guidance 明确要求 AI 不要重复提交同一命令。

### 11.4 ssh_exec_status / ssh_wait_task 输出契约

期望：

- `ssh_exec_status` 返回 `kind="task_status"`，主数据在 `data.task` 和 `data.output`。
- `ssh_wait_task` 返回 `kind="wait_result"`。
- wait 超时时 `data.waitTimedOut=true`，且 guidance 要求继续查同一个 `taskId`。
- wait 完成时返回 `data.output`，包含 stdout/stderr tail、bytes、path、truncated。

### 11.5 ssh_exec_cancel / queue / cleanup 输出契约

期望：

- `ssh_exec_cancel` 返回 `kind="cancel_result"` 和 `data.cancelled`，不返回纯文本。
- `ssh_queue_status` / `ssh_list_tasks` 返回 `kind="queue_status"`。
- `ssh_cleanup_outputs` 返回 `kind="cleanup_result"`。
- 错误也返回 `ok=false`、`kind`、`error`、`agentGuidance`。

### 11.6 ssh_exec bypass

步骤：

1. 调 MCP `ssh_exec`，传 scheduler=`bypass`。

期望：

- schedule 被调用。
- request.scheduler=`bypass`。
- 不走本地 remoteExec。

### 11.7 ssh_schedule 共享 helper

步骤：

1. 调 MCP `ssh_schedule`。

期望：

- 使用和 `ssh_exec` 相同 helper 构造 ScheduleRequest。

### 11.8 ssh_cd virtual cwd

步骤：

1. 调 MCP `ssh_cd`。

期望：

- DaemonClient.setCwd 被调用。
- 返回文案包含“不影响其他 AI”。

## 12. CLI 测试

文件：`src/__tests__/cli-scheduler.test.ts`

如果 CLI main 难以直接测试，建议先把参数解析和 command handler 提取为可测函数。

### 12.1 参数解析

输入：

```text
--profile-name test --command "npm test" --intent test --cost large --if-busy queue --reason "verify"
```

期望：

- intent=test
- cost=large
- ifBusy=queue
- reason=verify
- scheduler 默认 auto

### 12.2 普通 CLI command 走 scheduler

mock `DaemonClient.schedule()`。

步骤：

1. 执行普通 `ssh-exec --profile-name test --command "echo ok"`。

期望：

- 不调用本地 `remoteExec`。
- 调用 `DaemonClient.schedule()`。

### 12.3 shell 不走 scheduler

步骤：

1. 执行 `ssh-exec --profile-name test --shell`。

期望：

- 保持原直连 shell 行为。
- 不调用 schedule。

### 12.4 daemon exec 走 scheduler

步骤：

1. 调 `handleDaemonExec()`。

期望：

- 调用 `DaemonClient.schedule()`。
- 不调用 `client.exec()`。

### 12.5 queued 输出

schedule 返回 queued。

期望：

- CLI 输出包含 taskId、queuePosition、recommendedNextStep。
- exitCode=0。

## 13. 修正现有模块的测试

### 13.1 ExecTaskManager

扩展：`src/__tests__/background-exec.test.ts` 或新增 `exec-task-manager.test.ts`

必须覆盖：

- 普通 exec start 立即持久化。
- 普通 exec 无输出时也可被 list 看到。
- 普通 exec finish 持久化 completed。
- completed task 文件不立即删除。

### 13.2 SessionManager

扩展：`src/__tests__/session-manager.test.ts`

必须覆盖：

- chain A -> B -> target 和 B -> A -> target hash 不同。
- 同样有序 chain hash 相同。

### 13.3 ProfileManager

扩展：`src/__tests__/profile-manager.test.ts`

必须覆盖：

- flat profile load 后 normalize 到 auth。
- auth profile 保持不变。
- flat + auth 混合时行为清晰。

## 14. 端到端并发验收

可做成自动 integration test，也可以先作为人工验收脚本。

### 14.1 large 串行，tiny 并发

步骤：

1. Agent A schedule `sleep 2`，intent=test，cost=large。
2. Agent B schedule `sleep 2`，intent=test，cost=large。
3. Agent C schedule `echo ok` 或 `cat package.json`，cost=tiny。

期望：

- A run_now。
- B queued。
- C run_now。
- A 完成后 B 自动 run_now。

### 14.2 bypass 可见

步骤：

1. A schedule large running。
2. B schedule large with scheduler=bypass。
3. queueStatus。

期望：

- B running。
- B scheduler=bypass。
- queueStatus 显示 B。

### 14.3 virtual cwd 不串扰

步骤：

1. Agent A ssh_cd `/tmp/a`。
2. Agent B ssh_cd `/tmp/b`。
3. A ssh_exec `pwd`。
4. B ssh_exec `pwd`。

期望：

- A effectiveCwd `/tmp/a`。
- B effectiveCwd `/tmp/b`。

## 15. package.json 测试脚本建议

MVP 实现后更新 `package.json`：

```json
{
  "scripts": {
    "test:scheduler": "npm run build:test && node --test dist/__tests__/scheduler-classifier.test.js dist/__tests__/scheduler-service.test.js dist/__tests__/scheduler-persistence.test.js dist/__tests__/virtual-cwd.test.js dist/__tests__/daemon-scheduler.test.js",
    "test:fast": "npm run build:test && node --test dist/__tests__/profile-manager.test.js dist/__tests__/logger.test.js dist/__tests__/session-manager.test.js dist/__tests__/daemon-ipc.test.js dist/__tests__/scheduler-classifier.test.js dist/__tests__/scheduler-service.test.js dist/__tests__/scheduler-persistence.test.js dist/__tests__/virtual-cwd.test.js"
  }
}
```

不要删除现有测试脚本，只追加 scheduler 相关测试。

## 16. 最小通过标准

提交 MVP 前，至少通过：

```bash
npm run build
npm run build:test
npm run test:scheduler
npm run test:fast
```

如果 `test:scheduler` 还没加到 package.json，至少手动运行：

```bash
npm run build:test
node --test dist/__tests__/scheduler-classifier.test.js
node --test dist/__tests__/scheduler-service.test.js
node --test dist/__tests__/scheduler-persistence.test.js
node --test dist/__tests__/virtual-cwd.test.js
node --test dist/__tests__/daemon-scheduler.test.js
```

## 17. 测试实现顺序

建议和代码实现顺序同步：

1. `scheduler-classifier.test.ts`
2. `scheduler-service.test.ts`
3. `scheduler-persistence.test.ts`
4. `virtual-cwd.test.ts`
5. `daemon-ipc.test.ts` 扩展
6. `daemon-scheduler.test.ts`
7. `mcp-server.test.ts` 扩展
8. `cli-scheduler.test.ts`
9. ExecTaskManager / SessionManager / ProfileManager 回归测试

先写 L0/L1，等底层稳定后再接 MCP/CLI。

## 18. 完成定义映射

| 完成定义 | 对应测试 |
|---|---|
| MCP/CLI ssh_exec 默认走 scheduler | `mcp-server.test.ts`, `cli-scheduler.test.ts` |
| MCP/CLI 不各自维护队列 | mock DaemonClient.schedule，确认包装层调用 daemon |
| large 不并发 | `scheduler-service.test.ts`, `daemon-scheduler.test.ts` |
| tiny 可并发 | `scheduler-service.test.ts` |
| bypass 可见 | `scheduler-service.test.ts`, `mcp-server.test.ts` |
| queued 可查/等/取消 | `daemon-scheduler.test.ts` |
| task 持久化 | `scheduler-persistence.test.ts`, ExecTaskManager 测试 |
| daemon restart 恢复 | `scheduler-persistence.test.ts` |
| ssh_cd 不串扰 | `virtual-cwd.test.ts`, `mcp-server.test.ts` |
| effectiveCwd/classification | `scheduler-service.test.ts`, `mcp-server.test.ts` |
