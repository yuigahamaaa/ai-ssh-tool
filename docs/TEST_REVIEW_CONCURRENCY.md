# 压力测试/并发测试/多会话并发测试审查报告

> 日期：2026-06-05
> 目标读者：项目维护者、QA 工程师

## 1. 审查背景

项目已有完善的单元测试和集成测试体系（共 25+ 测试文件），但在以下场景存在明显缺口：

- **压力测试**：缺乏高吞吐量场景验证（500+ 任务、1000+ 操作）
- **并发测试**：缺乏同进程多调用方同时操作的竞态验证
- **多会话并发测试**：缺乏多 Agent/多 Host 同时调度的隔离性验证
- **Daemon IPC 并发测试**：缺乏多客户端同时通过 IPC 操作 Daemon 的测试
- **异常恢复测试**：缺乏 fatal error 下“中断任务、清空队列、退出/重启”的测试
- **性能测试**：缺乏高并发 SSH exec（50/100 路并发）和持续吞吐量的压测

## 2. 新增测试文件

### 2.1 压力测试 — `stress-test.test.ts`

**12 个测试用例**，覆盖以下场景：

| 测试组 | 用例 | 验证点 |
|---|---|---|
| 高吞吐调度 | 500 tiny 任务无错误 | 系统在高吞吐下不 reject、不崩溃 |
| | 100 large 任务队列正确 | 队列满后拒绝、drain 后恢复 |
| 队列饱和 | 队列满拒绝 + drain 后恢复 | `maxQueueSize` 限制生效 |
| 输出存储压力 | 1000 次快速 append | 字节计数精确、不丢失 |
| | 100 个并发任务输出文件 | 多文件隔离不互相污染 |
| | 大量文件 cleanup 不抛异常 | 清理逻辑在大量文件下稳定 |
| 持久化压力 | 写入 + 恢复 200 个任务 | 原子写入、正确分类 running→stale |
| | 50 次快速覆盖同一任务文件 | 最终状态一致、无损坏 |
| 锁管理器压力 | 500 次快速 acquire/release 循环 | 无泄漏、最终锁数为 0 |
| | 100 次对同一资源的竞争 | 正确拒绝/释放 |
| 事件日志压力 | 1000 条事件 + 过滤/限量查询 | 计数正确、过滤准确 |
| 内存稳定性 | 5 轮 × 50 任务的 schedule+finish 循环 | 内存增长 < 50MB |

### 2.2 并发测试 — `concurrency.test.ts`

**25 个测试用例**，覆盖以下场景：

| 测试组 | 用例 | 验证点 |
|---|---|---|
| 并发 schedule 调用 | 20 个 tiny 任务全部 `run_now` | 同 Host 多 Agent 并发调度无障碍 |
| | 10 个 large 任务正确串行化 | `maxLargeRunning=1` 严格生效 |
| | 混合 cost 任务的准入控制 | tiny/large 共存时正确判断 |
| 锁竞争 | workdir 互斥 | 不同 Agent 对同一 workdir 互斥 |
| | host 级 exclusive 锁 | exclusive 任务获取 host 锁 |
| | 同 Agent 锁续约 | 不会自己锁自己 |
| | 锁释放后等待者获取 | 释放后其他 Agent 可获取 |
| | `releaseForTask` 清理所有锁 | 一个 task 的所有锁全部清理 |
| | 不同 scope 锁不互相干扰 | host 锁 vs workdir 锁独立 |
| waitTask 并发 | 5 个 waiter 同时等同一任务 | 任务完成时全部 resolve |
| | waitTask 超时返回当前状态 | 超时后 status=running |
| | waitTask 等待排队任务被 promote | 超时返回当前 running 状态 |
| | cancelTask 解决所有 waiter | 取消后 waiter 拿到 cancelled |
| | dequeueTask 解决 queued waiter | dequeue 后 waiter 立即拿到 cancelled |
| 队列操作竞态 | dequeue + finish 交叉 | 正确的 FIFO promote |
| | cancelTask 释放 running 位 | 取消后下一个 queued task 立即 running |
| | 迟到 runner completion | 取消后的 completed/failed 回调不会覆盖 cancelled |
| | queueStatus 反映并发状态 | running/queued 计数正确 |
| 输出并发追加 | 10 个任务 × 100 行交错写入 | 每个任务字节数精确 |
| | 同任务 stdout+stderr 并发写入 | 两者都有数据不互相覆盖 |
| Exclusive 阻塞 | exclusive 阻塞所有 tiny 任务 | tiny 全部 queued |
| | exclusive 结束后排队任务 promote | pumpQueue 正确工作 |
| | cancel exclusive 释放 host lock | 取消后 tiny queued task 立即 running |
| pumpQueue 边界 | FIFO 顺序 promote | position 1 先于 position 2 |
| | 失败任务不阻塞队列 | failed 后继续 promote 下一个 |

### 2.3 多会话并发测试 — `multi-session-concurrency.test.ts`

**13 个测试用例**，覆盖以下场景：

| 测试组 | 用例 | 验证点 |
|---|---|---|
| 多 Agent 同 Host 调度 | 10 个 Agent 的 tiny 任务全部 run_now | 同 Host 并发无障碍 |
| | 5 个 Agent 的 large 任务只有 1 个运行 | maxLargeRunning 严格限制 |
| | Agent heartbeat 并发更新 | 20 个 Agent × 100 次 heartbeat 不抛异常 |
| 跨 Host 调度 | 不同 Host 的 large 任务独立 | host-alpha 和 host-beta 互不阻塞 |
| | queueStatus 按 Host 过滤 | 只返回指定 Host 的任务 |
| | exclusive 不阻塞其他 Host | host-alpha exclusive 不影响 host-beta |
| | 10 个 Host × 5 个 Agent 并发 | 50 个 tiny 任务全部 run_now |
| 虚拟 CWD 并发隔离 | 10 个 Agent 设置不同 CWD | 各自 resolve 结果独立 |
| | 同 Agent 不同 Host 的 CWD 独立 | host-a/host-b CWD 互不影响 |
| | virtual CWD 出现在 task decision | effectiveCwd 正确 |
| | explicit cwd 覆盖 virtual cwd | 优先级正确 |
| | 100 次快速 CWD 切换不损坏 | 最终状态正确 |
| | queueStatus 返回请求者 Agent 的 CWD | alice/bob 各自看到自己的 CWD |
| Daemon IPC 并发 | 5 个客户端同时 ping | 全部成功 |
| | 3 个客户端同时 schedule | 全部成功 |
| | 3 个客户端同时 setCwd | 不抛异常 |
| | 5 个客户端同时 list sessions | 全部成功 |
| | 快速 connect/disconnect 循环 | 10 次循环不崩溃 |
| 多 Agent 任务生命周期 | A 结束后 B/C 按 FIFO promote | 正确顺序 |
| | 多 Agent 各自 dequeue 自己的任务 | 互相不影响 |
| | Agent 取消 running 任务后下一个 promote | 取消 → 排队 → promote |
| | getRecentEvents 包含多 Agent 事件 | 事件来源多样 |
| 输出隔离 | 不同 Agent 的 task 输出互不污染 | stdout 正确隔离 |
| | 并发 getTaskOutput 不干扰 | 各自拿到正确结果 |

### 2.4 异常恢复/清场测试 — `scheduler-service.test.ts`、`daemon-lifecycle.test.ts`

新增覆盖：

| 测试组 | 用例 | 验证点 |
|---|---|---|
| Scheduler fatal abort | running + queued 同时 abort | queued 不被 promote，waiter 立即拿到 cancelled |
| | runner.cancel 失败 | running 不被乐观标 cancelled，返回 `cancelFailed` |
| Daemon IPC abort | 通过 daemon client 调 `abortActiveTasks` | CLI/MCP 共用 IPC 清场通道可用 |
| Daemon lifecycle | stop/shutdown 不再 `process.exit` | 便于测试和 supervisor 管理 |

### 2.4 performance.test.ts 扩展

新增 **4 个测试用例**：

| 用例 | 验证点 |
|---|---|
| 50 并发 SSH exec < 10s | 高并发下的吞吐量 |
| 100 并发 SSH exec 不崩溃 | 极限并发下的稳定性 |
| 100 次顺序 exec 的延迟一致性 | P95 < 500ms |
| 100 次 exec 后内存增长 < 50MB | 内存稳定性 |

## 3. package.json 更新

新增测试脚本：

| 脚本 | 说明 |
|---|---|
| `test:stress` | 仅运行压力测试 |
| `test:concurrency` | 仅运行并发测试 |
| `test:multi-session` | 仅运行多会话并发测试 |
| `test:load` | 运行所有压力+并发+多会话测试 |
| `test:fast` | 已追加 concurrency、multi-session-concurrency 和 stress-test |
| `test:all` | 已追加 test:load |

## 4. 测试结果

```
# test:load 运行结果
# tests 263
# suites 72
# pass 263
# fail 0
# duration_ms 20408ms
```

本次 fast 等价套件全部通过，总运行时间约 20.4 秒。

## 5. 覆盖矩阵

| 维度 | 之前覆盖 | 新增覆盖 | 说明 |
|---|---|---|---|
| 高吞吐调度 (500+ 任务) | ❌ | ✅ | stress-test.test.ts |
| 队列饱和/恢复 | ❌ | ✅ | stress-test.test.ts |
| 输出存储压力 (1000+ append) | ❌ | ✅ | stress-test.test.ts |
| 持久化压力 (200 文件) | ❌ | ✅ | stress-test.test.ts |
| 锁管理器压力 (500 循环) | ❌ | ✅ | stress-test.test.ts |
| 内存稳定性 (250 任务周期) | 基础 | ✅ 增强 | stress-test.test.ts + performance.test.ts |
| 同 Host 并发 schedule | ❌ | ✅ | concurrency.test.ts |
| 锁竞争 (互斥/续约/释放) | 基础 | ✅ 增强 | concurrency.test.ts |
| waitTask 多 waiter 并发 | ❌ | ✅ | concurrency.test.ts |
| 队列操作竞态 (dequeue+finish/cancel/late finish) | ❌ | ✅ | concurrency.test.ts |
| 输出并发追加 | ❌ | ✅ | concurrency.test.ts |
| 多 Agent 同 Host 调度 | ❌ | ✅ | multi-session-concurrency.test.ts |
| 跨 Host 独立调度 | ❌ | ✅ | multi-session-concurrency.test.ts |
| 虚拟 CWD 并发隔离 | 基础 | ✅ 增强 | multi-session-concurrency.test.ts |
| Daemon IPC 多客户端并发 | 仅 2 客户端 | ✅ 5 客户端 | multi-session-concurrency.test.ts |
| Fatal abort 清场 | ❌ | ✅ | scheduler-service.test.ts + daemon-lifecycle.test.ts |
| 多 Agent 任务生命周期 | ❌ | ✅ | multi-session-concurrency.test.ts |
| 输出隔离 | ❌ | ✅ | multi-session-concurrency.test.ts |
| 50/100 路并发 SSH exec | ❌ | ✅ | performance.test.ts |
| 持续吞吐量延迟一致性 | ❌ | ✅ | performance.test.ts |

## 6. 审查发现与处理结果

在编写测试过程中，发现以下值得关注的行为：

### 6.1 `cancelTask` 不触发 `pumpQueue`（已修复）

原行为：当 `cancelTask` 取消一个 running 任务时，不会自动 promote 排队中的下一个任务。只有 `finishTask`（任务自然完成/失败）才触发 `pumpQueue`。

处理结果：

- `cancelTask` 成功后会调用 `pumpQueue(hostId)`。
- running task 取消后会释放该 task 的 host/workdir lock。
- 迟到的 runner completion 不再覆盖 `cancelled` 状态。
- 已补充 `scheduler-service.test.ts` 和 `concurrency.test.ts` 回归测试。

### 6.2 `dequeueTask` 不唤醒 waiters（已修复）

原行为：queued task 被 dequeue 后，正在 `waitTask(taskId)` 的调用方可能要等到 timeout 才拿到取消状态。

处理结果：

- `dequeueTask` 会立即 resolve waiters。
- 已补充 `dequeueTask resolves queued task waiters immediately` 测试。

### 6.3 `echo` 命令被分类为 `custom/medium` 而非 `tiny`（已修复）

命令分类器 (`command-classifier.ts`) 的规则中，`echo` 不在 `inspect` 类的正则中（只匹配 `cat`、`head` 等），因此 `echo ok` 被分类为 `custom/medium`。测试中使用 `rg` 或显式指定 `cost: "tiny"` 来确保 tiny 行为。

处理结果：`echo` 已加入 inspect/tiny 分类。

### 6.4 持久化 `restore()` 只返回 queued 和 stale 任务

`PersistenceStore.restore()` 只返回状态为 `queued` 和 `running→stale` 的任务，不返回 `completed`/`failed`/`cancelled` 状态的任务。测试需要使用 `loadAllTasks()` 来验证所有任务的持久化。

### 6.5 `abortActiveTasks` 复用 `cancelTask` 会短暂 promote queued 任务（已修复）

原行为：fatal 清场时按 active task 遍历并调用 `cancelTask()`。如果先取消 running task，`cancelTask()` 会释放 slot 并触发 `pumpQueue()`，导致 queued task 在清场过程中被短暂启动。

处理结果：

- `abortActiveTasks()` 先取消 queued task，再取消 running task。
- queued waiter 会立即收到 cancelled。
- runner.cancel 失败时只计入 `cancelFailed`，不把 running task 乐观标成 cancelled。
- daemon IPC 增加 `abortActiveTasks`，MCP fatal handler 可请求 daemon 统一清场。

### 6.6 unknown fatal error 不再吞异常（已调整）

原行为：`uncaughtException` / `unhandledRejection` 记录后继续运行，表面上提高可用性，但可能让 scheduler/SSH 状态在损坏后继续服务。

处理结果：

- daemon fatal handler：记录错误 → `scheduler.abortActiveTasks()` → `gateway.disconnectAll()`/关闭 IPC → 可选拉起 replacement → 当前进程非 0 退出。
- replacement 通过 `SSH_TOOL_DAEMON_RESTART_COUNT` 限制重启次数，避免无限 crash loop。
- MCP fatal handler：请求 daemon 清场、断开本地 SSH、退出；由 MCP 宿主负责重启 stdio server。
- daemon signal handler 改为可移除实例监听，`shutdown/stop` 不再强制 `process.exit(0)`，便于测试和 supervisor 管理。

## 7. 后续建议

### 高优先级

1. **添加 `test:load` 到 CI 手动/扩展流程** — 确保需要时可跑压力/并发完整套件

### 中优先级

2. **添加真实 SSH 并发测试** — 当前压力测试使用 FakeRunner，应补充真实 SSH 连接的并发测试
3. **添加超时恢复测试** — 验证任务超时后队列自动 promote
4. **添加 Daemon replacement 端到端测试** — 用子进程触发 fatal，验证旧进程退出、新 daemon 可 ping

### 低优先级

5. **添加分布式锁测试** — 如果未来支持多 Daemon 实例
6. **添加性能回归基准** — 固化性能指标到 CI

## 8. 运行方式

```bash
# 运行所有压力/并发测试
npm run test:load

# 仅运行压力测试
npm run test:stress

# 仅运行并发测试
npm run test:concurrency

# 仅运行多会话并发测试
npm run test:multi-session

# 运行所有测试（包含压力/并发）
npm run test:all
```
