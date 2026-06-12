
import { randomUUID } from "crypto"
import type {
  ScheduleRequest,
  ScheduleDecision,
  ScheduledTask,
  ScheduledTaskSummary,
  ScheduledTaskStatus,
  CommandClassification,
  QueueStatus,
  AgentIdentity,
  HostIdentity,
  TaskRunner,
  SchedulerLock,
  LockScope,
  SchedulerEvent,
  AgentRecord,
  TaskOutputResult,
} from "./types.js"
import { toSummary } from "./types.js"
import { classifyCommand } from "./command-classifier.js"
import { PersistenceStore } from "./persistence-store.js"
import { VirtualCwdStore } from "./virtual-cwd-store.js"
import { OutputStore } from "./output-store.js"
import { EventLog } from "./event-log.js"
import { LockManager } from "./lock-manager.js"

const FINISHED_TASK_TTL_MS = 60 * 60 * 1000
const EVICT_BATCH_SIZE = 100
const IDLE_EVICT_INTERVAL_MS = 5 * 60 * 1000

export interface SchedulerServiceOptions {
  persistence?: PersistenceStore
  runner?: TaskRunner
  outputStore?: OutputStore
  eventLog?: EventLog
  maxQueueSize?: number
  maxTotalRunning?: number
  maxLargeRunning?: number
  outputCleanupThrottleMs?: number
}

export class SchedulerService {
  private persistence: PersistenceStore
  private virtualCwdStore: VirtualCwdStore
  private outputStore: OutputStore
  private eventLog: EventLog
  private lockManager: LockManager
  private runner: TaskRunner

  private maxQueueSize: number
  private maxTotalRunning: number
  private maxLargeRunning: number

  private tasks = new Map<string, ScheduledTask>()
  private waitResolvers = new Map<string, { resolve: (task: ScheduledTask) => void; timer: ReturnType<typeof setTimeout> }[]>()
  private agents = new Map<string, AgentRecord>()
  private streamedOutputTasks = new Map<string, { stdout: boolean; stderr: boolean }>()
  private lastOutputCleanupAt = 0
  private outputCleanupThrottleMs: number

  private runningByHost = new Map<string, Set<string>>()
  private queuedByHost = new Map<string, Set<string>>()
  private lastEvictAt = 0
  private idleEvictTimer: ReturnType<typeof setInterval> | null = null

  constructor(opts?: SchedulerServiceOptions) {
    this.persistence = opts?.persistence ?? new PersistenceStore()
    this.runner = opts?.runner ?? {
      start: async () => ({ code: 0, stdout: "", stderr: "" }),
      startBackground: () => {},
    }
    this.maxQueueSize = opts?.maxQueueSize ?? 50
    this.maxTotalRunning = opts?.maxTotalRunning ?? 4
    this.maxLargeRunning = opts?.maxLargeRunning ?? 1

    this.virtualCwdStore = new VirtualCwdStore(this.persistence)
    this.outputStore = opts?.outputStore ?? new OutputStore()
    this.eventLog = opts?.eventLog ?? new EventLog()
    this.lockManager = new LockManager()
    this.outputCleanupThrottleMs = opts?.outputCleanupThrottleMs ?? 5 * 60 * 1000

    this.restore()
    this.cleanupOutputs()

    // Idle eviction: periodically clean up finished tasks even when scheduler is idle.
    // The handle is stored so dispose() can clear the timer and prevent the timer
    // from keeping the process alive in tests and short-lived callers.
    this.idleEvictTimer = setInterval(() => {
      this.evictOldTasks()
    }, IDLE_EVICT_INTERVAL_MS)
  }

  /**
   * Release scheduler-owned resources (idle eviction timer). Safe to call multiple
   * times; subsequent calls are no-ops. After dispose(), the scheduler should not be
   * expected to process new tasks (callers should treat it as terminated).
   */
  dispose(): void {
    if (this.idleEvictTimer) {
      clearInterval(this.idleEvictTimer)
      this.idleEvictTimer = null
    }
  }

  private restore(): void {
    const { queued, stale } = this.persistence.restore()
    for (const task of stale) {
      this.tasks.set(task.id, task)
      this.addToIndex(task)
    }
    for (const task of queued) {
      this.tasks.set(task.id, task)
      this.addToIndex(task)
    }
  }

  registerAgent(agent: AgentIdentity): AgentRecord {
    const existing = this.agents.get(agent.id)
    if (existing) {
      existing.lastSeenAt = Date.now()
      return existing
    }

    const record: AgentRecord = {
      id: agent.id,
      name: agent.name,
      clientType: agent.clientType,
      startedAt: Date.now(),
      lastSeenAt: Date.now(),
    }
    this.agents.set(agent.id, record)
    return record
  }

  heartbeat(agentId: string): void {
    const agent = this.agents.get(agentId)
    if (agent) {
      agent.lastSeenAt = Date.now()
    }
  }

  schedule(req: ScheduleRequest): ScheduleDecision {
    this.registerAgent(req.agent)

    const effectiveCwd = this.virtualCwdStore.resolve(req.agent.id, req.host.id, req.cwd)
    const classification = classifyCommand(req.command, {
      intent: req.intent,
      cost: req.cost,
      force: req.force,
    })

    if (classification.risky && !req.force) {
      return {
        action: "needs_confirmation",
        effectiveCwd,
        classification,
        reason: "Command may modify critical state. Pass force=true to execute.",
        recommendedNextStep: "Confirm risk and retry with force=true.",
      }
    }

    const task = this.createTask(req, effectiveCwd, classification)
    this.tasks.set(task.id, task)
    this.persistence.saveTask(task)
    this.outputStore.create(task.id)
    this.eventLog.log("task_created", { taskId: task.id, hostId: task.hostId, agentId: task.agentId, data: { command: task.command } })

    if (req.scheduler === "bypass") {
      this.startTask(task)
      return {
        action: "run_now",
        taskId: task.id,
        effectiveCwd,
        classification,
        reason: "scheduler=bypass, skipped queue but task is still registered.",
      }
    }

    const blockers = this.findBlockers(task)
    if (blockers.length === 0) {
      this.startTask(task)
      return {
        action: "run_now",
        taskId: task.id,
        effectiveCwd,
        classification,
        reason: "No conflicting tasks on this host; started execution.",
      }
    }

    const ifBusy = req.ifBusy ?? this.defaultIfBusy(classification)

    const hasExclusiveBlocker = blockers.some(b => b.classification?.cost === "exclusive")
    const effectiveIfBusy = (ifBusy === "run_anyway" && hasExclusiveBlocker) ? "queue" : ifBusy

    if (effectiveIfBusy === "run_anyway") {
      this.startTask(task)
      return {
        action: "run_now",
        taskId: task.id,
        effectiveCwd,
        classification,
        blockers,
        reason: "if_busy=run_anyway, executing despite conflicts.",
      }
    }

    if (effectiveIfBusy === "fail") {
      task.status = "cancelled"
      task.updatedAt = Date.now()
      this.persistence.saveTask(task)
      return {
        action: "rejected",
        effectiveCwd,
        classification,
        blockers,
        reason: "Host busy and if_busy=fail.",
      }
    }

    if (effectiveIfBusy === "wait") {
      task.status = "cancelled"
      task.updatedAt = Date.now()
      this.persistence.saveTask(task)
      return {
        action: "wait_recommended",
        effectiveCwd,
        classification,
        blockers,
        reason: "Host has conflicting tasks; consider waiting.",
        recommendedNextStep: "Use ssh_wait_task to wait for a blocker, or retry later.",
      }
    }

    const enqueued = this.enqueue(task)
    if (!enqueued) {
      return {
        action: "rejected",
        effectiveCwd,
        classification,
        blockers,
        reason: "Queue is full. Try again later or remove queued tasks.",
      }
    }
    return {
      action: "queued",
      taskId: task.id,
      queuePosition: task.queuePosition,
      effectiveCwd,
      classification,
      blockers,
      reason: "Host has conflicting tasks; command queued.",
      recommendedNextStep: "Do unrelated read-only work; call ssh_wait_task or ssh_queue_status later.",
    }
  }

  queueStatus(hostId?: string, limit = 20, agentId?: string): QueueStatus & { locks?: SchedulerLock[]; events?: SchedulerEvent[] } {
    const running = this.getRunningTasks(hostId).slice(0, limit).map(toSummary)
    const queued = this.getQueuedTasks(hostId).slice(0, limit).map(toSummary)
    const recent = this.getFinishedTasks(hostId, limit)

    return {
      hostId,
      running,
      queued,
      recent,
      virtualCwd: hostId && agentId ? this.virtualCwdStore.resolve(agentId, hostId) : undefined,
      limits: {
        maxQueueSize: this.maxQueueSize,
        maxTotalRunning: this.maxTotalRunning,
        maxLargeRunning: this.maxLargeRunning,
      },
      locks: hostId ? this.lockManager.getLocksForHost(hostId) : undefined,
      events: hostId ? this.eventLog.getRecent(limit, hostId) : undefined,
    }
  }

  getRecentEvents(limit = 100, hostId?: string): SchedulerEvent[] {
    return this.eventLog.getRecent(limit, hostId)
  }

  getTaskOutput(taskId: string, mode: "tail" | "full" = "tail"): TaskOutputResult {
    return this.outputStore.getOutput(taskId, mode)
  }

  waitTask(taskId: string, timeoutMs = 30000): Promise<ScheduledTask> {
    const task = this.tasks.get(taskId)
    if (!task) return Promise.reject(new Error(`Task ${taskId} not found`))
    if (task.status !== "queued" && task.status !== "running") return Promise.resolve(task)

    return new Promise((resolve, reject) => {
      let entry: { resolve: (task: ScheduledTask) => void; timer: ReturnType<typeof setTimeout> }
      const timer = setTimeout(() => {
        this.removeWaitResolver(taskId, entry)
        const current = this.tasks.get(taskId)
        if (current) {
          resolve(current)
        } else {
          reject(new Error("Task not found after timeout"))
        }
      }, timeoutMs)

      entry = { resolve: (t) => { clearTimeout(timer); resolve(t) }, timer }
      const resolvers = this.waitResolvers.get(taskId) ?? []
      resolvers.push(entry)
      this.waitResolvers.set(taskId, resolvers)
    })
  }

  dequeueTask(taskId: string): boolean {
    const task = this.tasks.get(taskId)
    if (!task || task.status !== "queued") return false

    const hostId = task.hostId
    task.status = "cancelled"
    task.updatedAt = Date.now()
    task.decisionReason = "Removed from queue by dequeue request."
    this.removeFromIndex(task)
    this.persistence.saveTask(task)
    this.eventLog.log("task_dequeued", { taskId, hostId, agentId: task.agentId })
    this.recomputeQueuePositions(hostId)
    this.resolveWaiters(taskId, task)
    return true
  }

  cancelTask(taskId: string): boolean {
    const task = this.tasks.get(taskId)
    if (!task) return false
    if (task.status !== "running" && task.status !== "queued") return false

    const wasRunning = task.status === "running"
    const hostId = task.hostId

    // Mark as cancelled BEFORE invoking runner.cancel. The runner's cancel()
    // may synchronously trigger stream.close(), which fires the stream's
    // "close" handler → onClose callback → finishTask. Without this ordering,
    // finishTask would observe status="running" and overwrite the cancel
    // state with "completed"/"failed". See exec-task-manager.ts cancel() for
    // the same pattern.
    this.removeFromIndex(task)
    task.status = "cancelled"
    task.updatedAt = Date.now()
    task.decisionReason = "Cancelled by cancel request."

    if (wasRunning && this.runner.cancel) {
      const cancelled = this.runner.cancel(task)
      if (!cancelled) {
        // runner refused; restore the previous status/index so the task keeps
        // running as if cancel was never called.
        task.status = "running"
        this.addToIndex(task)
        return false
      }
    }

    this.lockManager.releaseForTask(taskId)
    this.persistence.saveTask(task)
    this.eventLog.log("task_cancelled", { taskId, hostId, agentId: task.agentId })

    this.resolveWaiters(taskId, task)

    this.pumpQueue(hostId)

    return true
  }

  abortActiveTasks(reason: string): { cancelled: number; cancelFailed: number } {
    let cancelled = 0
    let cancelFailed = 0
    const active = Array.from(this.tasks.values())
      .filter(task => task.status === "queued" || task.status === "running")
      .sort((a, b) => {
        if (a.status === b.status) return 0
        return a.status === "queued" ? -1 : 1
      })

    for (const task of active) {
      const ok = this.cancelTask(task.id)
      if (ok) {
        task.decisionReason = reason
        task.updatedAt = Date.now()
        this.persistence.saveTask(task)
        cancelled++
      } else {
        task.decisionReason = `${reason} Cancel attempt failed.`
        task.updatedAt = Date.now()
        this.persistence.saveTask(task)
        cancelFailed++
      }
    }

    return { cancelled, cancelFailed }
  }

  cleanupOutputs(): { deletedFiles: number; deletedBytes: number; keptFiles: number } {
    const protectedTaskIds: string[] = []
    for (const [, ids] of this.runningByHost) {
      for (const id of ids) protectedTaskIds.push(id)
    }
    for (const [, ids] of this.queuedByHost) {
      for (const id of ids) protectedTaskIds.push(id)
    }
    return this.outputStore.cleanup(undefined, protectedTaskIds)
  }

  setCwd(agentId: string, hostId: string, cwd: string): string {
    const state = this.virtualCwdStore.set(agentId, hostId, cwd)
    this.eventLog.log("cwd_changed", { agentId, hostId, data: { cwd } })
    return state.cwd
  }

  resolveCwd(agentId: string, hostId: string, explicitCwd?: string): string | undefined {
    return this.virtualCwdStore.resolve(agentId, hostId, explicitCwd)
  }

  getTask(taskId: string): ScheduledTask | undefined {
    return this.tasks.get(taskId)
  }

  getRunner(): TaskRunner {
    return this.runner
  }

  acquireLock(
    scope: LockScope,
    key: string,
    hostId: string,
    agentId: string,
    taskId?: string,
    reason?: string
  ): SchedulerLock | null {
    const lock = this.lockManager.acquire(scope, key, hostId, agentId, taskId, reason)
    if (lock) {
      this.eventLog.log("lock_acquired", { hostId, agentId, data: { lockId: lock.id, scope, key } })
    }
    return lock
  }

  releaseLock(lockId: string): boolean {
    const result = this.lockManager.release(lockId)
    if (result) {
      this.eventLog.log("lock_released", { data: { lockId } })
    }
    return result
  }

  private createTask(req: ScheduleRequest, effectiveCwd: string | undefined, classification: CommandClassification): ScheduledTask {
    return {
      id: `t_${randomUUID().slice(0, 10)}`,
      agentId: req.agent.id,
      agentName: req.agent.name,
      hostId: req.host.id,
      profileKey: req.host.profileKey,
      sessionId: req.sessionId,
      command: req.command,
      effectiveCwd,
      reason: req.reason,
      classification,
      scheduler: req.scheduler ?? "auto",
      status: "queued",
      updatedAt: Date.now(),
      stdoutTail: "",
      stderrTail: "",
      stdoutBytes: 0,
      stderrBytes: 0,
      timeoutMs: req.timeoutMs,
      background: req.background,
    }
  }

  private startTask(task: ScheduledTask): void {
    if (task.classification.cost === "exclusive") {
      this.lockManager.acquire("host", task.hostId, task.hostId, task.agentId, task.id, "exclusive task")
    } else if (task.classification.mutates && task.effectiveCwd) {
      this.lockManager.acquire("workdir", task.effectiveCwd, task.hostId, task.agentId, task.id, "mutating task in workdir")
    }

    this.removeFromIndex(task)
    task.status = "running"
    task.startedAt = Date.now()
    task.updatedAt = Date.now()
    this.addToIndex(task)
    this.persistence.saveTask(task)
    this.eventLog.log("task_started", { taskId: task.id, hostId: task.hostId, agentId: task.agentId })

    if (task.background && this.runner.startBackground) {
      this.runner.startBackground(task,
        (stdout, stderr) => {
          if (stdout) this.outputStore.appendStdout(task.id, stdout)
          if (stderr) this.outputStore.appendStderr(task.id, stderr)
        },
        (code, signal) => {
          this.finishTask(task.id, code === 0 ? "completed" : "failed", code, signal)
        },
      )
    } else {
      const onOutput = (stdout: string, stderr: string): void => {
        if (stdout) {
          this.markStreamedOutput(task.id, "stdout")
          this.outputStore.appendStdout(task.id, stdout)
        }
        if (stderr) {
          this.markStreamedOutput(task.id, "stderr")
          this.outputStore.appendStderr(task.id, stderr)
        }
      }
      this.runner.start(task, onOutput)
        .then(result => this.finishTask(task.id, result.code === 0 ? "completed" : "failed", result.code, result.signal, result.stdout, result.stderr))
        .catch(err => this.finishTask(task.id, "failed", 1, undefined, "", err.message))
    }
  }

  private finishTask(taskId: string, status: ScheduledTaskStatus, exitCode: number, signal?: string, stdout?: string, stderr?: string): void {
    const task = this.tasks.get(taskId)
    if (!task) return
    if (task.status === "cancelled") return

    this.removeFromIndex(task)
    task.status = status
    task.exitCode = exitCode
    task.signal = signal ?? null
    task.finishedAt = Date.now()
    task.updatedAt = Date.now()

    const alreadyStreamed = this.streamedOutputTasks.get(taskId)
    this.streamedOutputTasks.delete(taskId)

    if (stdout && !alreadyStreamed?.stdout) {
      this.outputStore.appendStdout(taskId, stdout)
    }
    if (stderr && !alreadyStreamed?.stderr) {
      this.outputStore.appendStderr(taskId, stderr)
    }
    const output = this.outputStore.get(taskId)
    if (output) {
      task.stdoutTail = output.stdoutTail
      task.stdoutBytes = output.stdoutBytes
      task.stderrTail = output.stderrTail
      task.stderrBytes = output.stderrBytes
    }

    this.lockManager.releaseForTask(taskId)

    this.persistence.saveTask(task)
    const eventType = status === "completed" ? "task_completed" : status === "failed" ? "task_failed" : status === "cancelled" ? "task_cancelled" : "task_timed_out"
    this.eventLog.log(eventType, { taskId: task.id, hostId: task.hostId, agentId: task.agentId, data: { exitCode } })

    this.resolveWaiters(taskId, task)

    this.pumpQueue(task.hostId)
    this.cleanupOutputsThrottled()
    this.evictOldTasks()
  }

  private findBlockers(task: ScheduledTask): ScheduledTaskSummary[] {
    const runningIds = this.runningByHost.get(task.hostId)
    if (!runningIds || runningIds.size === 0) return []

    const nonBypass: ScheduledTask[] = []
    for (const id of runningIds) {
      const t = this.tasks.get(id)
      if (!t || t.status !== "running") continue
      if (t.scheduler !== "bypass") nonBypass.push(t)
    }

    if (task.classification.cost === "exclusive" || task.classification.cost === "large") {
      if (task.effectiveCwd) {
        const workdirConflicts = this.lockManager.getConflictingLocks("workdir", task.effectiveCwd, task.hostId)
        if (workdirConflicts.length > 0) {
          const blockingTaskIds = workdirConflicts.map(l => l.ownerTaskId).filter(Boolean) as string[]
          return blockingTaskIds
            .map(id => this.tasks.get(id))
            .filter((t): t is ScheduledTask => t !== undefined)
            .map(toSummary)
        }
      }
    }

    switch (task.classification.cost) {
      case "tiny":
        return nonBypass.filter(t => t.classification.cost === "exclusive").map(toSummary)
      case "small":
      case "medium":
        return nonBypass.length >= this.maxTotalRunning ? nonBypass.map(toSummary) : []
      case "large":
        return nonBypass.filter(t => t.classification.cost === "large" || t.classification.cost === "exclusive").map(toSummary)
      case "exclusive":
        return nonBypass.map(toSummary)
    }
  }

  private enqueue(task: ScheduledTask): boolean {
    const queuedIds = this.queuedByHost.get(task.hostId)
    const queuedCount = queuedIds ? queuedIds.size : 0
    if (queuedCount >= this.maxQueueSize) {
      task.status = "cancelled"
      task.updatedAt = Date.now()
      task.decisionReason = "Queue full."
      this.persistence.saveTask(task)
      return false
    }

    task.status = "queued"
    task.queuedAt = Date.now()
    task.updatedAt = Date.now()
    this.addToIndex(task)
    this.persistence.saveTask(task)
    this.eventLog.log("task_queued", { taskId: task.id, hostId: task.hostId, agentId: task.agentId })
    this.recomputeQueuePositions(task.hostId)
    return true
  }

  private pumpQueue(hostId: string): void {
    const queued = this.getQueuedTasks(hostId)
    for (const task of queued) {
      const blockers = this.findBlockers(task)
      if (blockers.length === 0) {
        this.startTask(task)
        task.queuePosition = undefined
        this.persistence.saveTask(task)
        this.eventLog.log("task_dequeued", { taskId: task.id, hostId: task.hostId, agentId: task.agentId })
      }
    }
    this.recomputeQueuePositions(hostId)
  }

  private getRunningTasks(hostId?: string): ScheduledTask[] {
    if (hostId) {
      const ids = this.runningByHost.get(hostId)
      if (!ids) return []
      const tasks: ScheduledTask[] = []
      for (const id of ids) {
        const t = this.tasks.get(id)
        if (t && t.status === "running") tasks.push(t)
      }
      return tasks
    }
    const tasks: ScheduledTask[] = []
    for (const [, ids] of this.runningByHost) {
      for (const id of ids) {
        const t = this.tasks.get(id)
        if (t && t.status === "running") tasks.push(t)
      }
    }
    return tasks
  }

  private getQueuedTasks(hostId?: string): ScheduledTask[] {
    if (hostId) {
      const ids = this.queuedByHost.get(hostId)
      if (!ids) return []
      const tasks: ScheduledTask[] = []
      for (const id of ids) {
        const t = this.tasks.get(id)
        if (t && t.status === "queued") tasks.push(t)
      }
      return tasks.sort((a, b) => (a.queuedAt ?? 0) - (b.queuedAt ?? 0))
    }
    const tasks: ScheduledTask[] = []
    for (const [, ids] of this.queuedByHost) {
      for (const id of ids) {
        const t = this.tasks.get(id)
        if (t && t.status === "queued") tasks.push(t)
      }
    }
    return tasks.sort((a, b) => (a.queuedAt ?? 0) - (b.queuedAt ?? 0))
  }

  private getFinishedTasks(hostId?: string, limit = 20): ScheduledTaskSummary[] {
    const recent: ScheduledTask[] = []
    for (const task of this.tasks.values()) {
      if (hostId && task.hostId !== hostId) continue
      if (!["completed", "failed", "cancelled", "timeout", "stale"].includes(task.status)) continue
      recent.push(task)
    }
    return recent
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
      .slice(0, limit)
      .map(toSummary)
  }

  private recomputeQueuePositions(hostId: string): void {
    const queued = this.getQueuedTasks(hostId)
    queued.forEach((task, index) => {
      task.queuePosition = index + 1
    })
  }

  private addToIndex(task: ScheduledTask): void {
    if (task.status === "running") {
      let set = this.runningByHost.get(task.hostId)
      if (!set) { set = new Set(); this.runningByHost.set(task.hostId, set) }
      set.add(task.id)
    } else if (task.status === "queued") {
      let set = this.queuedByHost.get(task.hostId)
      if (!set) { set = new Set(); this.queuedByHost.set(task.hostId, set) }
      set.add(task.id)
    }
  }

  private removeFromIndex(task: ScheduledTask): void {
    if (task.status === "running") {
      const set = this.runningByHost.get(task.hostId)
      if (set) {
        set.delete(task.id)
        if (set.size === 0) this.runningByHost.delete(task.hostId)
      }
    } else if (task.status === "queued") {
      const set = this.queuedByHost.get(task.hostId)
      if (set) {
        set.delete(task.id)
        if (set.size === 0) this.queuedByHost.delete(task.hostId)
      }
    }
  }

  private evictOldTasks(): void {
    const now = Date.now()
    if (now - this.lastEvictAt < 60_000) return
    this.lastEvictAt = now

    let evicted = 0
    for (const [id, task] of this.tasks) {
      if (evicted >= EVICT_BATCH_SIZE) break
      if (task.status === "running" || task.status === "queued") continue
      const finishedAt = task.finishedAt ?? task.updatedAt ?? 0
      if (now - finishedAt > FINISHED_TASK_TTL_MS) {
        this.tasks.delete(id)
        this.streamedOutputTasks.delete(id)
        evicted++
      }
    }
  }

  private resolveWaiters(taskId: string, task: ScheduledTask): void {
    const resolvers = this.waitResolvers.get(taskId)
    if (!resolvers) return
    for (const r of resolvers) {
      clearTimeout(r.timer)
      r.resolve(task)
    }
    this.waitResolvers.delete(taskId)
  }

  private removeWaitResolver(taskId: string, entry: { resolve: (task: ScheduledTask) => void; timer: ReturnType<typeof setTimeout> }): void {
    const resolvers = this.waitResolvers.get(taskId)
    if (!resolvers) return
    const idx = resolvers.indexOf(entry)
    if (idx !== -1) resolvers.splice(idx, 1)
    if (resolvers.length === 0) this.waitResolvers.delete(taskId)
  }

  private defaultIfBusy(classification: CommandClassification): "run_anyway" | "wait" | "queue" | "fail" {
    if (classification.cost === "exclusive") return "queue"
    if (classification.cost === "large") return "queue"
    if (classification.cost === "medium") return "queue"
    return "run_anyway"
  }

  private markStreamedOutput(taskId: string, stream: "stdout" | "stderr"): void {
    const state = this.streamedOutputTasks.get(taskId) ?? { stdout: false, stderr: false }
    state[stream] = true
    this.streamedOutputTasks.set(taskId, state)
  }

  private cleanupOutputsThrottled(): void {
    const now = Date.now()
    if (now - this.lastOutputCleanupAt < this.outputCleanupThrottleMs) return
    this.lastOutputCleanupAt = now
    this.cleanupOutputs()
  }
}
