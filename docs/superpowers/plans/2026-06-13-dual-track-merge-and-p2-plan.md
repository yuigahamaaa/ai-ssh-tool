# 双轨任务管理合一 + P2 全量打磨 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:dispatching-parallel-agents 或 subagent-driven-development 实施本 plan。
>
> **Goal:** 把 ExecTaskManager/BackgroundExecManager/SchedulerService/OutputStore 四套并行子系统合并为单一调度服务；按 design doc 修复 10 项 P2 打磨；保持 MCP/CLI/daemon 行为零破坏。
>
> **Architecture:** ExecTaskManager 变薄壳代理，start/startBackground 委托给全局 SchedulerService；运行时 stdout/stderr 走 OutputStore；旧 `~/.ssh-tool/exec-tasks/` 启动时一次性迁移到新位置。P2 项每项最小改动 + 1-2 个回归测试。
>
> **Tech Stack:** Node 22、TypeScript 5、ssh2、@modelcontextprotocol/sdk、supertest、node:test。已有 OutputStore/SchedulerService/EventLog/BatchedPersistenceStore 全部能力可直接复用。
>
> **Spec:** `docs/superpowers/specs/2026-06-13-dual-track-merge-and-p2-design.md`

---

## 文件结构

### 新增
- `src/scheduler/migrator.ts` — 旧 exec-tasks → 新 scheduler 位置迁移器
- `src/scheduler/scheduler-host-identifier.ts` — 取代 exec-task-manager 的 getHostIdentifier 反射
- `src/mcp-wrap.ts` — wrapTool 通用包装器
- `src/__tests__/mcp-wrap.test.ts` — wrapTool 单元测试
- `src/__tests__/profile-cache.test.ts` — profile LRU 缓存测试
- `src/__tests__/daemon-background.test.ts` — backgroundTaskHandles dispose/timeout 测试
- `src/__tests__/migrator.test.ts` — 旧盘迁移测试
- `src/__tests__/p2-sanity.test.ts` — P2 各小项的串行集成测试

### 修改
- `src/daemon.ts` — `backgroundTaskHandles` 改用 scheduler handle；socket error 加日志
- `src/daemon-client.ts` — connect 期间 disconnect 竞态防御
- `src/exec-task-manager.ts` — 薄壳代理；删 getHostIdentifier；start 委托给 scheduler
- `src/background-exec.ts` — 整体删除（迁到 scheduler.startBackground）
- `src/scheduler/scheduler-service.ts` — `removeFromFinishedIndex` 二分；`dispose` 加 OutputStore dispose
- `src/scheduler/output-store.ts` — `appendTail` 改 Buffer 字节
- `src/scheduler/event-log.ts` — 暴露 `dispose()` 给 scheduler 调用
- `src/file-transfer.ts` — sftp 7 处 try/finally
- `src/mcp-server.ts` — 31 工具过 wrapTool
- `src/logger.ts` — debug 模式 debounce
- `src/profile-manager.ts` — load() LRU 缓存 + 紧凑 JSON
- `src/ipc-protocol.ts` — malformed line 加 debug 日志
- `src/connection.ts` — 透传 host 字段（不再依赖 getHostIdentifier）
- `src/cli/remote-shell.ts` — exec 调用栈透传 host
- `src/cli/daemon-commands.ts` — host 透传
- `src/__tests__/*.ts` — 已有测试保持通过

### 删除
- `src/background-exec.ts`（最后阶段删）
- `src/get-host-identifier.ts`（如存在）

---

## 实施阶段总览

| 阶段 | 范围 | 风险 | 预计测试新增 |
|---|---|---|---|
| 阶段 1 | P2 全部 10 项 | 低 | +12 |
| 阶段 2 | P1-3 迁移骨架 | 中 | +5 |
| 阶段 3 | P1-3 旧路径清理 | 高 | +2 |

每阶段结束：跑 `npm run test:fast` 全绿、commit、push。

---

# 阶段 1：P2 全部 10 项

## Task 1.1: P2-1 file-transfer sftp.end() try/finally

**Files:**
- Modify: `src/file-transfer.ts:381,391,443,448,536,580,627,637` 周边
- Test: `src/__tests__/file-transfer.test.ts`

- [ ] **Step 1: 写失败测试** — 加 `test("sftp.end() is always called on upload/download even on stream error")`：mock sftp, throw 错误，断言 end() 被调用。
- [ ] **Step 2: 跑测试确认失败** — `node --test dist/__tests__/file-transfer.test.js` 期望 1 fail
- [ ] **Step 3: 改 7 处 sftp 调用为 try/finally** — 6 个 download + 1 个 mkdirPath
- [ ] **Step 4: 跑测试确认通过** — 期望 pass
- [ ] **Step 5: 跑 test:fast 确认无回归** — `npm run test:fast` 期望全绿
- [ ] **Step 6: Commit** — `git commit -m "fix(file-transfer): P2-1 wrap sftp calls in try/finally to prevent channel leak"`

## Task 1.2: P2-2 appendTail UTF-16 → Buffer

**Files:**
- Modify: `src/scheduler/output-store.ts:60-75`
- Test: `src/__tests__/output-store-lazy.test.ts`

- [ ] **Step 1: 加测试** — `test("appendTail treats output as bytes, not UTF-16 code units")`：`appendStdout(id, "你好世界".repeat(100))` 后 `getOutput(id, "full").stdoutBytes` 应该是真实字节数（300 * 3 字节/汉字*4 汉字 = 3600 字节）
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: appendTail 改用 Buffer** — 内部维护 `Buffer` 而非 string；tail 切取用 `Buffer.subarray(-bytes)`；bytes 计数用 `Buffer.byteLength`
- [ ] **Step 4: 跑测试通过**
- [ ] **Step 5: 跑 test:fast 确认无回归**
- [ ] **Step 6: Commit** — `git commit -m "perf(output-store): P2-2 treat appendTail as bytes, not UTF-16 code units"`

## Task 1.3: P2-3 backgroundTaskHandles dispose / timeout / double-close

**Files:**
- Modify: `src/daemon.ts:42, 218-269, 997-1000`
- Test: `src/__tests__/daemon-background.test.ts`

- [ ] **Step 1: 加测试 3 个** — ① daemon.stop() 调各 handle.stop() ② close 后 error 不再触发 onClose ③ 5 分钟无 close/error 触发超时
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 修改 BackgroundTaskHandle** — 加 `closed: boolean` 标志、`timeoutId: NodeJS.Timeout`（5 分钟）、`stop()` 公开方法
- [ ] **Step 4: 修改 daemon.stop()** — 遍历 handles，clearTimeout + stop + 等待 finish（fire-and-forget）
- [ ] **Step 5: 跑测试通过**
- [ ] **Step 6: 跑 test:fast 确认无回归**
- [ ] **Step 7: Commit** — `git commit -m "fix(daemon): P2-3 backgroundTaskHandles dispose/timeout/double-close"`

## Task 1.4: P2-4 removeFromFinishedIndex 二分

**Files:**
- Modify: `src/scheduler/scheduler-service.ts:765-771`
- Test: `src/__tests__/scheduler-recent.test.ts`

- [ ] **Step 1: 加测试** — `test("removeFromFinishedIndex uses binary search, O(log n) lookup")`：插入 1000 个 task，删除中间一个，断言 O(log n) 找到位置
- [ ] **Step 2: 跑测试确认失败** — 当前是 indexOf O(n)
- [ ] **Step 3: 实现二分定位 + splice** — 用与 addToFinishedIndex 相同的比较器
- [ ] **Step 4: 跑测试通过**
- [ ] **Step 5: 跑 test:fast 确认无回归**
- [ ] **Step 6: Commit** — `git commit -m "perf(scheduler): P2-4 removeFromFinishedIndex uses binary search"`

## Task 1.5: P2-5 ssh2 私有字段反射去除（透传 host）

**Files:**
- Modify: `src/exec-task-manager.ts:71-77`（删 getHostIdentifier）
- Modify: `src/connection.ts`（已有 host）
- Modify: `src/cli/remote-shell.ts`、`src/cli/daemon-commands.ts`（透传）
- Test: `src/__tests__/connection-host.test.ts`（新）

- [ ] **Step 1: 加测试** — `test("start() uses explicit host parameter, not ssh2 reflection")`：mock ssh2 connection 验证传入的 host 被使用
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 删除 getHostIdentifier 反射调用** — 改用参数 host
- [ ] **Step 4: 在所有 start 入口加 host 参数**（ssh_exec、ssh_exec_background、daemon IPC start）
- [ ] **Step 5: 跑测试通过**
- [ ] **Step 6: 跑 test:fast 确认无回归**
- [ ] **Step 7: Commit** — `git commit -m "refactor: P2-5 remove ssh2 private field reflection, thread host explicitly"`

## Task 1.6: P2-6 daemon-client connect/disconnect 竞态

**Files:**
- Modify: `src/daemon-client.ts:42-68`
- Test: `src/__tests__/daemon-client.test.ts`（如不存在则新建）

- [ ] **Step 1: 加测试** — `test("disconnect() during pending connect rejects with 'disconnected' error")`：先 connect，再 disconnect，断言 connect promise reject
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 加 socket 引用失效检查** — disconnect 时若 pendingConnect 存在，reject 它
- [ ] **Step 4: 跑测试通过**
- [ ] **Step 5: 跑 test:fast 确认无回归**
- [ ] **Step 6: Commit** — `git commit -m "fix(daemon-client): P2-6 reject pending connect if disconnect called during handshake"`

## Task 1.7: P2-7 静默吞错加 debug 日志

**Files:**
- Modify: `src/daemon.ts:423-425`
- Modify: `src/ipc-protocol.ts:141-143`（malformed line）
- Modify: 各处 `.catch(() => {})` 的 disconnect（grep）
- Test: `src/__tests__/p2-sanity.test.ts`（新）

- [ ] **Step 1: 加测试** — 3 个测试分别验证 3 处错误在 debug 日志中被记录
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 三处全部加 log**（用 `log("module", "...")` 工具）
- [ ] **Step 4: 跑测试通过**
- [ ] **Step 5: 跑 test:fast 确认无回归**
- [ ] **Step 6: Commit** — `git commit -m "fix: P2-7 surface swallowed errors via debug log"`

## Task 1.8: P2-8 mcp-server wrapTool 包装

**Files:**
- Create: `src/mcp-wrap.ts`
- Modify: `src/mcp-server.ts`（31 个 server.tool 调用）
- Test: `src/__tests__/mcp-wrap.test.ts`

- [ ] **Step 1: 加测试** — `test("wrapTool returns isError true on handler throw")`：传入抛错的 handler，调用返回结构化错误
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现 wrapTool** — `wrapTool(name, handler)`：try/catch → `{ isError: true, content: [{ type: "text", text: structuredErrorJSON(name, err) }] }`
- [ ] **Step 4: mcp-server.ts 31 个工具逐一过 wrapTool** — 用 sed/Edit 批量替换
- [ ] **Step 5: 跑测试通过**
- [ ] **Step 6: 跑 test:fast 确认无回归**
- [ ] **Step 7: Commit** — `git commit -m "feat(mcp): P2-8 wrap all tool handlers with structured error envelope"`

## Task 1.9: P2-9 logger debounce

**Files:**
- Modify: `src/logger.ts:73`
- Test: `src/__tests__/logger-debounce.test.ts`

- [ ] **Step 1: 加测试** — `test("debug-mode log batches writes to disk every 100ms")`：1000 次 log，调 flushSync，磁盘只 1 行
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: debug 模式改 debounce** — `if (debugEnabled) { ... debounced ... }` else { appendFileSync 直写 }
- [ ] **Step 4: 跑测试通过**
- [ ] **Step 5: 跑 test:fast 确认无回归**
- [ ] **Step 6: Commit** — `git commit -m "perf(logger): P2-9 debounce debug-mode writes"`

## Task 1.10: P2-10 profile-manager IO 优化

**Files:**
- Modify: `src/profile-manager.ts:46-97`
- Test: `src/__tests__/profile-cache.test.ts`

- [ ] **Step 1: 加测试** — `test("profile load() caches parsed result, second call hits cache")`：load 同一文件两次，第二次无 fs 访问
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 加 LRU 缓存** — Map + mtime 检测；save() 失效缓存
- [ ] **Step 4: 跑测试通过**
- [ ] **Step 5: 跑 test:fast 确认无回归**
- [ ] **Step 6: Commit** — `git commit -m "perf(profile-manager): P2-10 add LRU cache for load()"`

### 阶段 1 完成：
- [ ] 跑 `npm run test:fast` 期望 318+ 用例全绿
- [ ] Commit（如果还有未 commit 改动）
- [ ] Push: `git push origin main`

---

# 阶段 2：P1-3 迁移骨架

## Task 2.1: ExecTaskManager 委托给 SchedulerService（写路径）

**Files:**
- Modify: `src/exec-task-manager.ts`（start/startBackground 全部委托）
- Test: `src/__tests__/exec-task-manager.test.ts`（如存在）

- [ ] **Step 1: 加测试** — `test("ExecTaskManager.start() delegates to SchedulerService")`：mock scheduler.startBackground，验证 ExecTaskManager.start 委托
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: ExecTaskManager.start 委托给 scheduler.start** — 内部 `this.scheduler = opts?.scheduler ?? getGlobalScheduler()`
- [ ] **Step 4: 跑测试通过**
- [ ] **Step 5: 跑 test:fast 确认无回归**
- [ ] **Step 6: Commit**

## Task 2.2: 写 migrator.ts（旧位置 → 新位置）

**Files:**
- Create: `src/scheduler/migrator.ts`
- Test: `src/__tests__/migrator.test.ts`

- [ ] **Step 1: 加测试** — 3 个测试：① 旧位置有 task.json 时迁移到新位置 + 写入 outputs；② 旧位置已迁移（mtime 标记）跳过；③ 迁移失败保留旧位置
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现 migrator** — `migrateExecTasks(srcDir, destTaskDir, destOutputDir)`
- [ ] **Step 4: 跑测试通过**
- [ ] **Step 5: 跑 test:fast 确认无回归**
- [ ] **Step 6: Commit**

## Task 2.3: ExecTaskManager.getTask/getOutput/list 委托给 scheduler

**Files:**
- Modify: `src/exec-task-manager.ts`
- Test: `src/__tests__/exec-task-manager.test.ts`

- [ ] **Step 1: 加测试** — 3 个测试：① getTask 委托；② getOutput 委托给 OutputStore；③ list 委托 + 旧盘迁移缓存合并
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 改读路径** — 内部读 scheduler.tasks
- [ ] **Step 4: 跑测试通过**
- [ ] **Step 5: 跑 test:fast 确认无回归**
- [ ] **Step 6: Commit**

## Task 2.4: daemon 启动时跑 migrator

**Files:**
- Modify: `src/daemon.ts`（启动序列）
- Test: `src/__tests__/daemon-migration.test.ts`（如不存在则新建）

- [ ] **Step 1: 加测试** — 启动 daemon 时 migrator 被调用
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 在 daemon 启动钩子中加 migrator**
- [ ] **Step 4: 跑测试通过**
- [ ] **Step 5: 跑 test:fast 确认无回归**
- [ ] **Step 6: Commit**

## Task 2.5: SchedulerService 接受外部传入的 ExecTaskManager 引用

**Files:**
- Modify: `src/scheduler/scheduler-service.ts`
- Test: `src/__tests__/scheduler-bridge.test.ts`（新）

- [ ] **Step 1: 加测试** — scheduler 在 task 创建时通过回调通知 ExecTaskManager
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: SchedulerService 接受 opts.onTaskCreated / onTaskUpdated**
- [ ] **Step 4: 跑测试通过**
- [ ] **Step 5: 跑 test:fast 确认无回归**
- [ ] **Step 6: Commit**

### 阶段 2 完成：
- [ ] 跑 `npm run test:fast` 期望 330+ 用例全绿
- [ ] Commit + Push

---

# 阶段 3：P1-3 旧路径清理

## Task 3.1: 删 BackgroundExecManager

**Files:**
- Delete: `src/background-exec.ts`
- Modify: 所有 import 它的文件（grep）

- [ ] **Step 1: grep 列出所有使用点**
- [ ] **Step 2: 替换为 scheduler.startBackground 直接调用**
- [ ] **Step 3: 删文件**
- [ ] **Step 4: 跑 test:fast 确认无回归**
- [ ] **Step 5: Commit**

## Task 3.2: daemon backgroundTaskHandles 改用 scheduler handle

**Files:**
- Modify: `src/daemon.ts`

- [ ] **Step 1: 加测试** — daemon 通过 scheduler 取消后台任务
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 改用 scheduler.getBackgroundHandle**
- [ ] **Step 4: 跑测试通过**
- [ ] **Step 5: 跑 test:fast 确认无回归**
- [ ] **Step 6: Commit**

## Task 3.3: 删 ExecTaskManager.start 的旧路径（如有残留）

**Files:**
- Modify: `src/exec-task-manager.ts`

- [ ] **Step 1: 跑 test:fast** — 期望全绿
- [ ] **Step 2: 删 start 方法中的 fallback 旧路径代码**
- [ ] **Step 3: 跑 test:fast** — 期望全绿
- [ ] **Step 4: Commit**

### 阶段 3 完成：
- [ ] 跑 `npm run test:fast` 期望 330+ 用例全绿
- [ ] 跑 `npm run test:all` 兜底
- [ ] Commit + Push
- [ ] 关闭 GitHub PR（如果之前开的）

---

# Self-Review

- **Spec 覆盖**：spec 中 11 大项全部映射到上述 Task。
- **占位符扫描**：无 TBD/TODO/类似 to do。每步都有具体测试 + 期望输出。
- **类型一致**：所有 `wrapTool(name, handler)` / `migrator(srcDir, destTaskDir, destOutputDir)` / `SchedulerService(opts.onTaskCreated, opts.onTaskUpdated)` 签名贯穿全 plan。
- **范围**：3 个阶段，每阶段独立可测可提交；不至于一次 PR 太大。
