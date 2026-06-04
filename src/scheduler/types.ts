export type TaskIntent =
  | "inspect"
  | "search"
  | "test"
  | "build"
  | "install"
  | "server"
  | "deploy"
  | "migration"
  | "cleanup"
  | "custom"

export type TaskCost = "tiny" | "small" | "medium" | "large" | "exclusive"

export type TaskUrgency = "low" | "normal" | "high" | "urgent"

export type ScheduledTaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout"
  | "stale"

export interface AgentIdentity {
  id: string
  name?: string
  clientType: "mcp" | "cli"
}

export interface HostIdentity {
  id: string
  profileKey: string
  targetHost: string
  targetUser: string
  displayName: string
}

export interface CommandClassification {
  intent: TaskIntent
  cost: TaskCost
  blocking: boolean
  mutates: boolean
  risky: boolean
  source: "agent" | "auto" | "default" | "agent_overridden_by_policy"
  reason: string
}

export interface ScheduleRequest {
  agent: AgentIdentity
  host: HostIdentity
  sessionId: string
  command: string
  cwd?: string
  reason?: string
  intent?: TaskIntent
  cost?: TaskCost
  urgency?: TaskUrgency
  ifBusy?: "run_anyway" | "wait" | "queue" | "fail"
  scheduler?: "auto" | "bypass"
  timeoutMs?: number
  force?: boolean
  background?: boolean
}

export interface ScheduledTask {
  id: string
  agentId: string
  agentName?: string
  hostId: string
  profileKey: string
  sessionId: string
  command: string
  effectiveCwd?: string
  reason?: string
  classification: CommandClassification
  scheduler: "auto" | "bypass"
  status: ScheduledTaskStatus
  queuePosition?: number
  queuedAt?: number
  startedAt?: number
  finishedAt?: number
  updatedAt: number
  pid?: number | null
  exitCode?: number | null
  signal?: string | null
  stdoutTail: string
  stderrTail: string
  stdoutBytes: number
  stderrBytes: number
  decisionReason?: string
  timeoutMs?: number
  background?: boolean
}

export type ScheduledTaskSummary = Pick<
  ScheduledTask,
  "id" | "agentId" | "agentName" | "hostId" | "command" | "status" | "classification" | "scheduler" | "startedAt" | "stdoutTail"
>

export interface TaskOutputFiles {
  stdout: string
  stderr: string
}

export interface TaskOutputResult {
  stdout: string
  stderr: string
  stdoutBytes: number
  stderrBytes: number
  stdoutPath: string
  stderrPath: string
  outputFiles: TaskOutputFiles
  truncated: boolean
  stdoutTruncated: boolean
  stderrTruncated: boolean
  stdoutFileTruncated: boolean
  stderrFileTruncated: boolean
}

export interface ScheduleDecision {
  action: "run_now" | "queued" | "wait_recommended" | "rejected" | "needs_confirmation"
  taskId?: string
  queuePosition?: number
  effectiveCwd?: string
  classification?: CommandClassification
  blockers?: ScheduledTaskSummary[]
  reason: string
  recommendedNextStep?: string
  waitTimedOut?: boolean
  result?: {
    stdout: string
    stderr: string
    code: number
    signal?: string
    stdoutBytes?: number
    stderrBytes?: number
    stdoutPath?: string
    stderrPath?: string
    outputFiles?: TaskOutputFiles
    truncated?: boolean
    stdoutTruncated?: boolean
    stderrTruncated?: boolean
    stdoutFileTruncated?: boolean
    stderrFileTruncated?: boolean
  }
}

export interface QueueStatus {
  hostId?: string
  running: ScheduledTaskSummary[]
  queued: ScheduledTaskSummary[]
  recent: ScheduledTaskSummary[]
  virtualCwd?: string
  limits: {
    maxQueueSize: number
    maxTotalRunning: number
    maxLargeRunning: number
  }
}

export interface VirtualCwdState {
  key: string
  agentId: string
  hostId: string
  cwd: string
  updatedAt: number
}

export interface TaskRunner {
  start(task: ScheduledTask): Promise<{ code: number; stdout: string; stderr: string; signal?: string }>
  cancel?(task: ScheduledTask): boolean
  startBackground(
    task: ScheduledTask,
    onOutput: (stdout: string, stderr: string) => void,
    onClose: (code: number, signal?: string) => void
  ): void
}

export interface SchedulerServiceInterface {
  schedule(req: ScheduleRequest): ScheduleDecision
  getStatus(): QueueStatus
  getRecentEvents(limit?: number, hostId?: string): SchedulerEvent[]
  getTaskOutput(taskId: string, mode?: "tail" | "full"): TaskOutputResult
  getTask(taskId: string): ScheduledTask | undefined
  waitTask(taskId: string, timeoutMs?: number): Promise<ScheduledTask>
  dequeueTask(taskId: string): boolean
  cancelTask(taskId: string): boolean
  setCwd(agentId: string, hostId: string, cwd: string): string
  resolveCwd(agentId: string, hostId: string, explicitCwd?: string): string | undefined
}

export type LockScope = "host" | "workdir" | "custom"

export interface SchedulerLock {
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

export type EventType =
  | "task_created"
  | "task_queued"
  | "task_started"
  | "task_completed"
  | "task_failed"
  | "task_cancelled"
  | "task_timed_out"
  | "lock_acquired"
  | "lock_released"
  | "task_dequeued"
  | "cwd_changed"

export interface SchedulerEvent {
  id: string
  type: EventType
  timestamp: number
  taskId?: string
  hostId?: string
  agentId?: string
  data?: Record<string, unknown>
}

export interface AgentRecord {
  id: string
  name?: string
  clientType: "mcp" | "cli"
  startedAt: number
  lastSeenAt: number
  defaultProfile?: string
}

export function toSummary(task: ScheduledTask): ScheduledTaskSummary {
  return {
    id: task.id,
    agentId: task.agentId,
    agentName: task.agentName,
    hostId: task.hostId,
    command: task.command,
    status: task.status,
    classification: task.classification,
    scheduler: task.scheduler,
    startedAt: task.startedAt,
    stdoutTail: task.stdoutTail,
  }
}
