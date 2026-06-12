# 双轨任务管理合一 + P2 全量打磨设计

> 日期：2026-06-13 ｜ 基线：`main` (2704f92) ｜ 范围：P1-3 架构重构 + P2 全部 10 项

## 目标

1. **彻底根除双轨债**：`ExecTaskManager` / `BackgroundExecManager` / `SchedulerService` / `OutputStore` 四套并行子系统合并为单一调度服务。
2. **清除 10 项 P2 打磨项**：每项做最小改动，每个 P2 项的修复都配 1-2 个回归测试。
3. **保持外部 API 与 CLI 命令零破坏**：MCP/CLI/daemon 的 `ssh_exec`/`ssh_exec_status`/`ssh_exec_cancel`/`ssh_list_tasks` 行为完全不变。
4. **保持磁盘布局零破坏**：`~/.ssh-tool/exec-tasks/` 与 `~/.ssh-tool/scheduler/` 旧数据可读，迁移用新位置。

## 架构变更（P1-3）

### 现状

```
                    ┌─ ExecTaskManager (直接 exec)
                    │    ~/.ssh-tool/exec-tasks/<id>.json (stdout 内嵌)
                    │    inline 字符串累积，per-task 节流
                    │
daemon ──┬─ getGlobalTaskManager() ──┤
         │                            └─ BackgroundExecManager
         │                                (运行中直连)
         │
         └─ new SchedulerService()
              ~/.ssh-tool/scheduler/{tasks,state,events,outputs}/
              OutputStore (tail+full)
              batched persistence
```

MCP/CLI ssh_exec 默认走 Scheduler；ssh_exec_background 也走 Scheduler。**唯一还在用 ExecTaskManager 的路径**：daemon handleStartStream（旧的 IPC start 流式命令）。

### 目标架构

```
                    ┌─ ExecTaskManager (薄壳代理，保留公共 API)
                    │    - 内部直接委托给 SchedulerService
                    │    - 读路径合并：scheduler.tasks ∪ 旧盘迁移缓存
                    │    - 写路径：所有新任务走 scheduler.startBackground()
                    │
daemon ──┬──────────┤
         │          └─ 写新盘 ~/.ssh-tool/scheduler/tasks/<id>.json
         │            旧盘 ~/.ssh-tool/exec-tasks/ 启动时一次性迁移
         │
         └─ new SchedulerService() (唯一任务源)
              └── TaskRunner 实际执行
```

### 关键决策

1. **ExecTaskManager 不再独立启动 runner**。所有 `start` / `startBackground` 委托给一个全局 `SchedulerService`。
2. **后台任务走 scheduler background**：`background-exec.ts` 的 `BackgroundExecManager` **整体删除**，由 `SchedulerService.startBackground` 替代。daemon `backgroundTaskHandles` 改为 `scheduler.getBackgroundHandle(taskId)`。
3. **执行存储统一**：所有任务（前台 exec + 后台 exec）使用 SchedulerService + OutputStore。exec-task 的 stdout/stderr 通过 `OutputStore` 落盘，`ExecTaskManager.getOutput` / `getStatus` 委托给 scheduler。
4. **运行时输出累积改用 OutputStore**：exec-task 运行中直接 `outputStore.appendStdout(id, buf)`，不再有 `stdoutChunks: Buffer[]` 内存累积。运行中 `getOutput` 走 OutputStore.tail；运行结束保留同样视图。
5. **list/cleanup 全量读盘问题**：`ExecTaskManager.list` 改为只读 `tasks/<id>.json`（小文件，几 KB），不再读 stdout/stderr 整段。OutputStore.cleanup 维持现状。
6. **磁盘迁移**：首次启动时把 `~/.ssh-tool/exec-tasks/*.json` 的 stdout/stderr 提取写入 `~/.ssh-tool/scheduler/outputs/<id>.{stdout,stderr}`，metadata 重写为不含 stdout/stderr 的轻量 JSON，移回原位置作"已迁移"标记。迁移期间阻塞启动 1-2 秒（用 mtime 检测已迁移）；任务 ID 不变。

### 不破坏的契约

- `getTask(id)` / `getOutput(id)` / `getStatus(id)` / `list(hostname)` / `cancel(id)` 的返回结构完全一致
- 旧 `ExecTask.status` 字段值（`running` / `completed` / `failed` / `cancelled` / `timeout`）保留
- daemon IPC 的 `start` / `cancel` / `getOutput` / `getStatus` 协议不变
- 旧 `~/.ssh-tool/exec-tasks/*.json` 文件保留只读迁移模式，**不会被删除**
- mcp-server 的工具名/入参/出参零变化

## 10 项 P2 打磨

| 项 | 文件 | 修复 | 回归测试 |
|---|---|---|---|
| P2-1 | `src/file-transfer.ts` | 7 处 sftp 调用统一 `try { … } finally { sftp.end() }` | `file-transfer.test.ts` 加泄漏监控（同时下载 5 次 sftp 句柄计数） |
| P2-2 | `src/scheduler/output-store.ts` | `appendTail` 改用 Buffer + `stdoutBytes` 真实字节数 | `output-store-lazy.test.ts` 加多字节字符用例 |
| P2-3 | `src/daemon.ts` | `backgroundTaskHandles`：① `daemon.stop()` 调各 handle `stop()` + 清 Map；② `closed` 标志位防双触发；③ 30s 超时兜底 | `daemon-background.test.ts` 验证 stop / double-close / timeout |
| P2-4 | `src/scheduler/scheduler-service.ts` | `removeFromFinishedIndex` 用 `findIndex` 二分定位后 splice（O(log n) + O(n) splice，但任务量小，绝对值可控） | `scheduler-recent.test.ts` 验证 O(log n) 找位 |
| P2-5 | `src/connection.ts` + 透传链 | exec 调用栈显式传 `host` 到 `ExecTaskManager.start`，删 `getHostIdentifier` 反射；需要从 daemon client / remote-shell 透传 `host` 字段 | 单元测试验证 host 正确性；删 `getHostIdentifier` |
| P2-6 | `src/daemon-client.ts` | `_connect` 加 `socket` 引用失效检查；若调 `disconnect()` 时 promise 未 settle，resolve/reject 一个 `Error("disconnected")` | 加一个 `disconnect during connect` 竞态测试 |
| P2-7 | 三处静默吞错 | ① `daemon.ts:423` socket error 加 `log("daemon", …)`；② `ipc-protocol.ts:141` malformed line 加 `log("ipc", …)`；③ 各处 `.catch(() => {})` 的 disconnect 改 `.catch((e) => log(...))` | 单元测试加 debug 日志断言 |
| P2-8 | `src/mcp-server.ts` | 新增 `wrapTool(handler)` 包装器：捕获异常 → 返回 `{ isError: true, content: [{ type: "text", text: <结构化错误> }] }`；所有 31 个工具过一遍包装 | 新增 `mcp-server-wrap.test.ts` 验证错误结构化 |
| P2-9 | `src/logger.ts` | debug 模式下 `appendFileSync` 走 100ms debounce 批量写；常态零开销（已有 gate） | 单元测试：debug 开启时高频 log 后只落盘 1 次 |
| P2-10 | `src/profile-manager.ts` | `load()` 解析时直接 stream 不做 string + JSON.parse（改成 `JSON.parse(fs.readFileSync(p, "utf-8"))`，等价但移除 pretty-print 步骤）；多 profile 加载加 LRU 缓存 | `profile-manager.test.ts` 加缓存命中测试 |

## 实施顺序

按"破坏性递减 + 风险递增"排序，便于逐步验证：

1. **P2 全部 10 项**（一次性 PR）— 每项配 1-2 个测试
2. **P1-3 迁移骨架**（一次性 PR）— 保留 ExecTaskManager API、委托给 scheduler、新位置写盘、迁移逻辑
3. **P1-3 旧路径清理**（一次性 PR）— 删除 `BackgroundExecManager`、daemon `backgroundTaskHandles` 改 scheduler handle、删除 `getHostIdentifier` 反射

每一阶段结束跑 `npm run test:fast`（目标 320+ 用例全绿）后提交 + 推送 + 跑 `test:all` 兜底。

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| P1-3 迁移破坏旧任务文件 | 启动时迁移，迁移失败回退"只读代理"模式（旧位置读、新位置写、磁盘双写） |
| P1-3 API 行为偏移 | 现有 17 个 fast 套件覆盖 ExecTaskManager 行为，零代码改动必须全过 |
| P2-3 5 分钟超时误杀慢任务 | 把 `timeoutAt` 暴露给 `getStatus`；agent 看到超时前可主动 `cancel+restart` |
| P2-8 错误文案结构化会触发下游解析 | 保持 `isError: true` 标志不变，只优化 `content[0].text` 内容 |
| P2-9 logger debounce 失序 | debug 日志本就无序要求；输出端追加时间戳已满足排序 |

## 不在范围

- 任何 ssh2 升级相关的工作
- 任何 MCP 协议升级
- 任何新功能（仅重构 / 优化）
- 删除 `~/.ssh-tool/exec-tasks/` 旧目录（保留为只读迁移缓冲）
