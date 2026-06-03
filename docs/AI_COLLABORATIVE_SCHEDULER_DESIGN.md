# AI Collaborative Scheduler Design

> Date: 2026-06-03
> Scope: Turn `ai-ssh-tool` from a shared SSH executor into a shared VM coordination and scheduling layer for multiple AI agents.

## 1. Background

The current project already provides SSH execution, MCP tools, daemon-based connection reuse, background execution, task visibility, and host load checks. That is a strong foundation, but it does not yet solve the core multi-agent coordination problem:

> Multiple AI sessions share one VM. They should know what the VM is doing, avoid stepping on each other, wait for blocking work when appropriate, enqueue work when appropriate, and go do other useful work while waiting.

The current design relies too much on the agent to voluntarily call `ssh_list_tasks` or `ssh_get_host_load`, interpret the result, and decide to wait. In practice, agents do not consistently do this. They run commands directly, creating contention and resource spikes.

The scheduler must therefore become part of the execution path, not just an optional observation tool.

## 2. Current Gaps

### 2.1 Visibility Is Not Scheduling

Current tools:

- `ssh_exec`
- `ssh_exec_background`
- `ssh_list_tasks`
- `ssh_get_host_load`
- `ssh_exec_status`
- `ssh_exec_cancel`

These allow an AI to observe some state, but they do not enforce or strongly guide coordination. Two agents can both observe an idle host and immediately start expensive commands.

### 2.2 Normal Exec Tasks Are Not Always Cross-Process Visible

`ExecTaskManager` persists background tasks immediately, but normal `exec` tasks are only persisted opportunistically while output arrives. A blocking command with little or no output may not be visible to other processes until it is too late.

### 2.3 Cross-Process Control Is Weak

Disk persistence allows another process to read a task JSON file, but cancellation and stream control still require the in-memory `RunningTaskEntry`. This means a separate MCP process can see a running task but usually cannot control it.

### 2.4 No Queue, Lock, Lease, Or Admission Control

There is no first-class representation of:

- A queued command
- A VM-wide lock
- A workdir lock
- A concurrency slot
- A task lease owned by an agent
- A scheduling policy
- A wait recommendation

Without these, the tool cannot make "wait or enqueue" the default behavior.

### 2.5 AI Tool UX Encourages Direct Execution

`ssh_exec` is the obvious tool name, so agents call it directly. The safer behavior should be exposed as the primary tool. Direct execution should either become scheduler-aware or be documented as an escape hatch.

## 3. Design Goals

### 3.1 Product Goals

1. Make coordinated execution the default path for AI agents.
2. Let multiple agents share a VM without accidental contention.
3. Let agents decide intelligently between run now, wait, enqueue, or do other work.
4. Make blocking work visible with enough semantic detail to be useful.
5. Support both conservative automation and explicit override.
6. Keep the mental model simple for AI tool use.

### 3.2 Engineering Goals

1. Move coordination authority into the daemon.
2. Keep one source of truth for task state and queue state.
3. Persist enough state for recovery after process restart.
4. Avoid relying on local MCP process memory for task control.
5. Add scheduling in phases without breaking existing tools.
6. Keep the data model extensible for future policies.

### 3.3 Non-Goals For V1

1. Perfect global distributed scheduling across different user accounts.
2. Kubernetes-level resource isolation.
3. Full remote process supervision after local daemon death.
4. A general-purpose workflow engine.
5. Strong security sandboxing for untrusted agents.

## 4. Core Principle

The key design change:

> Agents should submit intent to a scheduler, not directly run commands by default.

Instead of:

```json
{ "tool": "ssh_exec", "command": "npm test" }
```

The primary path should become:

```json
{
  "tool": "ssh_schedule",
  "command": "npm test",
  "cwd": "/repo",
  "intent": "test",
  "blocking": true,
  "if_busy": "queue"
}
```

The scheduler returns one of:

- `running`: command started now
- `queued`: command accepted into queue
- `wait_recommended`: agent should wait for specific active task(s)
- `rejected`: command conflicts with policy
- `needs_confirmation`: risky or destructive command needs explicit override

## 5. Target Architecture

```text
MCP Server(s)
  |
  | scheduler-aware tools
  v
DaemonClient
  |
  | IPC
  v
SSHDaemon
  |
  +-- SessionRegistry
  +-- SchedulerService
  |     +-- TaskRegistry
  |     +-- QueueManager
  |     +-- LockManager
  |     +-- PolicyEngine
  |     +-- HostLoadMonitor
  |     +-- EventLog
  |
  +-- ExecRunner
  +-- OutputStore
  +-- PersistenceStore
```

### 5.1 Daemon As Coordination Authority

The daemon should own:

- Active SSH sessions
- Active tasks
- Queued tasks
- VM locks
- Workdir locks
- Agent heartbeats
- Scheduling decisions
- Task cancellation
- Task output storage

MCP servers should become thin clients. They can still cache local connections for legacy tools during migration, but coordinated execution should go through daemon IPC.

### 5.2 Persistence As Recovery, Not Coordination

Files under `~/.ssh-tool/` should persist state, but coordination should happen in daemon memory with atomic persistence after each state transition.

Recommended layout:

```text
~/.ssh-tool/
  state/
    scheduler.json
    agents.json
    locks.json
  tasks/
    <taskId>.json
  output/
    <taskId>.stdout
    <taskId>.stderr
  events/
    scheduler-YYYY-MM-DD.jsonl
```

## 6. Data Model

### 6.1 Agent Identity

Each MCP server or CLI client should identify itself.

```ts
interface AgentIdentity {
  id: string
  name?: string
  clientType: "mcp" | "cli" | "api"
  sessionThreadId?: string
  startedAt: number
  lastSeenAt: number
  defaultProfile?: string
}
```

The MCP server can create a stable `agent_id` at startup and pass it with every scheduler request.

Why it matters:

- Show who owns a running task.
- Avoid an agent cancelling another agent's task accidentally.
- Allow fair queueing.
- Allow stale agent cleanup.

### 6.2 Host Identity

Host matching must be stable and explicit. Do not rely only on `client._client._config.host`.

```ts
interface HostIdentity {
  id: string
  profileKey: string
  targetHost: string
  targetPort: number
  targetUser: string
  chain: {
    host: string
    port: number
    username: string
  }[]
  displayName: string
}
```

`profileKey` should be generated from the ordered chain. Do not sort hops.

### 6.3 Task Intent

Agents need to tell the scheduler what kind of work they are doing.

```ts
type TaskIntent =
  | "inspect"
  | "search"
  | "read"
  | "edit"
  | "build"
  | "test"
  | "lint"
  | "install"
  | "deploy"
  | "migration"
  | "server"
  | "benchmark"
  | "cleanup"
  | "custom"
```

### 6.4 Task Cost

Cost can be estimated automatically and overridden by the agent.

```ts
type TaskCost = "tiny" | "small" | "medium" | "large" | "exclusive"
```

Suggested defaults:

| Intent | Default Cost | Notes |
|---|---:|---|
| `read`, `inspect`, `search` | `tiny` | Usually safe to run concurrently |
| `lint` | `small` | CPU moderate |
| `build` | `medium` | CPU and IO heavy |
| `test` | `medium` or `large` | Depends on command |
| `install` | `large` | Package managers often mutate shared state |
| `deploy`, `migration` | `exclusive` | Should require lock |
| `server` | `large` | Long-running, port conflicts possible |
| `benchmark` | `exclusive` | Needs stable machine load |

### 6.5 Task Request

```ts
interface ScheduleRequest {
  agent: AgentIdentity
  host: HostIdentity
  command: string
  cwd?: string
  env?: Record<string, string>
  intent?: TaskIntent
  cost?: TaskCost
  blocking?: boolean
  priority?: number
  timeoutMs?: number
  maxQueueWaitMs?: number
  ifBusy?: "run_anyway" | "wait" | "queue" | "fail"
  lockScope?: "none" | "host" | "workdir" | "custom"
  lockKey?: string
  outputMode?: "summary" | "tail" | "full"
  reason?: string
}
```

### 6.6 Task Record

```ts
type ScheduledTaskStatus =
  | "queued"
  | "admitted"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout"
  | "skipped"
  | "stale";

interface ScheduledTask {
  id: string
  agentId: string
  hostId: string
  command: string
  cwd?: string
  intent: TaskIntent
  cost: TaskCost
  status: ScheduledTaskStatus
  blocking: boolean
  priority: number
  queuePosition?: number
  queuedAt?: number
  admittedAt?: number
  startedAt?: number
  finishedAt?: number
  updatedAt: number
  pid?: number
  exitCode?: number | null
  signal?: string | null
  lockIds: string[]
  stdoutBytes: number
  stderrBytes: number
  stdoutTail?: string
  stderrTail?: string
  decisionReason?: string
}
```

### 6.7 Lock Record

```ts
type LockScope = "host" | "workdir" | "custom";

interface SchedulerLock {
  id: string
  scope: LockScope
  key: string
  hostId: string
  ownerAgentId: string
  ownerTaskId?: string
  reason?: string
  createdAt: number
  expiresAt: number
  renewedAt: number
}
```

Locks must have TTL. Agents and tasks should renew locks while active. Expired locks are released by the daemon.

## 7. Scheduling Policy

### 7.1 Decision Inputs

The policy engine should consider:

- Running scheduled tasks
- Queued tasks
- Active locks
- Host CPU load
- Memory pressure
- Process count
- Command intent
- Command cost
- Workdir
- Agent priority
- Whether task is blocking
- Whether task mutates shared state

### 7.2 Default Concurrency Slots

For each host:

```ts
interface HostConcurrencyPolicy {
  maxTotalRunning: number
  maxLargeRunning: number
  maxExclusiveRunning: number
  maxPerWorkdirMutations: number
  loadAverageSoftLimit: number
  loadAverageHardLimit: number
  memoryFreeSoftLimitMb?: number
}
```

Recommended defaults for a small VM:

```json
{
  "maxTotalRunning": 4,
  "maxLargeRunning": 1,
  "maxExclusiveRunning": 1,
  "maxPerWorkdirMutations": 1,
  "loadAverageSoftLimit": 2.0,
  "loadAverageHardLimit": 4.0
}
```

### 7.3 Admission Rules

Rules should be deterministic and explainable.

1. `tiny` read/search tasks can run unless the host is beyond hard load limit or an exclusive lock exists.
2. `small` tasks can run if total slots are available.
3. `medium` tasks can run if total slots are available and load is below soft limit.
4. `large` tasks can run only if no other large/exclusive task is running on the host.
5. `exclusive` tasks require a host lock.
6. Mutating tasks in the same `cwd` require a workdir lock.
7. Package manager commands should be treated as mutating and at least `large`.
8. Deploy/migration/benchmark commands should default to exclusive.

### 7.4 Command Classification

The scheduler should classify commands when `intent` or `cost` is omitted.

Examples:

| Pattern | Intent | Cost | Lock |
|---|---|---:|---|
| `ls`, `pwd`, `cat`, `sed -n`, `head`, `tail` | `inspect` | `tiny` | none |
| `rg`, `grep`, `find` | `search` | `tiny` or `small` | none |
| `npm test`, `pnpm test`, `pytest`, `go test`, `cargo test` | `test` | `medium` | workdir |
| `npm install`, `pnpm install`, `pip install`, `cargo build` | `install`/`build` | `large` | workdir |
| `docker compose up`, `npm run dev` | `server` | `large` | custom port/workdir |
| `kubectl apply`, `terraform apply`, `prisma migrate` | `deploy`/`migration` | `exclusive` | host |
| `rm -rf`, `dropdb`, `truncate`, `systemctl restart` | `cleanup`/`deploy` | `exclusive` | host + confirmation |

The first implementation can use a simple pattern table. Later versions can expose the classification result to the agent and allow correction.

### 7.5 Decisions

```ts
type ScheduleDecision =
  | {
      action: "run_now"
      taskId: string
      reason: string
    }
  | {
      action: "queued"
      taskId: string
      queuePosition: number
      estimatedWaitMs?: number
      blockingTasks: ScheduledTaskSummary[]
      reason: string
    }
  | {
      action: "wait_recommended"
      blockingTasks: ScheduledTaskSummary[]
      retryAfterMs: number
      reason: string
    }
  | {
      action: "rejected"
      reason: string
      suggestedAction?: string
    }
  | {
      action: "needs_confirmation"
      reason: string
      risks: string[]
      confirmationToken: string
    };
```

The response must tell the agent what to do next.

Example:

```json
{
  "action": "queued",
  "taskId": "t_9a1c2e",
  "queuePosition": 2,
  "blockingTasks": [
    {
      "id": "t_88ab01",
      "agentName": "codex-1",
      "command": "npm test",
      "cwd": "/repo",
      "intent": "test",
      "startedAt": 1780477220000,
      "durationMs": 84000,
      "stdoutTail": "running integration tests..."
    }
  ],
  "reason": "A large test task is already running in /repo. Your command was queued to avoid CPU and workdir contention.",
  "recommendedNextStep": "Continue with file inspection or planning. Poll ssh_queue_status or ssh_wait_task later."
}
```

## 8. MCP Tool Design

### 8.1 New Primary Tools

#### `ssh_schedule`

Submit a command to the scheduler. This becomes the default tool for AI command execution.

Parameters:

```ts
{
  command: string
  cwd?: string
  intent?: TaskIntent
  cost?: TaskCost
  blocking?: boolean
  priority?: number
  timeout?: number
  if_busy?: "run_anyway" | "wait" | "queue" | "fail"
  lock_scope?: "none" | "host" | "workdir" | "custom"
  lock_key?: string
  profile_name?: string
  profile_file?: string
  profile_json?: string
  reason?: string
}
```

Default behavior:

- `if_busy = "queue"` for medium/large/exclusive tasks.
- `if_busy = "run_anyway"` for tiny inspect tasks.
- `blocking = true` for build/test/install/deploy/migration/server.

#### `ssh_wait_task`

Wait for a task to finish or until timeout.

Parameters:

```ts
{
  task_id: string
  timeout?: number
  return_output?: "tail" | "full" | "summary"
}
```

#### `ssh_queue_status`

Show running tasks, queued tasks, locks, and host load.

Parameters:

```ts
{
  profile_name?: string
  profile_file?: string
  include_completed?: boolean
  limit?: number
}
```

#### `ssh_dequeue_task`

Remove a queued task before it starts.

Parameters:

```ts
{
  task_id: string
}
```

#### `ssh_acquire_lock`

Explicitly acquire a host/workdir/custom lock.

Parameters:

```ts
{
  scope: "host" | "workdir" | "custom"
  key?: string
  ttl_ms?: number
  reason?: string
  profile_name?: string
}
```

#### `ssh_release_lock`

Release an explicit lock.

Parameters:

```ts
{
  lock_id: string
}
```

#### `ssh_recent_activity`

Return recent VM activity in agent-friendly form.

Parameters:

```ts
{
  since_ms?: number
  profile_name?: string
  include_output_tail?: boolean
}
```

### 8.2 Existing Tool Changes

#### `ssh_exec`

Change `ssh_exec` to call the scheduler by default.

Add parameter:

```ts
{
  scheduler?: "auto" | "bypass"
}
```

Default:

```ts
scheduler = "auto"
```

This is important because agents will keep calling `ssh_exec`. If `ssh_exec` remains a bypass path, the coordination problem persists.

#### `ssh_exec_background`

Make this scheduler-aware too. It should create a scheduled task with `blocking=true` and `if_busy="queue"` unless the agent opts out.

#### `ssh_list_tasks`

Keep it for compatibility, but make `ssh_queue_status` the richer replacement.

#### `ssh_get_host_load`

Keep it, but include scheduler state:

- Running scheduled tasks
- Queue depth
- Active locks
- Suggested mode: `free`, `busy`, `exclusive_locked`, `overloaded`

## 9. Agent Guidance In Tool Descriptions

Tool descriptions should explicitly guide AI behavior. MCP descriptions matter.

Example for `ssh_schedule`:

> Schedule a remote command through the shared VM scheduler. Use this instead of direct execution for tests, builds, installs, servers, deploys, migrations, or any command that may consume CPU, mutate files, hold ports, or run longer than a few seconds. If the VM is busy, this tool may queue the command and tell you what useful work to do while waiting.

Example for `ssh_exec`:

> Execute a remote command. By default this still uses the scheduler. Use `scheduler="bypass"` only for urgent, tiny inspection commands or when explicitly instructed by the user.

This makes the desired behavior visible to the model at tool-selection time.

## 10. Daemon IPC Changes

Add IPC actions:

```ts
type SchedulerIPCRequest =
  | { id: string; action: "agentHello"; params: AgentIdentity }
  | { id: string; action: "agentHeartbeat"; params: { agentId: string } }
  | { id: string; action: "schedule"; params: ScheduleRequest }
  | { id: string; action: "waitTask"; params: { taskId: string; timeoutMs?: number } }
  | { id: string; action: "queueStatus"; params: { hostId?: string; limit?: number } }
  | { id: string; action: "cancelTask"; params: { taskId: string; mode?: "queued" | "running" | "any" } }
  | { id: string; action: "dequeueTask"; params: { taskId: string } }
  | { id: string; action: "acquireLock"; params: AcquireLockRequest }
  | { id: string; action: "releaseLock"; params: { lockId: string } }
  | { id: string; action: "recentActivity"; params: { hostId?: string; sinceMs?: number } };
```

The daemon should expose scheduler operations directly. MCP tools should not implement queueing locally.

## 11. SchedulerService Internals

### 11.1 Components

```ts
class SchedulerService {
  registerAgent(agent: AgentIdentity): void
  heartbeat(agentId: string): void
  schedule(req: ScheduleRequest): Promise<ScheduleDecision>
  waitTask(taskId: string, timeoutMs?: number): Promise<ScheduledTask>
  cancelTask(taskId: string, opts?: CancelOptions): Promise<boolean>
  dequeueTask(taskId: string): Promise<boolean>
  queueStatus(hostId?: string): SchedulerStatus
  acquireLock(req: AcquireLockRequest): Promise<SchedulerLock | ScheduleDecision>
  releaseLock(lockId: string): boolean
}
```

### 11.2 QueueManager

Responsibilities:

- Store queued tasks per host.
- Order by priority, queuedAt, and fairness.
- Re-run admission checks whenever a task finishes or a lock expires.
- Start newly admitted tasks through `ExecRunner`.

Queue ordering:

1. Higher priority first.
2. Older queued task first.
3. Avoid same agent monopolizing the queue.

### 11.3 LockManager

Responsibilities:

- Acquire/release host/workdir/custom locks.
- TTL expiration.
- Lock renewal for running tasks.
- Explain lock conflicts.

### 11.4 PolicyEngine

Responsibilities:

- Classify command if needed.
- Estimate cost.
- Detect risky commands.
- Decide run/queue/wait/reject.
- Produce human-readable and agent-readable reasons.

### 11.5 ExecRunner

Responsibilities:

- Start command on daemon-owned SSH session.
- Capture pid, stdout, stderr, exit code.
- Stream output to files.
- Update task registry.
- Release task-owned locks on finish.
- Trigger queue pump on finish.

`ExecRunner` should replace the current split between direct MCP `remoteExec` and local `ExecTaskManager` for coordinated commands.

## 12. Execution Flow

### 12.1 Run Now

```text
AI calls ssh_schedule
  -> MCP sends schedule IPC
  -> daemon resolves profile/host/session
  -> PolicyEngine classifies command
  -> LockManager checks locks
  -> QueueManager checks slots
  -> decision = run_now
  -> task status admitted/running
  -> ExecRunner starts command
  -> response returns taskId and initial status
```

For short commands, `ssh_schedule` can optionally wait until completion if:

- cost is `tiny` or `small`
- blocking is false
- expected runtime is short

But for build/test/install/server, return quickly with task id.

### 12.2 Queue

```text
AI calls ssh_schedule
  -> policy sees conflict
  -> if_busy = queue
  -> task status queued
  -> response includes queue position and blockers
  -> AI continues other work
  -> daemon starts task later
  -> AI polls or waits
```

### 12.3 Wait

```text
AI calls ssh_wait_task
  -> daemon holds IPC request until task finishes or timeout
  -> returns final task and output tail
```

### 12.4 Task Completion

```text
ExecRunner receives close event
  -> update task status
  -> persist task
  -> release task locks
  -> append event log
  -> QueueManager pump(hostId)
  -> possibly admit next queued task
```

## 13. How To Make Agents Actually Behave Better

The issue is not just technical. It is tool ergonomics.

### 13.1 Make The Safe Path The Obvious Path

Rename or introduce:

- Primary: `ssh_schedule`
- Legacy/direct: `ssh_exec` with scheduler enabled by default
- Escape hatch: `ssh_exec` with `scheduler="bypass"`

### 13.2 Return Actionable Responses

Do not only say "queued". Tell the agent what to do.

Good response:

```json
{
  "action": "queued",
  "taskId": "t123",
  "queuePosition": 1,
  "reason": "Another agent is running npm test in /repo.",
  "recommendedNextStep": "Inspect source files, review logs, or wait with ssh_wait_task after you finish independent work."
}
```

### 13.3 Classify Commands Automatically

Agents often will not set `intent`. The scheduler must classify common commands.

### 13.4 Make Conflict Reasons Visible

Agents respond better when the tool says:

- Who is blocking them
- What command is running
- Where it is running
- How long it has been running
- Whether it is likely to finish soon

### 13.5 Support "Do Other Work" Workflows

Add suggested next actions:

- "Run read-only searches."
- "Inspect files under cwd."
- "Prepare patch locally."
- "Wait for task t123."
- "Check queue status in 60 seconds."

## 14. Implementation Plan

### Phase 0: Fix Correctness Gaps

Goal: Make current task tracking trustworthy before adding queueing.

Changes:

1. Persist all tasks immediately at creation, including normal `exec`.
2. Persist final state for all tasks, not only background tasks.
3. Do not delete completed task files after 30 minutes by default; move cleanup to configurable retention.
4. Fix background detached behavior or rename it honestly until implemented.
5. Fix session hash to preserve hop order.
6. Normalize profile file format or support both flat and `auth` forms.
7. Add stable host identity to task records.

Files:

- `src/exec-task-manager.ts`
- `src/background-exec.ts`
- `src/session-manager.ts`
- `src/profile-manager.ts`
- `src/mcp-server.ts`
- `src/types.ts`

Tests:

- Normal exec with no output appears in `ssh_list_tasks`.
- Completed normal exec persists final state.
- Multi-hop hash preserves order.
- Flat profile file loads correctly or fails with clear validation.

### Phase 1: Daemon-Owned Scheduler Skeleton

Goal: Add scheduler state and IPC without replacing all execution paths.

New files:

- `src/scheduler/types.ts`
- `src/scheduler/scheduler-service.ts`
- `src/scheduler/policy-engine.ts`
- `src/scheduler/queue-manager.ts`
- `src/scheduler/lock-manager.ts`
- `src/scheduler/persistence-store.ts`
- `src/scheduler/command-classifier.ts`

Modify:

- `src/daemon.ts`
- `src/ipc-protocol.ts`
- `src/daemon-client.ts`

Add IPC:

- `schedule`
- `queueStatus`
- `waitTask`
- `cancelTask`
- `dequeueTask`

Initial behavior:

- `schedule` classifies command.
- If no conflict, starts command.
- If conflict and `if_busy=queue`, stores queued task.
- Pump queue after task completion.

Tests:

- Queue one large task behind another.
- Tiny tasks can run while large task runs.
- Exclusive task blocks all non-bypass scheduled tasks.
- Queue order is deterministic.

### Phase 2: MCP Tool Integration

Goal: Make AI agents naturally use scheduler.

Modify:

- `src/mcp-server.ts`

Add tools:

- `ssh_schedule`
- `ssh_wait_task`
- `ssh_queue_status`
- `ssh_dequeue_task`
- `ssh_recent_activity`
- `ssh_acquire_lock`
- `ssh_release_lock`

Change:

- `ssh_exec` defaults to scheduler auto mode.
- `ssh_exec_background` defaults to scheduler queue mode.
- `ssh_get_host_load` includes scheduler state.

Tests:

- MCP schedule returns `running`.
- MCP schedule returns `queued`.
- MCP wait returns final output.
- Existing `ssh_exec` still works but goes through scheduler.

### Phase 3: Locking And Policy

Goal: Avoid workdir and host-level conflicts.

Implement:

- Workdir lock for mutating medium/large commands.
- Host lock for exclusive commands.
- Lock TTL and renewal.
- Agent heartbeat and stale lock cleanup.
- Risk detection and `needs_confirmation`.

Tests:

- Two installs in same cwd do not run together.
- Tests in different cwd can run if slots allow.
- Deploy blocks read/write tasks according to policy.
- Expired lock is released.

### Phase 4: Better Output And Activity UX

Goal: Make status useful for AI reasoning.

Implement:

- Output files per task.
- Tail in task summary.
- Recent activity event log.
- Estimated wait time.
- Recommended next step.

Tests:

- Output tail is available for running task.
- Recent activity contains completed/failed tasks.
- Queue status includes blockers and lock reasons.

### Phase 5: Optional Advanced Features

Ideas:

- Per-repo scheduler policy file, e.g. `.ssh-tool-policy.json`.
- Port lock detection for dev servers.
- Learned command classification from history.
- Task dependencies: "run this after task X succeeds".
- Agent notifications via MCP resource or event stream.
- Remote-side lightweight supervisor for daemon restart recovery.

## 15. Suggested Default Policies

### 15.1 Small Shared Development VM

```json
{
  "maxTotalRunning": 4,
  "maxLargeRunning": 1,
  "maxExclusiveRunning": 1,
  "maxPerWorkdirMutations": 1,
  "loadAverageSoftLimit": 2.0,
  "loadAverageHardLimit": 4.0,
  "defaultIfBusy": {
    "tiny": "run_anyway",
    "small": "run_anyway",
    "medium": "queue",
    "large": "queue",
    "exclusive": "queue"
  }
}
```

### 15.2 Conservative Single-Repo Mode

```json
{
  "maxTotalRunning": 2,
  "maxLargeRunning": 1,
  "maxExclusiveRunning": 1,
  "maxPerWorkdirMutations": 1,
  "loadAverageSoftLimit": 1.5,
  "loadAverageHardLimit": 3.0
}
```

### 15.3 Aggressive Read-Heavy Mode

```json
{
  "maxTotalRunning": 8,
  "maxLargeRunning": 1,
  "maxExclusiveRunning": 1,
  "maxPerWorkdirMutations": 1,
  "loadAverageSoftLimit": 3.0,
  "loadAverageHardLimit": 6.0
}
```

## 16. Example Scenarios

### 16.1 Two Agents Run Tests

Agent A:

```json
{
  "command": "npm test",
  "cwd": "/repo",
  "intent": "test"
}
```

Result:

```json
{ "action": "run_now", "taskId": "t_a" }
```

Agent B:

```json
{
  "command": "npm test",
  "cwd": "/repo",
  "intent": "test"
}
```

Result:

```json
{
  "action": "queued",
  "taskId": "t_b",
  "queuePosition": 1,
  "reason": "A test task is already running in /repo."
}
```

### 16.2 Agent Wants To Inspect While Tests Run

Agent B:

```json
{
  "command": "rg \"TODO\" src",
  "cwd": "/repo",
  "intent": "search"
}
```

Result:

```json
{
  "action": "run_now",
  "taskId": "t_c",
  "reason": "Read-only tiny task can run concurrently."
}
```

### 16.3 Deploy Requires Exclusive Lock

Agent C:

```json
{
  "command": "kubectl apply -f deploy.yaml",
  "intent": "deploy"
}
```

Result:

```json
{
  "action": "needs_confirmation",
  "reason": "Deploy commands require explicit confirmation and host lock.",
  "risks": ["May mutate production state", "Blocks other scheduled tasks"]
}
```

## 17. Migration Strategy

### 17.1 Compatibility

Keep existing tools, but route them through scheduler where possible:

- `ssh_exec` -> scheduler auto
- `ssh_exec_background` -> scheduler queue
- `ssh_exec_status` -> scheduler task status
- `ssh_exec_cancel` -> daemon cancel
- `ssh_list_tasks` -> scheduler tasks

Support `scheduler="bypass"` for emergency compatibility.

### 17.2 Documentation Updates

Update:

- `README.md`
- `SKILL.md`
- `profiles/README.md`

Key message:

> For AI agents, use `ssh_schedule` for commands by default. It prevents multiple agents from overloading or conflicting on the same VM.

### 17.3 Rollout Order

1. Add scheduler internals behind daemon IPC.
2. Add new MCP tools.
3. Change `ssh_exec` default to scheduler auto.
4. Update docs.
5. Deprecate direct task manager use from MCP.

## 18. Testing Plan

### 18.1 Unit Tests

Policy engine:

- Classifies common commands.
- Detects risky commands.
- Chooses run/queue/wait/reject.
- Preserves explainable reason.

Queue manager:

- FIFO within same priority.
- Priority order.
- Fairness between agents.
- Pump starts next task after completion.

Lock manager:

- Acquire/release.
- Conflict detection.
- TTL expiration.
- Renewal.

Persistence:

- Atomic write.
- Restore queued/running/completed tasks.
- Mark stale running tasks after daemon restart.

### 18.2 Integration Tests

Daemon IPC:

- `schedule` starts a task.
- `schedule` queues behind a running task.
- `queueStatus` shows running and queued tasks.
- `waitTask` returns when done.
- `cancelTask` cancels queued and running tasks.

MCP:

- `ssh_schedule` response shapes.
- `ssh_exec` scheduler default.
- `ssh_exec` bypass.
- `ssh_get_host_load` includes scheduler state.

### 18.3 Multi-Agent Simulation

Create test harness with two or more fake agents:

1. Agent A schedules `sleep 2`.
2. Agent B schedules another large task.
3. Assert B is queued.
4. Agent C schedules read-only command.
5. Assert C runs immediately.
6. Wait for A.
7. Assert B starts.

### 18.4 Failure Tests

- Daemon restart while tasks are queued.
- Daemon restart while task is running.
- SSH connection drops.
- Agent disappears while holding lock.
- Command times out.
- Output grows beyond buffer limit.

## 19. Open Questions

1. Should queue state be per host, per profile, or per target user plus host?
   - Recommendation: per ordered host identity, with display grouping by target host.

2. Should tests in different workdirs run concurrently?
   - Recommendation: yes if host load allows, but only one large task by default on small VMs.

3. Should direct `ssh_exec` ever bypass scheduler by default?
   - Recommendation: no. Make bypass explicit.

4. Should queued tasks survive daemon restart?
   - Recommendation: yes.

5. Should running tasks survive daemon restart?
   - Recommendation: mark as `stale` unless a future remote supervisor can reattach.

6. Should AI be allowed to cancel another AI's task?
   - Recommendation: allow only with `force=true` and include owner details in response.

## 20. Minimum Viable Version

The smallest version that solves the current pain:

1. Persist all exec tasks immediately.
2. Add daemon-owned `SchedulerService`.
3. Add `ssh_schedule`, `ssh_queue_status`, `ssh_wait_task`.
4. Make `ssh_exec` use scheduler by default.
5. Implement simple command classification.
6. Allow one large/blocking task per host at a time.
7. Queue additional large/blocking tasks.
8. Let tiny read/search commands run concurrently.
9. Return blockers and recommended next step.

This MVP should be enough to stop most accidental AI task抢占 and make agents naturally continue other work while queued.

