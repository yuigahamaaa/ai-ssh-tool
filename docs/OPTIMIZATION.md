# ssh-tool 性能 / 架构 / 内存优化审核（第二轮）

> 审核范围：`src/` 全量（~7.3k 行），覆盖调度器、任务管理、连接池、IPC、端口转发、文件传输、配置解析。
> 审核日期：2026-06-13 ｜ 基线分支：`main`（07fa284）｜ 所有发现均经 codegraph 对照源码逐条验证，已剔除误报。
> 上一轮审核（2026-06-12）的结论见文末「上一轮问题状态」。

---

## 0. 总体评价

上一轮审核的高优先级项已基本全部落地，质量很高：

- ✅ **P0-1** `BatchedPersistenceStore` 已接入 daemon（`daemon.ts:148-153`，继承 `PersistenceStore`，`dispose()` 走 `flushSync`）
- ✅ **P0-2** 热路径持久化已全部改为紧凑 JSON（`persistence-store.ts:70/130`、`exec-task-manager.ts:177`）
- ✅ **P0-3** `getFinishedTasks` 已改用 `finishedByTime` 有序索引反向扫描（`scheduler-service.ts:685-700`）
- ✅ **P1-1（部分）** `ExecTaskManager.list()` 已用 Map 合并去重，O(n²) → O(n+m)（`exec-task-manager.ts:491-525`）
- ✅ **P1-3** `EventLog` 已改为缓冲 + 200ms 防抖 flush，失败重缓冲，`getRecent` 前自动 flush（`event-log.ts`）
- ✅ **P2** `OutputStore.create` 已惰性建文件（`output-store.ts:95-112`）

本轮把审核面扩大到了上一轮未覆盖的子系统（连接、端口转发、文件传输、IPC、配置解析），发现了**新的正确性/稳定性问题**——其中两个比性能问题更紧急：一个是上轮内存优化引入的功能回归，一个是可导致 daemon 崩溃的未处理 error 事件。

---

## P0 — 正确性 / 稳定性问题，建议立即修

### P0-1. exec 任务运行期间输出为空 ⭐ 上轮优化引入的功能回归

**现状**：`exec-task-manager.ts` 为了避免在每个 data 事件上做字符串拼接，把输出改成了 `stdoutChunks: Buffer[]` 缓冲，只在 `flushChunks()`（`exec-task-manager.ts:276-281`）时才合并回 `task.stdout`/`task.stderr`。但 `flushChunks` **只在 close / error / timeout 时调用**。

后果：任务运行期间——

- `getOutput(id)`（`:527`）返回 `entry.task.stdout` → **空字符串**
- `getStatus(id)` / `list()` 返回的 task 快照里输出也是空
- `getOutputSince`（`:544`）基于空字符串做 offset 切片，轮询永远拿不到增量
- `BackgroundExecManager.getOutput`（`background-exec.ts:91`）直接透传，**后台任务运行中无法查看任何输出**——这是 agent 轮询长任务的核心使用场景
- 周期性 `saveTask(entry, false)` 落盘的也是空输出，daemon 崩溃后磁盘上的 running 任务没有任何输出可恢复

**修复**（择一）：

1. 让 `getOutput`/`getStatus` 读取时按需合并：`Buffer.concat(stdoutChunks).toString()`（chunks 是闭包变量，需要把引用挂到 `RunningTaskEntry` 上）。读是低频操作，按需合并代价可接受。
2. 或参考调度器侧 `OutputStore` 的 tail 模型：维护增量 tail 字符串（有上限），运行中读 tail，结束后 flush 全量。

**建议补一个测试**：启动一个 `sleep 1; echo x` 之类的任务，在运行中断言 `getOutput` 非空。现有 `exec-task-manager-memory.test.ts` 可以扩展。

### P0-2. localForward 的 socket/stream 没有 error 监听 → 可直接崩掉 daemon

`port-forwarding.ts:70-100`：`createServer` 回调里对 `socket` 和 ssh2 `stream` 只挂了 `close` 监听，**没有任何 `error` 监听**。Node 对没有 error 监听的 `net.Socket` / EventEmitter 抛出 `error` 事件时会变成 **uncaught exception**——本地客户端一个 ECONNRESET（转发使用中很常见）就能让整个 daemon 进程退出。

**修复**：

```ts
socket.on("error", (err) => { log("fwd", `[${id}] socket error: ${err.message}`); try { stream.close() } catch {} })
stream.on("error", (err) => { log("fwd", `[${id}] stream error: ${err.message}`); socket.destroy() })
```

`remoteForward` 里的 `localSocket` 已有 error 处理（`:169`），但其 `stream` 同样裸奔，需要补。

### P0-3. remoteForward 的 `tcp connection` 监听器：泄漏 + 多转发互相拒绝对方的连接

`port-forwarding.ts:155-181`：每次 `remoteForward` 都往同一个 ssh2 `client` 上 `client.on("tcp connection", ...)`，有两个问题：

1. **`stop()` 不移除监听器**（`:202` 只调 `unforwardIn`）。反复建/停 remote forward 会无限累积监听器，且停掉的 forward 的监听器还会继续参与下面这个问题。
2. **多个 remote forward 并存时互相破坏**：`tcp connection` 是 client 级事件，每个进来的连接会触发**所有**监听器。匹配的那个调 `accept()`，**其余每个都对同一个连接调 `rejectConn()`**——对同一 channel 同时 accept 和 reject 是协议违规，行为未定义。只要同时开两个 remote forward，功能就是坏的。

**修复**：改为**单一分发器**——manager 持有一个 `tcp connection` 监听器，内部按 `(dstIP, dstPort) → forward` 的 Map 路由，找不到才 `rejectConn()`；`stop()` 从 Map 删除条目，`stopAll()`/manager 销毁时移除监听器。

---

## P1 — 中等收益 / 健壮性

### P1-1. 连接建立后 hop client 失去状态同步（静默 destroy + stale session）

`connection.ts:97-106 / 142-151`：`connectDirect`/`connectThrough` 在 connect 阶段挂的 `error` 监听器在 ready 后**继续存活**，后续任何错误（网络断开、keepalive 超限）会触发它执行 `client.destroy()` + `reject()`（对已 settle 的 promise 是 no-op）。同时：

- 没有任何 post-connect 的 `error`/`close` 监听去更新 `this.connected` 或向 `SSHSessionManager` 发事件
- 只有最终 hop 的 shell `close` 会发 `disconnected` 事件（`:181-187`）；**中间 hop 断掉时无人知晓**
- 结果：session-manager 里的会话仍显示 connected，下一次 exec 才会以意义不明的错误失败

**修复**：connect 成功后切换监听策略——移除 connect 阶段的一次性 handler（用 `once` + 显式 remove），换上长期 handler：`error`/`close` 时置 `connected = false`、emit `disconnected`/`error` 事件，让 session-manager 同步状态并清理 `sessionsByProfile`。

### P1-2. IPC parser 大帧场景 O(n²) 字符串拷贝

`ipc-protocol.ts:119-146`：`remainder` 是字符串，每个 chunk 都执行 `this.remainder + chunk.toString()` 再 `split("\n")`。对跨多个 chunk 的大帧（如 10MB 任务输出走 `getTaskOutput full`），每收一个 64KB chunk 就把已累积的全部内容重拷一遍——10MB 帧 ≈ 160 次重拷、~800MB 累计拷贝量，全在 daemon 事件循环上。

**修复**：remainder 改为 `Buffer[]` 数组，每个 chunk 先在**新 chunk 内**找 `\n`（`buf.indexOf(10)`）：没有换行符就只 push 不拷贝；有才 `Buffer.concat` 取出完整帧。`maxRemainderBytes` 检查用累计字节数计数器，不需要先拼接。

### P1-3. ExecTaskManager：10MB 输出内嵌 task JSON + list 热路径全量读盘（上轮 P1-2 遗留）

仍未解决，且本轮发现 cleanup 策略放大了它：

- `list()` 每次对磁盘**每个** task 文件 `readFileSync + JSON.parse`（文件含完整 stdout/stderr，最大 ~10MB），而 list 只需要元数据
- `maybeCleanup()`（`:94-101`）每次 list 先 `countDiskTasks()` 一次 readdir；`CLEANUP_THRESHOLD = 20`——**磁盘上只要有 >20 个未过期任务文件，每次 list 都会触发 `cleanupOldTasks()` 再全量读盘一遍**（清理只删 >24h 的，删不掉就一直触发）。即 list 一次 = 全部任务文件读两遍。
- `cleanupOldTasks` 里 `statSync` 的结果没有使用（`:147`），纯浪费。

**修复**：输出与元数据分文件存（对齐调度器 `OutputStore` 模型），list 只读元数据；cleanup 改为「距上次清理超过间隔」单一条件（去掉 threshold 触发），或对 readdir 结果做短 TTL 缓存。

### P1-4. exec-task 持久化节流是全局的，多任务互相抑制

`exec-task-manager.ts:82, 164-170`：`lastPersistAt` 是**实例级**单变量。任务 A 的一次落盘会让 1 秒内任务 B 的非立即持久化全部跳过——并发任务越多，单个任务的磁盘快照越陈旧。修 P0-1 时顺手把节流改为 per-task（挂在 `RunningTaskEntry` 上）即可。

### P1-5. ssh-config 的 Include 无环检测 → 栈溢出

`ssh-config.ts:58-67`：`Include` 指令递归调用 `parseContent`，**没有 visited 集合**（ProxyJump 解析有，`:143-146`，Include 没有）。`a.conf include b.conf`、`b.conf include a.conf` 即可让 CLI/daemon 栈溢出。属于「用户配置可触发的 DoS」。

**修复**：给 `parseContent` 传 `visited: Set<string>`（resolve 后的绝对路径），重复即跳过。顺带支持 Include 的 glob 语义（openssh 行为）可一并考虑，但环检测先行。

### P1-6. daemon handleConnect：缓存命中仍读盘 + 双重 JSON.parse

`daemon.ts:549-563, 580`：

- mtime 缓存命中时仍然 `readFileSync(configPath)`（`:557`）——缓存只省了 hash 计算，没省同步读盘，而读盘才是事件循环上的大头
- 缓存未命中时 `normalizeConfig`（内部 `JSON.parse` + `JSON.stringify`）之后 `:580` 又 `JSON.parse(configContent)` 一遍

**修复**：缓存条目里直接存 `configContent`（或解析后的 config 对象）；`normalizeConfig` 改为接受已解析对象。配置文件通常 <2KB，整体收益不大，但这是每次 `connect` 请求的必经路径，改动也只有几行。

### P1-7. pumpQueue O(queued × running) 且重复排序（上轮 P1-4 遗留）

`scheduler-service.ts:629-641` 未变：每个排队任务调 `findBlockers`（遍历 running + 扫 lockManager），随后 `recomputeQueuePositions` 再排序一次。在 `finishTask`/`cancelTask` 各触发一次。队列上限 50、并发上限 4 的默认配置下绝对量可控，优先级低于上面几项，但若放宽并发上限要先做：对 running 集合按 cost 维护增量计数，避免每个 queued 任务重扫。

### P1-8. exec-task PID 捕获的 `firstLine` 无界累积

`exec-task-manager.ts:299-324`：stdout 路径在捕获 PID 前把数据累进 `firstLine` 字符串，直到出现第一个 `\n`。若命令输出无换行的大块数据（二进制、超长单行日志），`firstLine` 无限增长且**不受 10MB trim 约束**。另注意：PID 实际是 echo 到 **stderr** 的（`:287` 的 `>&2`），stdout 侧的 firstLine-as-PID 解析基本不会命中，属于历史遗留逻辑。

**修复**：给 firstLine 设上限（如 4KB，超限即视为无 PID、转入正常缓冲），同时可以直接删掉 stdout 侧的 PID 解析（PID 只会出现在 stderr）。

---

## P2 — 低收益 / 打磨项

- **file-transfer 的 `sftp.end()` 靠手工逐路径配对**（`file-transfer.ts:381/391/443/448/536/580/627/637`）。当前各路径检查下来基本配平，但模式脆弱——新增分支漏一个就泄漏 SFTP channel。建议统一为 `try { ... } finally { sftp.end() }`。新增的 `file-transfer-multi-hop.test.ts` 是好的回归兜底。
- **`appendTail` 用 UTF-16 码元当字节数**（`output-store.ts:64-68`）：`.length`/`.slice(-LIMIT)` 会切断多字节字符，且与 `stdoutBytes` 的真实字节计数语义不一致。建议统一走 `Buffer`。
- **`backgroundTaskHandles`**（`daemon.ts:42, 218-269`）：① daemon `stop()` 不调用各 handle 的 `stop()` 也不清 Map；② `close` 和 `error` 可能先后触发导致 `onClose` 被调两次（加 `closed` 标志位即可）；③ 若 stream 永不触发 close/error 则条目永存（可挂超时兜底）。
- **`removeFromFinishedIndex` 用 `indexOf` 线性扫描**（`scheduler-service.ts:765-771`，注释已自认）。当前批量驱逐场景可接受。
- **`getHostIdentifier` 反射 ssh2 私有字段** `_client._config.host`（`exec-task-manager.ts:71-77`）。ssh2 升级易碎，建议建连时显式传入 host。
- **daemon-client `_connect` 与外部 `disconnect` 的窗口竞态**（`daemon-client.ts:42-68`）：connect 等待期间若外部调 `disconnect()`，socket 被 destroy 但 `connect` 事件 promise 永不 resolve → 挂起。给 `_connect` 加「socket 已被换掉则 reject」的防御即可。低概率（CLI 短生命周期）。
- **静默吞错三处**：daemon socket `error` 空处理（`daemon.ts:423-425`）、IPC malformed line 静默跳过（`ipc-protocol.ts:141-143`）、各处 `.catch(() => {})` 的 disconnect。至少在 debug 日志里记一笔，否则线上问题无从排查。
- **mcp-server 工具体大多没有 try/catch**：经核实 **不会**导致 server 崩溃——MCP SDK 会捕获 handler 异常并返回 `isError: true`。但错误文案是裸 `Error.message`，不走 `mcp-response.ts` 的结构化 envelope，agent 拿到的错误缺少可操作信息。可加一个统一的 `wrapTool(handler)` 包装器。
- **logger 每行 `appendFileSync`**（`logger.ts:73`）：仅 debug 模式生效（`:64` 有 gate），常态零开销。若 debug 下做高频流式输出排查会放大延迟，可顺手套用 EventLog 的缓冲模式，优先级很低。
- **profile-manager 同步 IO + pretty-print**（`profile-manager.ts:46-97`）：低频路径，可接受；若未来在请求路径上反复 `load()` 再优化。

---

## 架构层面：两套并行的任务管理子系统（维持上轮结论，优先级上调）

| | 子系统 A | 子系统 B |
|---|---|---|
| 入口 | `ExecTaskManager` + `BackgroundExecManager` | `SchedulerService` |
| 落盘目录 | `~/.ssh-tool/exec-tasks/` | `~/.ssh-tool/scheduler/` |
| 输出存储 | task JSON 内嵌 stdout/stderr | 独立 `OutputStore`（tail + 全量文件） |
| 清理/TTL | `cleanupOldTasks` + threshold 触发 | `OutputStore.cleanup` + 空闲驱逐定时器 |
| PID 捕获 / cancel 竞态 | 各实现一份 | 各实现一份 |

本轮的 P0-1（运行中输出为空）正是「修了 B 忘了 A 的对称问题、又在 A 上引入新回归」的实例——这类双轨债的成本已经从「理论上的双倍维护」变成了「实际发生的回归」。建议把 **background-exec 切到调度器的 `OutputStore` + 持久化**提上日程：P0-1 的修复方案 2 本身就是收敛的第一步，可以合并规划。改动面大，仍建议独立立项、独立测试。

---

## 建议的落地顺序

1. **P0-1**（运行中输出回归）+ **P0-2**（forward error 监听）——一个是功能坏了，一个是 daemon 会崩，先修。各配回归测试。
2. **P0-3**（tcp connection 分发器重构）——remote forward 多开即坏，且监听器泄漏。
3. **P1-1**（连接状态同步）+ **P1-5**（Include 环检测）——健壮性，改动局部。
4. **P1-2**（IPC parser Buffer 化）+ **P1-3 / P1-4**（ExecTaskManager 输出分离与节流）——后者与架构收敛方向一致，可一起做。
5. **P1-6 / P1-7 / P1-8** 与 P2 项穿插在日常迭代里消化。
6. 架构收敛（两套任务系统合一）——独立立项。

每一项配微基准或回归测试（扩展现有 `performance.test.ts` / `stress-test.test.ts` / `exec-task-manager-memory.test.ts`），避免「优化了但没测出来」或再次引入 P0-1 式回归。

---

## 附：上一轮问题状态 & 本轮已排除的疑似问题

**上一轮（2026-06-12）问题状态**：

| 项 | 状态 |
|---|---|
| P0-1 BatchedPersistenceStore 未接入 | ✅ 已修（daemon.ts:148） |
| P0-2 热路径 pretty-print JSON | ✅ 已修（profile-manager 保留，低频） |
| P0-3 getFinishedTasks 全量扫描 | ✅ 已修（有序索引反向扫描） |
| P1-1 list() O(n²) | ✅ 已修（Map 合并）；全量读盘部分并入本轮 P1-3 |
| P1-2 10MB 输出内嵌 JSON | ❌ 未修 → 本轮 P1-3 |
| P1-3 EventLog 同步逐条写 | ✅ 已修（200ms 缓冲 + 失败重缓冲） |
| P1-4 pumpQueue O(q×r) | ❌ 未修 → 本轮 P1-7 |
| P2 OutputStore 空文件 | ✅ 已修（惰性创建） |
| P2 appendTail UTF-16 / indexOf / 私有字段反射 | ❌ 未修 → 本轮 P2 |

**本轮审查过并排除的疑似问题**（避免后续重复排查）：

- `handleFatal` 不 flush 调度器持久化 —— 误报：`handleFatal` 调 `this.stop()`，其中 `scheduler.dispose()` 会 `flushSync`（daemon.ts:349, 379）。
- `sweepIdle` 漏调 `cleanupSession` —— 误报：已调用（daemon.ts:997）。
- MCP 工具异常导致 server 崩溃 —— 误报：SDK 兜底转 `isError` 响应（降级为 P2 的错误文案结构化问题）。
- exec-task 的 cwd/env 经 `JSON.stringify` 注入 —— 安全：JSON 双引号转义在 POSIX shell 下无法逃逸。
- `maxRemainderBytes` 防护、`IPCSocket.dispose`、virtual-cwd 防抖、daemon 单例/信号处理、锁 TTL —— 检查无问题。
