# 传输 / OutputStore / 端口转发重构设计

> 日期：2026-08-06
> 状态：设计已确认（方案 A：兼容内部重构 + 内部一致纪律）

## 1. 目标

在不改变任何对外契约的前提下，重构三个内部子系统，消除各自的可靠性短板：

1. **目录传输**：从同步 `execSync` + 临时 tar 文件改为异步、可超时、可清理的流水线。
2. **OutputStore**：把热路径的同步逐 chunk `appendFileSync` 改为合并 flush 的异步写入。
3. **端口转发**：把 stop / 断线 / 连接失败的生命周期统一为幂等状态机，补齐连接计数与活跃连接 drain。

用户明确选择 **方案 A（完全兼容的内部重构）**：不新增跨域抽象层（否决方案 B 的三域统一 `ResourceHandle`），但吸收 B 的纪律——各域内部采用一致的 scope 清理、幂等、超时模式。

## 2. 兼容性承诺（不可变契约）

| 层 | 表面 | 承诺 |
| --- | --- | --- |
| L1 外部可见 | `ssh_upload` / `ssh_download` 参数与 envelope；CLI flag 与输出 | 不变 |
| L2 IPC 内部 | daemon transfer 请求/响应；`TaskOutputResult` 查询结构 | 不变 |
| L3 内部函数 | `upload/download/uploadFile/downloadFile/uploadFolder/downloadFolder` 签名；`OutputStore` 公开方法；`PortForwardManager` 公开方法 | 签名与返回结构不变 |

具体不可变项：

- `TransferResult` 字段（success/path/finalPath/action/overwriteStrategy/checksum/verification 等）不变
- tar.gz 归档格式、`skipSymlinks` / `followSymlinks` / overwrite 策略 / checksum / onProgress 语义不变
- `OutputStore.appendStdout/appendStderr` **签名保持同步 `void`**（scheduler 的 onOutput 回调是同步的）
- `OutputEntry`、`TaskOutputResult`、磁盘文件命名（`<id>.stdout` / `<id>.stderr`）、cleanup 策略不变
- `PortForward`、`localForward/remoteForward/stop/list/get/stopAll` 签名与返回结构不变

## 3. 批次划分

三个独立提交，按风险从低到高推进：

1. `refactor: make folder transfers cancellable and asynchronous`
2. `refactor: stream scheduler output writes asynchronously`
3. `refactor: make port forwarding lifecycle idempotent`

每批 TDD：先写失败测试 → 最小实现 → 回归 → 单独 commit → push 前用户确认。

---

## 4. 批次一：目录传输异步化

### 4.1 现状问题

- `uploadFolder` / `downloadFolder` 用 `execSync("tar -czf ...")` 同步阻塞事件循环，`maxBuffer: 10MB` 限制且超时后无进程树清理
- 临时文件（本地 `tmpdir/ssh-*.tar.gz`、远程 `/tmp/ssh-*.tar.gz`）清理分散在 `finally` 中，成功/失败/超时路径不统一
- 失败时本地 tar 子进程可能残留，远程归档也可能残留
- 归档解压无路径逃逸校验：恶意/损坏归档可通过 `../` 成员覆盖目标目录外文件

### 4.2 设计

**本地归档（上传）**：`execSync` → `spawn("tar", args)` 异步执行。

- 通过 `tar` 子进程 stdout/stderr 消费输出，避免 `maxBuffer` 截断
- 统一 `timeout` 语义：超时即 kill 子进程（`SIGTERM` → 兜底 `SIGKILL`），返回失败结果并清理
- `tar` 子进程错误（非零退出码）映射为失败 `TransferResult`

**远程解压（上传）/远程归档（下载）**：继续使用 `remoteExec`，但阶段边界检查返回码与超时结果，失败即进入清理。

**TransferScope（极薄内部 scope，仅限传输域）**：

```ts
interface TransferScope {
  localTempFiles: string[]      // 本地临时归档路径
  remoteTempPaths: string[]     // 远程临时归档路径
  childProcs: Set<ChildProcess> // 本地 tar/解压子进程
  streams: Set<{ destroy: () => void }> // 打开的 SFTP/stream
}
```

- `uploadFolder` / `downloadFolder` 各自创建 scope，`try/finally` 统一 cleanup：
  - kill 未结束的子进程
  - 删除本地临时文件
  - `remoteExec rm -f` 删除远程临时文件（best-effort，`.catch(() => {})`）
  - 关闭打开的 stream
- cleanup 幂等：重复调用无害

**归档路径逃逸校验（新增安全护栏）**：

- 解压前校验归档成员：拒绝包含 `../`、绝对路径、或经规范化后逃出目标目录的成员
- 实现：`tar -tzf <archive>` 列成员 → 逐条 `path.posix.normalize` 校验 → 非法即失败并清理，不解压
- 只读校验（不解包内容），开销可接受（tar 列表快于解压）

**保持不变的调用链**：`upload()`/`download()` 的 file/folder 分发逻辑不变。

### 4.3 测试

- 失败测试：同步 `execSync` 阻塞/无清理（通过 mock spawn 断言 spawn 被调用且错误路径触发清理）
- `uploadFolder` 超时 → tar 子进程被 kill、本地临时文件删除、远程临时文件 rm 被调用
- `uploadFolder` tar 失败 → 返回 `action:"failed"` 的 TransferResult，清理执行
- 归档含 `../` 成员 → 解压前拒绝，不解压
- 既有 `file-transfer.test.ts` / `file-transfer-smart.test.ts` 全部回归通过（外部行为不变）

---

## 5. 批次二：OutputStore 异步写入

### 5.1 现状问题

- `appendStdout/appendStderr` 每次 data 事件同步 `appendFileSync` 写盘，高频输出时阻塞事件循环
- 内存态与磁盘写入强耦合在同一个调用中

### 5.2 设计

借鉴项目已有的 `BatchedPersistenceStore`（100ms 静默窗口合并写盘）模式：

**写路径（appendStdout/appendStderr，保持同步 void）**：

1. 立即同步更新内存态：`stdoutTail`（有界 64KiB）、`stdoutBytes` 逻辑计数、truncated 标志
2. 数据推入该 task 的合并写队列
3. flush 触发条件：
   - 队列静默 100ms（合并窗口）
   - 累计超过 `maxOutputFileSize`（50MiB）——写入截断部分后停写文件
   - 任务结束（`finalize`/`remove` 前）强制 flush
   - daemon 关闭时强制 flush

**文件截断语义**：保持 `maxOutputFileSize` 上限——超过后不再写盘、标记 `stdoutFileTruncated`；内存 tail 继续保留（不影响实时查询）。

**错误处理**：写入错误不抛给调用方（保持同步 void 契约），记日志并标记 entry；单 task 输出写坏不影响其他 task 与调度器整体。

**读路径（getOutput）**：tail/full 均优先内存态；full 读磁盘文件前先 flush 该 task 队列，保证一致性。

**新增内部状态**：

```ts
interface PendingWrites {
  stdoutQueue: string[] | null   // null = 已超过上限停止写盘
  stderrQueue: string[] | null
  flushTimer: NodeJS.Timeout | null
}
// OutputStore 内：private pending = new Map<string, PendingWrites>()
```

### 5.3 测试

- 失败测试：写入后磁盘文件**尚未立即**出现（合并窗口内）→ 等 100ms+ 后文件存在且内容一致
- 高频连续写入 → 只发生少量磁盘写（统计 appendFileSync 调用次数，断言远小于 chunk 数）
- 超过 `maxOutputFileSize` → 文件截断、`stdoutFileTruncated=true`、内存 tail 仍可读
- 写入错误（mock 磁盘失败）→ 不抛、不影响后续 append
- `getOutput(full)` 在未 flush 时读到完整内容（强制 flush 生效）
- 既有 `output-store.test.ts` 回归通过

---

## 6. 批次三：端口转发生命周期幂等化

### 6.1 现状问题

- `stop()` 非幂等：并发 stop 同一 id 会重复 `server.close` / `unforwardIn`；断线后对未 listening 的 server 调 `close` 报错
- 连接计数不对称：connect 失败 / stream 错误路径有丢计数与 socket 残留风险
- 断线（client close）时只停 server / unforwardIn，已建立的活跃 socket 连接不清理

### 6.2 设计

**统一 entry 状态机**：

```
active → stopping → stopped / error
```

- `stop()` 开头即置 `stopping` 并登记；重复/并发 stop 直接返回当前状态（幂等）
- 失败路径置 `error`；正常停止置 `stopped`

**stop() 幂等化**：

- local：置状态 → `server.close`；若 server 未 listening 或 close 报错，降级 `server.closeAllConnections()`（Node 18+）兜底
- remote：`unforwardIn` 保持 try/catch guard；删除 route 后 `unbindTcpConnection()`
- 用 `stoppingIds: Set<string>` 或 entry 状态位防并发重复关闭

**连接计数对称化**：connect 失败、stream 错误、socket close、stream close 四条路径统一成对增减，用 `try/finally` 保证 `connections--` 不丢。

**断线 drain**：`handleClientDisconnect` 除标记 error + stopAll 外，遍历活动连接强制 `socket.destroy()` + `stream.close()`，释放端口与句柄。

### 6.3 测试

- 并发 `stop(id)` 两次 → 第二次幂等返回，`server.close` / `unforwardIn` 各只调一次
- 断线后 `stop(id)` → 不抛错，状态 error
- connect 失败路径 → `connections` 不残留、socket 被销毁
- 断线 → 所有活跃 socket 被 destroy（计数归零）
- 既有 `port-forwarding.test.ts` 回归通过

---

## 7. 验证与验收

每批完成后：

```bash
export PATH=/Users/wanghaizhi/.nvm/versions/node/v22.22.3/bin:/bin:/usr/bin:$PATH
npm run build:test
node --test --test-force-exit <该批相关测试>
npm run test:fast   # 全量快速回归
```

- `git diff --check` 干净
- 对外契约逐项对照第 2 节清单，L1/L2/L3 均不变
- 已知环境限制：`test:ssh` 中 scheduler 目录 EPERM（TRAE Sandbox）与 e6922ec 引入的 file-transfer 既有 2 个失败已在本批前的 `68912b3` 修复；剩余 EPERM 失败不作为回归指标

## 8. 明确排除

- TOFU 主机指纹、known_hosts（独立项目）
- MCP 符号链接路径安全（已完成，commit `e79688e`）
- 跨域统一抽象层（方案 B，已否决）
- daemon IPC 资源闸门、full output 降级、session 清理（已完成首批稳定性）
- 异步 tar 的进度细分/断点续传（YAGNI，不引入）

## 9. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 异步 tar 失败清理不彻底 | 统一 TransferScope + 幂等 cleanup，测试覆盖失败/超时路径 |
| 合并 flush 丢失最近窗口数据 | 与现有 BatchedPersistenceStore 语义一致；任务结束/关闭强制 flush |
| stop 并发竞态 | 状态机 + stoppingIds 防重，测试覆盖并发 stop |
| 行为回归 | 每批独立 commit，既有测试全量回归，L1/L2/L3 契约对照清单 |
