# SSH Daemon 稳定性与资源边界设计

> 状态：待用户审阅
>
> 本文针对高并发、大输出、远端超时和失败连接累积问题，定义首批兼容优先的修复范围。TOFU 主机指纹、目录传输流式化和 OutputStore 重构属于后续独立项目，不在本文实施范围内。

## 1. 决策摘要

首批采用 daemon 内部的资源闸门、普通 exec 的 PID/超时清理、full output 的 IPC 安全降级，以及 session 连接去重和失败清理。

外部连接和调用体验保持不变：用户仍然可以只提供跳转机 ID、用户名和密码建立连接；普通 `ssh_exec` 仍然是同步请求并返回 stdout、stderr 和退出码；只有超过明确资源边界时才快速返回可重试错误。

## 2. 背景与问题

当前代码已经修复了 scheduler 普通执行路径中的 `exec cd` 问题，但仍有几类长驻 daemon 风险：

- IPC 每解析一条请求就启动一个异步处理，没有单 socket 或全局 in-flight 上限。
- 内部 `execRemote()` 探针没有复用 PID 捕获和远端进程清理能力，超时只关闭本地 channel；普通 `ssh_exec` 已委托给 `ExecTaskManager`，必须作为回归路径验证而非重复改造。
- 普通 exec 的 stdout/stderr 各自最多保留 10 MiB；达到上限后仍继续接收远端输出。
- background task 的 full output 可能达到输出文件上限，而 IPC parser 的未完成帧上限为 16 MiB。
- 同一连接配置在 `connecting` 状态时不能被后续请求复用，连接失败后的 session 仍可能残留。

这些问题在单用户低并发时不明显，但在多个 MCP/CLI 客户端、大日志、长命令和网络异常同时出现时会叠加，造成内存峰值、远端残留进程、重复 SSH 连接和 daemon 响应失败。

## 3. 用户目标和兼容约束

### 3.1 用户目标

1. 保持现有最短连接路径：跳转机 ID + 用户名 + 密码即可连接。
2. 保持普通同步 `ssh_exec` 的调用方式和成功返回结构。
3. 大输出不再把 IPC 连接推入超限状态。
4. 超时后尽力停止远端命令，减少孤儿进程。
5. 相同配置的并发连接只建立一条底层 SSH 链路。
6. 连接失败后可以立即重试，不被旧错误 session 阻塞。

### 3.2 非目标

- 不在本批次启用或实现 TOFU/known_hosts/host key verifier。
- 不要求现有 profile 增加 fingerprint 字段。
- 不把普通 `ssh_exec` 改成后台 task 提交和轮询模型。
- 不修改用户名、密码、私钥、跳转机 ID 和多跳配置的现有输入格式。
- 不重写目录 tar/untar、SFTP streaming 或 OutputStore 落盘算法。
- 不改变 SchedulerService 已有的后台任务队列语义。
- 不新增大输出分块公共 API；只保留后续扩展点。

## 4. 现状边界

### 4.1 现有模块

| 模块 | 当前责任 | 本批次责任 |
| --- | --- | --- |
| `src/daemon.ts` | IPC server、连接、普通 exec、传输、后台任务 | 增加 IPC 请求闸门，统一限制普通 exec/传输/full output 响应 |
| `src/remote-shell.ts` | 不注册 scheduler task 的即时 exec | 使用 PID wrapper，执行超时清理和输出上限动作 |
| `src/session-manager.ts` | session map、profile map、连接生命周期 | pending connect 去重，失败回收两个索引 |
| `src/ipc-protocol.ts` | newline JSON framing 和 16 MiB remainder 上限 | 保持 framing 合约，必要时复用安全 payload 判断，不扩大帧上限 |
| `src/scheduler/scheduler-service.ts` | 后台任务队列和输出查询 | 首批不改调度算法，只由 daemon 限制输出返回 |
| `src/scheduler/output-store.ts` | 输出 tail 和文件保存 | 首批不改写入机制 |

### 4.2 公开契约

当前 IPC 响应为：

```ts
export type IPCResponse =
  | { id: string; ok: true; data: unknown }
  | { id: string; ok: false; error: string }
```

首批不删除或重命名字段。过载错误仍使用 `ok: false` 和 string error，若现有客户端能够兼容，则在错误文本中携带稳定前缀；新增诊断字段只作为成功结果中的可选字段，不能要求旧客户端读取。

## 5. 目标架构

```text
CLI / MCP client
        |
        v
Unix socket / named pipe
        |
        v
SSHDaemon.handleConnection
        |
        +-- socket in-flight guard
        |
        +-- request lane guard
        |     +-- light: ping/list/status/tail
        |     +-- exec: immediate remote exec
        |     +-- transfer: upload/download
        |     +-- wait: waitTask
        |
        +-- handleExec -> remoteExec
        |                  +-- PID wrapper
        |                  +-- output cap
        |                  +-- TERM/KILL best effort
        |
        +-- handleGetTaskOutput
        |                  +-- tail/full size probe
        |                  +-- IPC-safe fallback
        |
        +-- gateway.sessions.connect
                           +-- connected session reuse
                           +-- pending connection reuse
                           +-- failure cleanup
```

### 5.1 责任原则

- `daemon.ts` 负责请求级别的并发和响应边界，不把资源控制散落在 CLI/MCP 调用方。
- `remote-shell.ts` 负责单次远程 exec 的生命周期，不依赖 daemon 才能正确处理 timeout。
- `session-manager.ts` 负责 session 及其索引的一致性，不让上层扫描 error session 作为主要清理机制。
- `ipc-protocol.ts` 保持传输协议上限，不通过扩大 16 MiB 上限解决应用层大响应问题。

## 6. 资源闸门设计

### 6.1 配置

在 `SSHDaemon` 内增加可选构造参数，不改变现有调用者：

```ts
interface DaemonResourceLimits {
  maxInflightPerSocket: number
  maxInflightExec: number
  maxInflightTransfers: number
  maxInflightWaits: number
}
```

默认值：

```ts
const DEFAULT_DAEMON_RESOURCE_LIMITS: DaemonResourceLimits = {
  maxInflightPerSocket: 16,
  maxInflightExec: 4,
  maxInflightTransfers: 2,
  maxInflightWaits: 32,
}
```

构造函数使用：

```ts
constructor(opts?: {
  pipePath?: string
  idleTimeoutMs?: number
  scheduler?: SchedulerService
  resourceLimits?: Partial<DaemonResourceLimits>
})
```

默认值必须足够支持普通单用户使用。配置只影响 daemon 内部，不增加 IPC 请求字段。

### 6.2 请求分类

```ts
type RequestLane = "light" | "exec" | "transfer" | "wait"
```

分类规则：

- `exec`：`exec`。
- `transfer`：`transfer`。
- `wait`：`waitTask`。
- `light`：connect、disconnect、ping、list、status、queueStatus、getTaskOutput、getCwd、setCwd、schedule、cancel、dequeue、cleanup、bgExec、portForward、shutdown。

`connect` 本身受已有 session quota 和 pending connect 去重保护，不再新增独立连接闸门，避免破坏现有连接可用性。

### 6.3 快速拒绝

超过任意一个上限时，不排入新的 daemon 私有无限队列，直接返回：

```text
RESOURCE_LIMIT_EXCEEDED: too many concurrent <lane> requests; retry shortly
```

如果后续允许扩展 `IPCResponse`，可使用：

```ts
interface ResourceLimitError {
  code: "RESOURCE_LIMIT_EXCEEDED"
  lane: RequestLane
  retryAfterMs: number
}
```

但首批优先保持现有 string error 合约。

### 6.4 计数释放

每个请求进入闸门后必须在 `finally` 中释放计数：

```text
acquire
try:
  await handleRequest
finally:
  release
```

socket close 不直接重复扣减全局计数。已经开始的请求继续执行，但响应写入前检查 socket 是否仍打开；关闭的 socket 不再写响应。

## 7. 普通 exec 生命周期

### 7.1 命令包装

`remoteExec()` 使用和 `execScheduledStream()` 一致的包装：

```text
echo "SSH_TOOL_PID:$$" >&2; exec sh -c '<shell-quoted-command>'
```

PID marker 只从 stderr 控制前缀中移除，不把普通 stderr 内容误删。

### 7.2 超时

配置了 timeout 时，计时器覆盖整个 exec 生命周期，包括 `client.exec()` 回调尚未返回的情况。

已经获得 PID：

```text
kill -TERM <pid>
sleep 0.1
kill -KILL <pid>
```

然后关闭当前 channel，返回：

```ts
{
  code: 124,
  signal: "TERM",
  stdout: "<already captured output>",
  stderr: "<already captured output>"
}
```

未获得 PID：关闭 channel，返回同样的 code 124，并可新增：

```ts
remoteProcessMayContinue: true
```

kill 是 best effort；kill channel 的 exec 不得因为回调错误再次覆盖原 timeout 结果。

### 7.3 输出上限

保留现有默认 stdout/stderr 各 10 MiB，避免无理由改变用户可见输出量。但流达到各自上限时：

1. 设置对应的 truncated 标志。
2. 停止向对应数组追加内容。
3. 关闭 channel。
4. 如果已知 PID，发送 TERM/KILL。
5. 返回已经收集的内容和 truncated 字段。

新增字段保持可选：

```ts
stdoutTruncated?: boolean
stderrTruncated?: boolean
```

## 8. Full output IPC 安全降级

`FULL_IPC_SAFE_LIMIT` 保持 8 MiB，不扩大 IPC parser 的 16 MiB 上限。

所有从 daemon 返回 full output 的入口统一执行：

```text
1. 先读取 tail metadata，得到 stdoutBytes + stderrBytes
2. totalBytes <= 8 MiB：按现有路径返回 full
3. totalBytes > 8 MiB：只返回有界 tail、字节数和 output 文件路径
```

大输出响应：

```ts
{
  stdout: "<bounded tail>",
  stderr: "<bounded tail>",
  stdoutBytes: number,
  stderrBytes: number,
  stdoutPath: string,
  stderrPath: string,
  outputFiles: { stdout: string; stderr: string },
  truncated: true,
  fullTruncated: true,
  fullOutputUnavailableOverIpc: true
}
```

成功的小输出不改变；大输出从“可能发送失败”变为“成功返回受控预览”。

## 9. Session 连接生命周期

### 9.1 pending connect

按 `configHash` 保存 pending Promise：

```ts
private pendingConnects = new Map<string, Promise<SSHSession>>()
```

流程：

```text
1. 计算 configHash
2. reuseSession=false：跳过复用，保持现有语义
3. 已有 connected session：直接返回
4. 已有 pending connect：等待同一个 Promise
5. 否则创建连接并放入 pendingConnects
6. finally 删除 pendingConnects
```

`reuseSession=false` 必须保持“请求新建独立连接”的行为。

### 9.2 失败清理

连接失败时：

```text
1. 保存原始错误
2. 尽力 disconnect/destroy 已建立的 hop
3. 删除 sessions[id]
4. 仅当 profile index 指向该 id 时删除 sessionsByProfile[configHash]
5. 删除 pendingConnects[configHash]
6. 重新抛出原始错误
```

现有测试中依赖保留 error session 的断言需要改为验证资源清理和可重试性。诊断通过日志保留，而不是无限保留 session 对象。

### 9.3 disconnectAll

成功或失败后都清理：

```ts
this.sessions.clear()
this.sessionsByProfile.clear()
this.pendingConnects.clear()
```

## 10. 错误处理和用户可见行为

| 场景 | 用户可见结果 |
| --- | --- |
| 并发超过限制 | `ok:false`，错误以 `RESOURCE_LIMIT_EXCEEDED` 开头，提示稍后重试 |
| 普通 exec timeout 且 PID 已捕获 | `ok:true` 结果 code 124，signal TERM |
| 普通 exec timeout 且 PID 未捕获 | code 124，附可选 `remoteProcessMayContinue` |
| stdout 超限 | `ok:true`，已有内容 + `stdoutTruncated:true` |
| stderr 超限 | `ok:true`，已有内容 + `stderrTruncated:true` |
| background full output 超过 IPC 安全值 | `ok:true`，tail + path + fullTruncated |
| 连接失败 | 原始错误返回；内部 session 清理；下一次可直接重试 |
| socket 在请求完成前关闭 | 不写响应；资源在请求 finally 中释放 |

不把内部堆栈、密码、私钥或完整命令参数写入新的错误信息。

## 11. 测试设计

### 11.1 `remote-shell.test.ts`

新增测试：

- 普通 exec 的远程命令包含 `exec sh -c` 和 PID marker。
- timeout 前未回调 exec 时返回 code 124。
- PID marker 到达后 timeout 会发起 kill exec。
- stdout 超过 `maxBufferBytes` 时返回 `stdoutTruncated` 并关闭 stream。
- stderr 超过 `maxBufferBytes` 时返回 `stderrTruncated` 并关闭 stream。
- kill exec 的失败回调不会覆盖 timeout 结果。

### 11.2 `session-manager.test.ts`

新增或替换测试：

- 同一 configHash 的两个并发 connect 只创建一次底层连接。
- `reuseSession=false` 仍然建立独立连接。
- 连接失败后 `sessionCount`、profile index 和 pending map 不残留。
- 清理后再次 connect 仍会正常尝试。
- `disconnectAll()` 清空两个索引。

现有“失败连接保留 error session”的断言必须移除或改为检查日志/错误返回，不再把错误 session 作为长期诊断 API。

### 11.3 `daemon-ipc.test.ts` / `daemon-client-race.test.ts`

新增测试：

- 同一 socket 超过 `maxInflightPerSocket` 时请求快速返回资源限制错误。
- exec lane 超限不阻塞 ping/list 等 light 请求。
- transfer lane 超限不建立额外 transfer。
- 请求成功、失败、超时三条路径都释放计数。
- socket close 后不会写响应，且后续请求计数不被污染。

### 11.4 `daemon-background-handle.test.ts` / `ipc-socket.test.ts`

新增测试：

- full output 总大小低于 8 MiB 时返回完整内容。
- full output 总大小高于 8 MiB 时返回 tail、path 和 `fullTruncated`，不调用 full 文件读取。
- 受控响应经过 `encodeMessage()` 后低于 IPC 16 MiB remainder 限制。

### 11.5 回归命令

```bash
export PATH=/Users/wanghaizhi/.nvm/versions/node/v22.22.3/bin:/bin:/usr/bin:$PATH
npm run build
npm run test:fast
npm run test:ssh
```

在当前 TRAE 沙箱中，若 `integration.test.js` 写入 scheduler 目录触发 EPERM，应单独记录为环境限制；不得因此改变生产路径或降低安全上限。

## 12. 验收标准

- 旧 profile、旧 IPC 请求和用户名密码连接路径无需迁移即可继续使用。
- `npm run build` 通过。
- `npm run test:fast` 全部通过。
- SSH 相关测试通过。
- 普通 exec 的 timeout、输出上限和 PID wrapper 均有失败前测试。
- 同一 profile 并发连接只建立一次底层连接。
- 连接失败后 session 和 profile index 无残留。
- 大 full output 不再尝试创建超过 IPC 安全限制的响应。
- 资源限制错误可被旧客户端识别为普通 `ok:false` 错误。
- 任何新增可选字段不影响旧客户端读取成功响应。

## 13. 风险、回滚与开关

| 风险 | 缓解 | 回滚 |
| --- | --- | --- |
| 默认并发阈值过低 | 默认值 16/4/2/32，覆盖正常单用户操作；先通过测试压测 | 调大 `resourceLimits` 或暂时不注入闸门 |
| timeout kill 影响特殊远端命令 | 只 kill 当前 wrapper PID，kill 失败不覆盖结果 | 保留 close-only 内部降级选项 |
| 大输出旧调用方依赖完整内容 | 小于 8 MiB 完全不变；大于阈值返回 path 和 tail | 调整安全阈值，后续新增分块读取 |
| pending Promise 卡死 | 连接 timeout 和 `finally` 删除 pending | 禁用 connecting 复用 |
| socket close 造成计数错误 | 统一在请求 finally 释放，close 只标记 closed | 回退到无 socket 计数实现 |

## 14. 后续独立项目

1. **TOFU host key**（参考 OpenSSH `StrictHostKeyChecking=accept-new`）：默认关闭，必须无感升级——新 profile 也不默认启用，仅由用户显式开启；老用户行为完全不变。启用后语义：首次遇到新主机自动接受并记录指纹，后续指纹变化时拒绝连接（**不覆盖已有条目**，仅在变化时提示）；多跳每一跳独立记录。实现时必须证明：未显式开启时连接路径与当前完全一致。
2. **远程路径安全**：MCP 写文件使用 canonical parent path，拒绝符号链接绕过 blockedPaths。
3. **文件传输优化**：异步/流式 tar，direct 路径绝对内存上限，pipeline 内计算 hash。
4. **OutputStore 优化**：ring buffer/chunk deque、WriteStream、批量 snapshot 和按字节轮转。
5. **端口转发生命周期**：跟踪 active socket，stop 超时后主动销毁连接。
