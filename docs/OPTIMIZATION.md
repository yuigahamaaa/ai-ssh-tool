# ssh-tool 性能 / 架构 / 内存优化审核（第三轮）

> 审核范围：`src/` 全量（~7.3k 行），覆盖调度器、任务管理、连接池、IPC、端口转发、文件传输、配置解析。
> 审核日期：2026-06-13 ｜ 基线分支：`main`（e014ab0）｜ 所有发现均经 codegraph 对照源码逐条验证，已剔除误报。
> 前两轮审核（2026-06-12、2026-06-13 凌晨）的结论见文末「历史问题状态」。

---

## 0. 总体评价

前两轮审核的 P0/P1 项已基本全部落地，质量很高：

- ✅ **P0-1** `BatchedPersistenceStore` 已接入 daemon（`daemon.ts:148-153`，继承 `PersistenceStore`，`dispose()` 走 `flushSync`）
- ✅ **P0-2** 热路径持久化已全部改为紧凑 JSON（`persistence-store.ts:70/130`、`exec-task-manager.ts:177`）
- ✅ **P0-3** `getFinishedTasks` 已改用 `finishedByTime` 有序索引反向扫描（`scheduler-service.ts:685-700`）
- ✅ **P1-1** exec 运行中输出已修（`stdoutChunks`/`stderrChunks` 提升到 `RunningTaskEntry`），`getOutput`/`getStatus` 实时可见
- ✅ **P1-2** IPC parser 已用增量 `Buffer[]` + offset cursor，10MB 大帧不再 O(n²)（`ipc-protocol.ts:120-243`）
- ✅ **P1-3** `ExecTaskManager.maybeCleanup` 改为纯时间触发，移除了阈值触发的全量读盘
- ✅ **P1-4** 持久化节流已从全局 `lastPersistAt` 改为 per-task，避免多任务互相抑制
- ✅ **P1-5** `ssh-config.ts` Include 已有 `visited: Set<string>` 环检测
- ✅ **P1-6** `daemon.handleConnect` 命中 cache 零读盘零 parse；冷路径只 parse 一次
- ✅ **P1-7** `pumpQueue` 改为预计算 running 集合 + 成本计数，O(queued × running) → O(queued + running)
- ✅ **P1-8** `firstLine` 加 4KB 上限，stdout 侧 PID 解析已删除（PID 来自 stderr）

本轮剩余待修项**全部是 P2 打磨项**，无一影响正确性或稳定性。

---

## P2 — 低收益 / 打磨项

> 文档要求"日常迭代中逐步消化"。本轮以**修复成本**为序排列，越靠前越建议尽早动。

### P2-1. file-transfer 的 `sftp.end()` 靠手工逐路径配对

`file-transfer.ts:381/391/443/448/536/580/627/637`：当前各路径检查下来基本配平，但模式脆弱——新增分支漏一个就泄漏 SFTP channel。建议统一为 `try { ... } finally { sftp.end() }`。已有的 `file-transfer-multi-hop.test.ts` 是好的回归兜底。

**修复成本**：小，~1 小时。**风险**：低。

### P2-2. `appendTail` 用 UTF-16 码元当字节数

`output-store.ts:64-68`：`.length`/`.slice(-LIMIT)` 会切断多字节字符，且与 `stdoutBytes` 的真实字节计数语义不一致。建议统一走 `Buffer`。

**修复成本**：小，~30 分钟。**风险**：低。

### P2-3. `backgroundTaskHandles` 三个细节问题

`daemon.ts:42, 218-269`：① daemon `stop()` 不调用各 handle 的 `stop()` 也不清 Map；② `close` 和 `error` 可能先后触发导致 `onClose` 被调两次（加 `closed` 标志位即可）；③ 若 stream 永不触发 close/error 则条目永存（可挂超时兜底）。

**修复成本**：中，~2 小时。**风险**：低。

### P2-4. `removeFromFinishedIndex` 用 `indexOf` 线性扫描

`scheduler-service.ts:765-771`（注释已自认）。当前批量驱逐场景可接受。

**修复成本**：小。**风险**：极低（仅影响批量 evict）。

### P2-5. `getHostIdentifier` 反射 ssh2 私有字段

`exec-task-manager.ts:71-77`：ssh2 升级易碎，建议建连时显式传入 host。

**修复成本**：中（需要从 daemon 透传 host 到 exec 调用栈）。**风险**：中。

### P2-6. daemon-client `_connect` 与外部 `disconnect` 的窗口竞态

`daemon-client.ts:42-68`：connect 等待期间若外部调 `disconnect()`，socket 被 destroy 但 `connect` 事件 promise 永不 resolve → 挂起。给 `_connect` 加「socket 已被换掉则 reject」的防御即可。低概率（CLI 短生命周期）。

**修复成本**：小。**风险**：低。

### P2-7. 静默吞错三处

daemon socket `error` 空处理（`daemon.ts:423-425`）、IPC malformed line 静默跳过（`ipc-protocol.ts:141-143`）、各处 `.catch(() => {})` 的 disconnect。至少在 debug 日志里记一笔，否则线上问题无从排查。

**修复成本**：小。**风险**：零。

### P2-8. mcp-server 工具体错误文案结构化

经核实**不会**导致 server 崩溃——MCP SDK 会捕获 handler 异常并返回 `isError: true`。但错误文案是裸 `Error.message`，不走 `mcp-response.ts` 的结构化 envelope，agent 拿到的错误缺少可操作信息。可加一个统一的 `wrapTool(handler)` 包装器。

**修复成本**：中（要逐个工具替换）。**风险**：低。

### P2-9. logger 每行 `appendFileSync`

`logger.ts:73`：仅 debug 模式生效（`:64` 有 gate），常态零开销。若 debug 下做高频流式输出排查会放大延迟，可顺手套用 EventLog 的缓冲模式，优先级很低。

### P2-10. profile-manager 同步 IO + pretty-print

`profile-manager.ts:46-97`：低频路径，可接受；若未来在请求路径上反复 `load()` 再优化。

---

## 架构层面：两套并行的任务管理子系统（维持上轮结论）

| | 子系统 A | 子系统 B |
|---|---|---|
| 入口 | `ExecTaskManager` + `BackgroundExecManager` | `SchedulerService` |
| 落盘目录 | `~/.ssh-tool/exec-tasks/` | `~/.ssh-tool/scheduler/` |
| 输出存储 | task JSON 内嵌 stdout/stderr | 独立 `OutputStore`（tail + 全量文件） |
| 清理/TTL | `cleanupOldTasks` + 时间间隔 | `OutputStore.cleanup` + 空闲驱逐定时器 |
| PID 捕获 / cancel 竞态 | 各实现一份 | 各实现一份 |

上一轮的 P0-1（运行中输出为空）正是「修了 B 忘了 A 的对称问题、又在 A 上引入新回归」的实例——这类双轨债的成本已经从「理论上的双倍维护」变成了「实际发生的回归」。建议把 **background-exec 切到调度器的 `OutputStore` + 持久化**提上日程：上轮 P0-1 的修复方案 2 本身就是收敛的第一步，可以合并规划。改动面大，仍建议独立立项、独立测试。

---

## 建议的落地顺序

1. **P2-1 / P2-2 / P2-3** —— 都是可在 1-2 小时内完成的低风险小重构，值得一并在下一个迭代里清掉。
2. **P2-5** —— ssh2 私有字段反射一旦 ssh2 升级就会断，值得早做，但需要从 daemon 透传 host。
3. **P2-8** —— MCP 错误文案可操作性对 agent 体验影响大。
4. 剩余 P2-4 / 6 / 7 / 9 / 10 与架构收敛穿插在日常迭代里消化。
5. 架构收敛（两套任务系统合一）——独立立项。

每一项配微基准或回归测试（扩展现有 `performance.test.ts` / `stress-test.test.ts` / `exec-task-manager-memory.test.ts`），避免「优化了但没测出来」或再次引入 P0-1 式回归。

---

## 附：历史问题状态 & 本轮已排除的疑似问题

**前两轮问题状态**：

| 轮次 | 项 | 状态 |
|---|---|---|
| 1 | P0-1 BatchedPersistenceStore 未接入 | ✅ 已修（daemon.ts:148） |
| 1 | P0-2 热路径 pretty-print JSON | ✅ 已修（profile-manager 保留，低频） |
| 1 | P0-3 getFinishedTasks 全量扫描 | ✅ 已修（有序索引反向扫描） |
| 1 | P1-1 list() O(n²) | ✅ 已修（Map 合并） |
| 1 | P1-2 10MB 输出内嵌 JSON | ⏸️ 维持上轮（架构收敛独立立项） |
| 1 | P1-3 EventLog 同步逐条写 | ✅ 已修（200ms 缓冲 + 失败重缓冲） |
| 1 | P1-4 pumpQueue O(q×r) | ✅ 已修（预计算 running + 成本计数） |
| 2 | P0-1 exec 任务运行期间输出为空（功能回归） | ✅ 已修（chunks 提升到 entry） |
| 2 | P0-2 localForward 无 error 监听 | ✅ 已修（socket + stream 双 error handler） |
| 2 | P0-3 remoteForward tcp connection 监听器泄漏 | ✅ 已修（单一分发器 + remoteRoutes Map） |
| 2 | P1-1 连接状态同步缺失 | ✅ 已修（installPostConnectHandlers） |
| 2 | P1-5 Include 环检测缺失 | ✅ 已修（visited Set） |
| 3 | P1-2 IPC parser O(n²) 字符串拷贝 | ✅ 已修（Buffer[] + offset cursor） |
| 3 | P1-3 maybeCleanup 阈值触发全量读盘 | ✅ 已修（纯时间触发） |
| 3 | P1-4 持久化节流全局变量 | ✅ 已修（per-task） |
| 3 | P1-6 daemon handleConnect 双重 readFileSync/parse | ✅ 已修（缓存 hit 零 IO，cold 1 parse） |
| 3 | P1-7 pumpQueue O(q×r) | ✅ 已修（预计算 + 计数） |
| 3 | P1-8 firstLine 无界累积 | ✅ 已修（4KB 上限 + 删 stdout PID 解析） |

**本轮审查过并排除的疑似问题**（避免后续重复排查）：

- `handleFatal` 不 flush 调度器持久化 —— 误报：`handleFatal` 调 `this.stop()`，其中 `scheduler.dispose()` 会 `flushSync`（daemon.ts:349, 379）。
- `sweepIdle` 漏调 `cleanupSession` —— 误报：已调用（daemon.ts:997）。
- MCP 工具异常导致 server 崩溃 —— 误报：SDK 兜底转 `isError` 响应（降级为 P2-8 的错误文案结构化问题）。
- exec-task 的 cwd/env 经 `JSON.stringify` 注入 —— 安全：JSON 双引号转义在 POSIX shell 下无法逃逸。
- `maxRemainderBytes` 防护、`IPCSocket.dispose`、virtual-cwd 防抖、daemon 单例/信号处理、锁 TTL —— 检查无问题。
