# 调度器设计评审意见

> 评审人：AI Agent
> 评审对象：[AI_COLLABORATIVE_SCHEDULER_DESIGN.md](./AI_COLLABORATIVE_SCHEDULER_DESIGN.md)
> 日期：2026-06-03

---

## 总体评价

设计方向正确。"调度能力必须成为执行路径的一部分"这个核心洞察解决了最根本的问题。
但有几个方面需要在动手前想清楚，否则会在实现过程中踩坑。

---

## 一、架构风险：daemon 从"可选"变成"必须"

### 现状

当前 MCP server 可以通过 `mcp-stdio.ts` 独立运行，**不依赖 daemon**。SSH 连接由 MCP server 自己管理。

### 设计变化

调度器设计把 daemon 变成了**唯一的调度权威**。所有 `ssh_schedule` 请求都必须通过 IPC 到 daemon 才能执行。

### 风险

| 场景 | 后果 |
|------|------|
| daemon 没启动 | `ssh_schedule` 直接失败，用户看到报错 |
| daemon 崩溃 | 队列、锁、运行中任务全部丢失（需要恢复逻辑） |
| 首次安装 | 多了一步：必须先 `ssh-daemon start` |
| 多机部署 | 每台机器都要跑 daemon，增加了运维负担 |

### 建议

- V1 阶段必须在文档和工具描述中**明确说明 daemon 是必选依赖**
- `ssh_schedule` 在 daemon 未启动时，应返回清晰错误信息 + 启动指引
- 考虑 MCP server 启动时**自动拉起 daemon**（当前 `DaemonClient` 已有 `startDaemon` 方法）
- 不建议提供 "daemon 挂了就降级到本地执行" 的 fallback，因为这会让调度形同虚设

---

## 二、命令自动分类——最棘手的部分

### 设计文档的方案

用模式匹配表分类命令，例如：
- `npm test` → `test / medium / workdir lock`
- `ls` → `inspect / tiny / none`
- `kubectl apply` → `deploy / exclusive / host lock`

### 实际困难

| 问题 | 示例 | 难度 |
|------|------|------|
| 组合命令 | `npm run build && npm start` | 是 build 还是 server？ |
| 脚本命令 | `bash deploy.sh` | 完全无法分类 |
| 管道命令 | `cat file \| grep pattern \| sort` | read 还是 search？ |
| 自定义脚本 | `./scripts/ci.sh` | 取决于脚本内容 |
| 变量展开 | `$CMD` 或 `$(which tool)` | 无法静态分析 |
| 误分类后果 | `cat big-file` 被分类为 exclusive | 不必要地阻塞所有任务 |

### 建议

1. **V1 分类器只识别高置信度模式**：精确匹配 `npm test`、`ls`、`cat`、`grep` 等已知命令
2. **无法分类的命令默认 `medium` + `if_busy="queue"`**：安全降级，宁可多排队也不要多拒绝
3. **始终返回分类结果**，让 AI 可以通过显式传 `intent`/`cost` 来覆盖
4. **绝不因为分类失败而拒绝执行**：最差情况是排队等待，不是被拒
5. **分类器应该是一个独立的、可测试的模块**（`command-classifier.ts`），单元测试要覆盖所有边界情况

---

## 三、V1 应该砍掉的复杂度

以下功能设计合理，但不是 MVP 必须，建议推迟到后续 phase：

### 3.1 Agent heartbeat（Phase 5 推迟）

设计中要求每个 MCP server 启动时发送 `agentHello`，之后定期发心跳。

- **代码量**：需要定时器 + 失联检测 + 续租逻辑
- **替代方案**：V1 只用任务记录上的时间戳，失联 agent 的锁通过 TTL 自然过期
- **什么时候必须做**：当需要"清理失联 agent 持有的锁"时，但 TTL 已经能解决 90% 的情况

### 3.2 confirmationToken（Phase 3 推迟）

设计中风险命令返回 `needs_confirmation` + `confirmationToken`，AI 必须带 token 重发。

- **复杂度**：token 生成、校验、过期、状态流转
- **V1 替代方案**：直接返回 `needs_confirmation`，AI 重发时带 `force=true`（布尔值，简单直接）
- **什么时候必须做**：当有多个 AI 可能同时确认同一个风险操作时

### 3.3 EventLog jsonl 审计日志（Phase 4+ 推迟）

设计中要求 `~/.ssh-tool/events/scheduler-YYYY-MM-DD.jsonl`。

- **好处**：审计、回溯、调试
- **V1 替代方案**：在 `ScheduledTask` 记录中保留 `decisionReason`，持久化的 task JSON 已经足够回溯
- **什么时候必须做**：当需要"最近 10 分钟发生了什么"的查询能力时

### 3.4 多策略预设（Phase 4+ 推迟）

设计中提供了 3 种策略预设（小型 VM / 保守单仓库 / 读多写少）。

- **V1 替代方案**：硬编码一套默认值（取"小型共享开发 VM"那套），不暴露配置接口
- **什么时候必须做**：当用户反馈默认策略不适合他们的场景时

### 3.5 HostIdentity 完整 chain 结构体（简化）

设计中 `HostIdentity` 包含完整 chain 数组。

- **V1 简化**：用 `profileKey`（从有序 chain 生成的 hash）作为唯一标识即可，不需要在运行时存储完整 chain
- **展示时**：只显示 `targetHost:targetUser`

---

## 四、执行顺序调整建议

设计文档的 5 个 Phase 大方向正确，但内部优先级需要调整。

### Phase 0：和文档一致（必须先做）

- 所有 exec 任务创建时立即持久化
- 稳定 host identity
- 任务保留策略可配置
- 修复 background detached 行为

**理由**：如果当前任务追踪都不可信，加队列只会让问题更复杂。

### Phase 1：简化版调度骨架（比文档更轻量）

设计文档的 Phase 1 要求完整的 `SchedulerService`，我认为应该分两步：

**Phase 1a：简单并发控制**
- 不做完整 SchedulerService
- daemon 内跟踪"每个 host 上有几个任务在跑"
- 简单准入：超过 N 个 large 任务就排队
- 不做命令分类，不做锁管理
- 新增 `ssh_schedule`（简单版）、`ssh_wait_task`、`ssh_queue_status`

**Phase 1b：加入命令分类 + 意图**
- 引入 `command-classifier.ts`
- 引入 `TaskIntent` / `TaskCost`
- 根据 cost 调整并发策略

**理由**：一次引入太多新概念（调度 + 分类 + 队列 + 锁 + 持久化），调试会非常痛苦。先用最简单的并发控制验证 IPC 通路，再逐步加策略。

### Phase 2：MCP 工具接入（和文档一致）

- 新增 `ssh_schedule`、`ssh_wait_task`、`ssh_queue_status`
- 但 **暂不改 `ssh_exec` 的默认行为**

**关键分歧**：设计文档要求 Phase 2 就把 `ssh_exec` 默认改为走 scheduler。我认为应该推迟到 scheduler 稳定后（Phase 3）再改。

**理由**：
- `ssh_exec` 是当前最常用的工具，改默认行为影响面大
- scheduler 刚实现时可能有 bug，不应影响现有路径
- 先让 `ssh_schedule` 跑一段时间，确认稳定后再迁移 `ssh_exec`

### Phase 3：锁管理

- workdir lock（防止同一目录下 install 冲突）
- host lock（exclusive 操作）
- TTL + 过期清理
- 此时才改 `ssh_exec` 默认走 scheduler

### Phase 4+：策略引擎、输出体验、高级功能

和文档一致。

---

## 五、几个具体的设计决策点

以下是需要在动手前确认的问题：

### 5.1 队列溢出策略

设计文档没有提到队列满了怎么办。

- 建议：设置 `maxQueueSize`（默认 50），满了直接 `rejected`，而不是无限排队

### 5.2 优先级滥用

设计中 `priority` 是数字，AI 可能传很高优先级来插队。

- 建议：V1 不开放 `priority` 参数给 AI，所有任务默认相同优先级，FIFO 排队
- 后续可以引入"AI agent 级别优先级"（在 agent 注册时确定），而不是任务级别

### 5.3 `ssh_exec` 的 bypass 路径安全

设计文档允许 `scheduler="bypass"`。

- 建议：bypass 任务仍然要在 daemon 注册（只记录不调度），否则 `ssh_queue_status` 会漏掉 bypass 任务
- bypass 任务不应计入并发槽位，但应在 host load 中可见

### 5.4 输出文件增长

设计中每个 task 写 stdout/stderr 文件。长时间运行的任务（如 dev server）输出可能非常大。

- 建议：设置输出文件大小上限（如 10MB），超出后只保留 tail
- 或者只对 blocking=true 的任务写完整输出，其他任务只保留最后 N 行

### 5.5 跨 daemon 重启的 running task

设计文档建议标记为 `stale`。但 `stale` 的任务意味着：
- 远端进程可能还在跑（daemon 只是本地挂了）
- 没人能知道它的退出码
- 没人能取消它

- 建议：V1 对 stale 任务只做记录，不做任何自动处理。让 AI 通过 `ssh_exec` 手动检查远端进程状态
- 后续可以通过远端 supervisor（如 `nohup` + PID 文件）实现重接管

---

## 六、测试策略补充

设计文档的测试计划已经很完整，补充几个关键场景：

### 6.1 必须有的并发测试

```
1. Agent A 跑 sleep 10（large task）
2. Agent B 跑 sleep 5（large task）-> 应该排队
3. Agent C 跑 cat file（tiny task）-> 应该立即执行
4. Agent A 完成 -> Agent B 自动开始
5. Agent B 完成 -> 队列为空
```

### 6.2 必须有的异常测试

```
1. daemon 在有排队任务时崩溃重启 -> 持久化任务能恢复
2. AI 发了 schedule 后进程被杀 -> 锁 TTL 自动过期
3. 两个 AI 同时发 exclusive 任务 -> 只有一个拿到锁
4. SSH 连接在任务运行中断开 -> 任务标记为 failed，锁释放
```

### 6.3 性能基线

- `ssh_schedule` 的 IPC 延迟应 < 5ms（不含 SSH exec）
- 策略决策（分类 + 准入检查）应 < 1ms
- 队列 pump 延迟应 < 10ms

---

## 七、总结

| 方面 | 评价 | 行动建议 |
|------|------|----------|
| 核心方向 | ✅ 正确 | 按文档方向推进 |
| daemon 依赖 | ⚠️ 未充分讨论 | 明确 daemon 为必选依赖，考虑自动拉起 |
| 命令分类 | ⚠️ 实际会很难 | V1 只做高置信度分类，其余安全降级 |
| V1 范围 | ⚠️ 偏大 | 砍掉 heartbeat/token/EventLog/多策略 |
| Phase 顺序 | ⚠️ 需要调整 | Phase 1 拆为 1a（简单并发）+ 1b（分类），Phase 2 暂不改 ssh_exec 默认 |
| 队列溢出 | ❌ 未提及 | 加 maxQueueSize |
| 优先级 | ⚠️ 可能被滥用 | V1 不开放给 AI |
| bypass 路径 | ⚠️ 可能漏统计 | bypass 任务仍注册到 daemon |
| 输出文件 | ⚠️ 可能无限增长 | 加大小上限 |
| 测试 | ✅ 方向正确 | 补充并发和异常场景 |

---

**建议下一步**：确认上述决策点后，先从 Phase 0 开始实现，把现有任务追踪修可靠。
