# 远端 SSH Tool 协调服务设计

> 状态：已完成设计，待用户审阅
>
> 本文定义一个部署在共享 Linux 虚拟机上的单机协调服务，用于让来自不同地点的 SSH Tool / AI 实例共享工作状态，并在可能发生工作区冲突时提供可靠提示。第一版不强制锁定资源、不代执行远端命令，也不反向连接本地客户端。

## 1. 决策摘要

为解决多个 AI 同时连接同一台虚拟机、在相同工作区执行写操作导致的误撞问题，新增一个整机单实例的远端协调服务：`ssh-tool-coordinator`。

服务通过仅本机可见的 Unix socket 提供控制面能力。本地 SSH Tool 不直接访问其数据库，而是通过既有 SSH 通道执行远端轻量 helper。SSH Tool 仍负责实际连接和命令执行；协调服务只记录客户端、任务意图、心跳与短期租约，并返回同工作区的活跃任务摘要。

第一版采用软协调：发现冲突时，SSH Tool 把结构化 warning 返回给 AI，AI 必须向用户确认后再执行高风险写操作。服务不可用、部署失败或版本不兼容时，不阻断既有 SSH exec/transfer 能力，只携带降级警告。

## 2. 背景与目标

当前 SSH Tool 的 daemon 通过本地 Unix socket 协调同一台开发机上的 MCP/CLI 请求，管理 SSH 连接复用、后台任务和本地调度。但不同地点的同事各自运行 SSH Tool 时，没有共享控制面；每个工具只能看到自己的 session、scheduler 与运行任务。

在共享虚拟机上，这会造成：

- 不同 AI 同时改写同一仓库、同一个配置或同一服务。
- 一方构建、重启服务、清理文件或占用端口时，另一方无法获知。
- 仅靠群聊或口头约定，AI 没有可自动读取的机器状态；断线和忘记更新状态也无法可靠处理。

### 2.1 用户目标

1. 多个地点的 SSH Tool 连接同一台虚拟机时，能发现彼此正在进行的高风险任务。
2. 同工作区存在活跃任务时，AI 获得明确、可操作的冲突提示，并向用户确认是否继续。
3. 服务自动安装和升级，使用体验接近 VS Code Server，但不引入新的远程网络端口。
4. 服务不影响现有 SSH Tool 的连接、exec、传输、后台任务、端口转发和本地 daemon 行为。
5. 独立 Linux 账号可获得可信的操作系统身份；共享 root 账号仍可参与协作，但必须明确其身份只属于自报标签，不能用于安全归因。

### 2.2 非目标

第一版不包含：

- 强制工作区锁、排队或默认拒绝写操作。
- 远端服务反向连接、调度或控制各地的 SSH Tool 进程。
- 远端服务代执行 shell 命令、保存 SSH 凭据、接管交互 shell。
- Web UI、HTTP/HTTPS API、公网端口或跨机器集群。
- 跨主机资源池调度、负载均衡、GPU/端口/服务名的强制资源锁。
- 为共享 root 提供不可伪造的人类身份或安全隔离。

## 3. 总体架构

```text
本地 AI / MCP
    |
    v
本地 SSH Tool
    |  connect 后探测 coordinator
    |  必要时上传并原子安装/升级
    |  SSH exec 远端 coordinator-client
    v
远端 coordinator-client
    |
    v
/run/ssh-tool-coordinator/coordinator.sock
    |
    v
ssh-tool-coordinator（systemd，整机单实例）
    |
    +-- 客户端实例登记
    +-- 任务租约、心跳和过期
    +-- 工作区冲突检测
    +-- 操作与部署审计
    +-- SQLite 状态存储
```

### 3.1 责任划分

| 模块 | 责任 | 明确不负责 |
| --- | --- | --- |
| 本地 `SSHDaemon` / `SchedulerService` | 本地请求并发、SSH session 复用、实际命令和后台任务生命周期 | 跨地点客户端状态存储、可信远端用户归因 |
| `RemoteCoordinatorClient` | 通过 SSH 调用远端 helper，探测版本、注册/续租/完成任务，将协调信息附到现有结果 | 直接访问 SQLite、保存凭据、打开新网络连接 |
| `coordinator-client` | 将行分隔 JSON 请求转发到 Unix socket 并输出响应 | 执行用户命令、修改协调状态文件 |
| `ssh-tool-coordinator` | 验证协议和 socket 调用者，管理租约、冲突、审计和 SQLite | 代执行 shell、反向控制本地 SSH Tool |
| installer | 校验版本化发布产物、串行化部署、原子切换、健康检查和回滚 | 运行远程在线安装脚本或扩大主机网络暴露 |

### 3.2 为什么不让远端服务直接调度本地 SSH Tool 对象

各地的 SSH Tool 通常位于 NAT 或防火墙后，远端服务无法可靠回连。将连接对象交给远端服务还需要建立长期双向连接、身份认证、离线投递、重试、版本协商和权限系统。

第一版采用更稳健的模型：各 SSH Tool 主动将任务意图报告给同一远端控制面，仍由它们各自执行命令。未来若需要集中派发，可在同一协议上增加“远端任务队列 + 本地客户端主动拉取”，而不是让远端服务回连客户端。

## 4. 访问、部署与文件系统布局

### 4.1 Unix socket 访问

协调服务仅监听 Unix socket，不监听 TCP 端口：

```text
/run/ssh-tool-coordinator/coordinator.sock
```

- systemd service 使用专用低权限系统账户 `ssh-tool-coordinator` 运行，禁止以 root 常驻运行。
- socket owner 为 `ssh-tool-coordinator`，group 为 `ssh-tool-coordinator`，权限为 `0660`。
- 允许使用服务的独立 Linux 账号加入 `ssh-tool-coordinator` 组。
- 服务使用 `SO_PEERCRED` 取得本地 socket 对端的 UID；客户端传入的身份字段不能覆盖此身份。
- 共享 root 可访问 socket，但 root 本身可绕过服务、修改系统状态或伪造工具标签；这属于主机既有信任边界，协调器不能将其误报为安全隔离。

### 4.2 目录布局

```text
/opt/ssh-tool-coordinator/
  releases/<version>/
  current -> releases/<version>/
  data/state.db
  audit/

/run/ssh-tool-coordinator/
  coordinator.sock
  install.lock
```

- `releases/<version>` 是不可变的版本目录。
- `current` 只在候选版本健康检查成功后原子更新。
- `state.db` 仅服务账户可读写；远端 helper 和 SSH 用户没有直接数据库访问权限。
- 审计日志由服务写入，必须进行权限限制与轮转。

### 4.3 支持范围

第一版只支持满足下列条件的 Linux 主机：

- systemd 可用。
- 架构和操作系统存在随 SSH Tool 发布的 coordinator 产物。
- 当前 SSH 用户具备写入安装路径、创建/管理 service 和 socket 的部署权限。

不支持 systemd、架构不支持或权限不足时，SSH Tool 返回明确诊断并降级继续执行；不得尝试 `sudo`、修改 SSH 配置、打开防火墙端口或自动改变用户组。

## 5. 协议和状态模型

### 5.1 传输协议

`coordinator-client` 与服务使用行分隔 JSON；请求和响应均为单行 UTF-8 JSON。服务拒绝未知 action、超长字段和无效类型。协议版本使用显式主版本，主版本不兼容时返回稳定错误码。

```ts
type CoordinatorRequest =
  | { action: "health"; protocolVersion: 1 }
  | { action: "registerClient"; protocolVersion: 1; client: ClientIdentity }
  | { action: "beginTask"; protocolVersion: 1; task: TaskIntent }
  | { action: "heartbeat"; protocolVersion: 1; taskId: string; leaseToken: string }
  | {
      action: "finishTask"
      protocolVersion: 1
      taskId: string
      leaseToken: string
      outcome: "success" | "failed" | "cancelled"
    }
  | { action: "listActive"; protocolVersion: 1; workspace?: string }

type ClientIdentity = {
  clientId: string
  installationId: string
  operatorLabel: string
  sshUser: string
  toolVersion: string
}

type TaskIntent = {
  clientId: string
  workspace: string
  kind: "read" | "write" | "build" | "service" | "transfer"
  summary: string
  pid?: number
  ttlMs: number
}
```

### 5.2 身份模型

`clientId` 是某台开发机上 SSH Tool 首次安装时生成并持久保存的随机 UUID；`installationId` 用于区分本地安装实例。两者属于协作标识，不是远端授权凭据。

审计记录始终保存：

- Unix socket 的 `peerUid` 和由其解析出的 Linux 用户名。
- `clientId`、`installationId`、`operatorLabel` 和 `toolVersion`。
- 工作区、任务种类、受限长度的摘要、时间、完成结果和 coordinator 版本。

独立 Linux 账号下，以 `peerUid` 为可信身份。共享 root 下，记录 `identityTrust: "self-asserted"`，展示给用户时必须标注该限制。任何客户端自报的 `sshUser` 或 `operatorLabel` 都不能被视为安全归因。

完整命令、环境变量、令牌、密码、私钥及其路径不得写入状态库或审计日志。`summary` 必须限制长度且由 SSH Tool 进行敏感内容脱敏。

### 5.3 租约和任务生命周期

1. 本地 SSH Tool 确定远端 workspace、任务种类和摘要。
2. 对 `write`、`build`、`service`、`transfer` 类型，执行前调用 `beginTask`。
3. 服务规范化 workspace 后，查询重叠 workspace 的未过期任务，并同时创建当前任务，签发不可预测的 `leaseToken`。
4. 长任务每 30 秒调用一次 `heartbeat`；默认 `ttlMs` 为 2 分钟，服务可限制最小与最大 TTL。
5. 成功、失败、取消、超时、后台任务结束或 daemon dispose 时，SSH Tool 调用 `finishTask`。
6. 客户端断线、进程崩溃或 SSH channel 中断时不依赖显式清理；租约自然到期。
7. 仅持有匹配 `leaseToken` 的客户端能更新或完成租约，防止其他客户端误结束活跃任务。

服务重启后可保留数据库中的未过期租约；启动时立即清除已过期记录。所有时间比较使用服务端时钟。

### 5.4 工作区冲突判定

服务将 workspace 解析为规范化绝对路径，并仅在路径边界上判断重叠：

- `/srv/app` 与 `/srv/app/api` 重叠。
- `/srv/app` 与 `/srv/application` 不重叠。
- 相同 workspace 必然重叠。

服务不解析 shell 命令来推断资源范围。调用方必须提供 workspace；无法确定 workspace 时，SSH Tool 以远端会话的当前目录作为保守默认值，并在结果中标记 workspace 来源。

`read` 任务不触发冲突确认。`write`、`build`、`service`、`transfer` 与其他活跃任务在工作区重叠时生成冲突摘要。第一版允许所有任务登记，不做服务端拒绝。

## 6. 冲突反馈与本地集成

### 6.1 SSH Tool 行为

本地 SSH Tool 在现有连接成功后异步执行 coordinator 探测；探测或安装失败不能让连接失败。

对高风险远端操作，SSH Tool：

1. 注册任务并取得 lease。
2. 从 `beginTask` 响应解析 workspace 冲突。
3. 将协调状态作为可选元数据附在现有 MCP/CLI 成功结果或预执行结果中。
4. 若存在冲突，AI 必须向用户报告冲突摘要并询问是否继续。
5. 用户确认后使用 `force` 继续；force 只影响本地工具的确认流程，仍会写入 coordinator 审计。
6. 实际任务完成、取消、超时或 daemon 释放资源时完成租约。

现有 SSH exec、传输、后台任务和端口转发的主结果结构不得移除或改名。可新增：

```ts
interface CoordinationMetadata {
  available: boolean
  coordinationUnavailable?: boolean
  warning?: string
  taskId?: string
  workspace?: string
  conflicts?: Array<{
    taskId: string
    workspace: string
    kind: "write" | "build" | "service" | "transfer"
    operatorLabel: string
    startedAt: number
    expiresAt: number
    identityTrust: "peer-uid" | "self-asserted"
  }>
}
```

### 6.2 降级

下列情况均不阻断既有 SSH 行为：

- coordinator 缺失。
- 自动部署失败。
- Unix socket 不可达。
- coordinator 健康检查失败。
- 协议主版本不兼容。
- 当前 SSH 用户没有部署或 socket 访问权限。

SSH Tool 仅添加 `coordinationUnavailable: true` 和不含敏感信息的 warning。降级原因写入本地调试日志和远端服务审计（若服务可用），但不泄露主机凭据或命令正文。

## 7. 自动安装与升级

### 7.1 发布与校验

安装产物必须随 SSH Tool 发布，或从固定且经验证的发布源获取；不得在远端执行 `curl | sh` 或依赖未校验的网络下载。

每个支持的平台产物具有版本化 manifest，至少包含：

- 版本号和协议兼容范围。
- OS、CPU 架构和产物文件名。
- SHA-256。
- Ed25519 签名。

本地 SSH Tool 在上传前和远端部署前均验证 manifest/产物校验值。签名或哈希校验失败时，终止升级并使用已有健康版本；不存在健康版本时降级协调功能，不影响 SSH 功能。

### 7.2 原子流程

1. SSH Tool 调用 `health`，读取当前服务版本与协议版本。
2. 服务缺失、协议不兼容或低于最低兼容版本时，选择匹配远端 `uname -s/-m` 的产物。
3. 使用 `/run/ssh-tool-coordinator/install.lock` 获取部署锁。未获得锁的客户端等待后重新健康检查，不重复部署。
4. 上传到私有临时目录，验证 SHA-256 和 Ed25519 签名。
5. 解压到新的 `releases/<version>`；不修改当前 release。
6. 通过 systemd 启动候选版本，执行 Unix socket `health` 检查，验证协议、schema migration 和数据库可访问性。
7. 健康检查通过后原子更新 `current` 软链接并重启/重载主 service。
8. 失败时保留旧 release、旧 `current` 和旧 socket，记录失败审计。候选目录可留待诊断或按策略清理。

任何时刻只能有一个部署过程修改 release 指针。自动部署不执行 sudo，也不擅自修改用户组、系统防火墙或 SSH 配置。

### 7.3 回滚

- 新版本启动或健康检查失败：`current` 保持旧版本，服务继续运行旧版本。
- 数据库迁移必须先做兼容性检查；破坏性 migration 不允许自动执行。
- 协议主版本升级必须在已有客户端仍可降级的前提下发布；不支持的旧客户端只接收协调不可用警告，SSH 基础功能保持可用。

## 8. 数据与审计

SQLite 最少包含：

- `clients`：最近注册的协作客户端与最后活跃时间。
- `leases`：活跃和已完成任务、workspace、租约、peer UID、协作标签与结果。
- `audit_events`：部署、升级、health failure、begin/heartbeat/finish/force override 等不可变事件。
- `schema_migrations`：可兼容 migration 版本。

数据库写入采用事务。TTL 清理在 `beginTask`、`heartbeat`、`listActive` 以及周期性清理时执行。审计日志按大小或时间轮转，默认保留期和最大容量必须可配置，并以安全默认值限制磁盘增长。

## 9. 错误处理

| 场景 | 服务/工具行为 |
| --- | --- |
| 服务不存在 | 尝试满足条件的自动部署；失败后带协调不可用 warning 继续 SSH 操作 |
| Unix socket 无权限 | 返回明确诊断并降级；不尝试修改组或 sudo |
| 协议不兼容 | 不调用不兼容 action，返回稳定的版本错误，工具降级 |
| lease token 不匹配 | 返回 `LEASE_TOKEN_MISMATCH`，不更新任务状态 |
| lease 已过期 | 返回 `LEASE_EXPIRED`，工具可在需要时重新登记 |
| 并发安装 | 单个持锁者部署，其他客户端等待后复查 health |
| 校验失败 | 不切换版本；保留已有健康版本或降级 |
| 新 release 启动失败 | 自动回滚至旧 `current`，保留审计记录 |
| 协调服务重启 | 恢复未过期租约，清理过期租约 |
| 同工作区冲突 | 返回冲突摘要并登记当前任务；本地 AI 询问用户是否继续 |

错误文本和审计信息不得包含凭据、私钥、token、完整 shell 命令或环境变量。

## 10. 测试和验收标准

### 10.1 coordinator 单元测试

- 请求 schema、未知 action、长度限制和协议主版本检查。
- `SO_PEERCRED` 身份提取与自报身份不可覆盖。
- workspace 规范化与父子目录边界重叠判断。
- 并发 `beginTask` 的事务一致性和冲突响应。
- heartbeat、lease token 校验、TTL 自动过期和服务重启恢复。
- 审计脱敏和 retention 清理。

### 10.2 Unix socket 与权限测试

- 服务不会监听 TCP。
- 允许组成员通过 socket 调用；非组成员被拒绝。
- SQLite 和审计目录不能被普通客户端直接写入。
- 共享 root 的响应明确标记 `self-asserted` 身份可信级别。

### 10.3 部署测试

- 初次安装、已安装健康探测、兼容升级。
- 并发安装锁只允许一个部署者切换 release。
- 产物哈希或签名失败不会更新 `current`。
- 候选版本健康检查失败自动保留旧版本。
- 无 systemd、无支持产物、权限不足时返回诊断并保持 SSH 功能。

### 10.4 SSH Tool 集成测试

- coordinator 可用时，写操作登记/心跳/完成租约。
- 同 workspace 活跃任务产生可选 `coordination` 警告，原有执行结果结构不变。
- `force` override 写入审计。
- exec、transfer、后台任务取消、超时和 daemon dispose 都尽力完成或释放 lease。
- coordinator 不可用时，既有 exec、transfer 和 session 行为仍然成功，且只带降级元数据。

### 10.5 集成环境

真实 systemd 部署测试作为独立 Linux 虚拟机测试套件。现有快速单元测试不依赖 systemd，不在开发环境创建系统服务或修改系统用户组。

## 11. 风险和后续演进

| 风险 | 缓解 |
| --- | --- |
| 共享 root 无法提供可信用户身份 | 明确标记 `self-asserted`；仅将其定位为协作信息而非安全审计 |
| 自动部署扩大远端风险 | 只使用签名的版本化产物、部署锁、最小权限、原子切换和回滚 |
| coordinator 故障影响工作 | 协调功能始终可降级，不能阻断现有 SSH 功能 |
| 警告被忽略 | 第一版由 AI 询问用户；若出现真实需求，后续引入可配置强制锁 |
| 远端状态泄露任务内容 | 限制 summary、脱敏、禁止保存完整命令和密钥、严格文件权限 |

后续可在不破坏协议的情况下增加：

1. 可配置的 workspace 强制锁和显式 force 审批。
2. 端口、服务、GPU 等命名资源租约。
3. 远端任务队列与本地 SSH Tool 主动拉取。
4. 审计导出和只读状态 UI。
5. 多主机 coordinator 或集中控制面。

这些均不属于第一版实现范围。
