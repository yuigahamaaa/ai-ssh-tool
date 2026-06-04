
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
} from "./types.js"
import { toSummary } from "./types.js"
import { classifyCommand } from "./command-classifier.js"
import { PersistenceStore } from "./persistence-store.js"
import { VirtualCwdStore } from "./virtual-cwd-store.js"
import { OutputStore } from "./output-store.js"
import { EventLog } from "./event-log.js"
import { LockManager } from "./lock-manager.js"

export interface SchedulerServiceOptions {
  persistence?: PersistenceStore
  runner?: TaskRunner
  maxQueueSize?: number
  maxTotalRunning?: number
  maxLargeRunning?: number
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
    this.outputStore = new OutputStore()
    this.eventLog = new EventLog()
    this.lockManager = new LockManager()

    this.restore()
  }

  private restore(): void {
    const { queued, stale } = this.persistence.restore()
    for (const task of stale) {
      this.tasks.set(task.id, task)
    }
    for (const task of queued) {
      this.tasks.set(task.id, task)
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

  queueStatus(hostId?: string, limit = 20): QueueStatus & { locks?: SchedulerLock[]; events?: SchedulerEvent[] } {
    const all = Array.from(this.tasks.values())
    const filtered = hostId ? all.filter(t => t.hostId === hostId) : all

    return {
      hostId,
      running: filtered.filter(t => t.status === "running").slice(0, limit).map(toSummary),
      queued: filtered.filter(t => t.status === "queued").sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0)).slice(0, limit).map(toSummary),
      recent: filtered.filter(t => ["completed", "failed", "cancelled", "timeout", "stale"].includes(t.status)).sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0)).slice(0, limit).map(toSummary),
      virtualCwd: hostId ? this.virtualCwdStore.resolve("__peek__", hostId) : undefined,
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

  getTaskOutput(taskId: string, mode: "tail" | "full" = "tail"): { stdout: string; stderr: string } {
    if (mode === "full") {
      return {
        stdout: this.outputStore.getFullStdout(taskId),
        stderr: this.outputStore.getFullStderr(taskId),
      }
    } else {
      const output = this.outputStore.get(taskId)
      return {
        stdout: output?.stdoutTail ?? "",
        stderr: output?.stderrTail ?? "",
      }
    }
  }

  waitTask(taskId: string, timeoutMs = 30000): Promise<ScheduledTask> {
    const task = this.tasks.get(taskId)
    if (!task) return Promise.reject(new Error(`Task ${taskId} not found`))
    if (task.status !== "queued" && task.status !== "running") return Promise.resolve(task)

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeWaitResolver(taskId, resolve)
        const current = this.tasks.get(taskId)
        if (current) {
          resolve(current)
        } else {
          reject(new Error("Task not found after timeout"))
        }
      }, timeoutMs)

      const resolvers = this.waitResolvers.get(taskId) ?? []
      resolvers.push({ resolve: (t) => { clearTimeout(timer); resolve(t) }, timer })
      this.waitResolvers.set(taskId, resolvers)
    })
  }

  dequeueTask(taskId: string): boolean {
    const task = this.tasks.get(taskId)
    if (!task || task.status !== "queued") return false

    task.status = "cancelled"
    task.updatedAt = Date.now()
    task.decisionReason = "Removed from queue by dequeue request."
    this.persistence.saveTask(task)
    this.eventLog.log("task_dequeued", { taskId, hostId: task.hostId, agentId: task.agentId })
    this.recomputeQueuePositions(task.hostId)
    return true
  }

  cancelTask(taskId: string): boolean {
    const task = this.tasks.get(taskId)
    if (!task) return false

    if (task.status === "running" && task.pid) {
      // For running tasks, we need to signal the process
      try {
        process.kill(task.pid, "TERM")
        setTimeout(() => {
          try {
            process.kill(task.pid!, "KILL")
          } catch {
            // ignore
          }
        }, 5000)
      } catch {
        // ignore if process already dead
      }
    }

    if (task.status === "queued") {
      this.recomputeQueuePositions(task.hostId)
    }

    task.status = "cancelled"
    task.updatedAt = Date.now()
    task.decisionReason = "Cancelled by cancel request."
    this.persistence.saveTask(task)
    this.eventLog.log("task_cancelled", { taskId, hostId: task.hostId, agentId: task.agentId })
    return true
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
    }
  }

  private startTask(task: ScheduledTask): void {
    if (task.classification.cost === "exclusive") {
      this.lockManager.acquire("host", task.hostId, task.hostId, task.agentId, task.id, "exclusive task")
    } else if (task.classification.mutates && task.effectiveCwd) {
      this.lockManager.acquire("workdir", task.effectiveCwd, task.hostId, task.agentId, task.id, "mutating task in workdir")
    }

    task.status = "running"
    task.startedAt = Date.now()
    task.updatedAt = Date.now()
    this.persistence.saveTask(task)
    this.eventLog.log("task_started", { taskId: task.id, hostId: task.hostId, agentId: task.agentId })

    this.runner.start(task)
      .then(result => this.finishTask(task.id, result.code === 0 ? "completed" : "failed", result.code, result.signal, result.stdout, result.stderr))
      .catch(err => this.finishTask(task.id, "failed", 1, undefined, "", err.message))
  }

  private finishTask(taskId: string, status: ScheduledTaskStatus, exitCode: number, signal?: string, stdout?: string, stderr?: string): void {
    const task = this.tasks.get(taskId)
    if (!task) return

    task.status = status
    task.exitCode = exitCode
    task.signal = signal ?? null
    task.finishedAt = Date.now()
    task.updatedAt = Date.now()

    if (stdout) {
      this.outputStore.appendStdout(taskId, stdout)
      const output = this.outputStore.get(taskId)
      if (output) {
        task.stdoutTail = output.stdoutTail
        task.stdoutBytes = output.stdoutBytes
      }
    }
    if (stderr) {
      this.outputStore.appendStderr(taskId, stderr)
      const output = this.outputStore.get(taskId)
      if (output) {
        task.stderrTail = output.stderrTail
        task.stderrBytes = output.stderrBytes
      }
    }

    this.lockManager.releaseForTask(taskId)

    this.persistence.saveTask(task)
    const eventType = status === "completed" ? "task_completed" : status === "failed" ? "task_failed" : status === "cancelled" ? "task_cancelled" : "task_timed_out"
    this.eventLog.log(eventType, { taskId: task.id, hostId: task.hostId, agentId: task.agentId, data: { exitCode } })

    const resolvers = this.waitResolvers.get(taskId)
    if (resolvers) {
      for (const r of resolvers) {
        clearTimeout(r.timer)
        r.resolve(task)
      }
      this.waitResolvers.delete(taskId)
    }

    this.pumpQueue(task.hostId)
  }

  private findBlockers(task: ScheduledTask): ScheduledTaskSummary[] {
    if (task.scheduler === "bypass") return []

    const running = this.runningTasks(task.hostId)
    const nonBypass = running.filter(t => t.scheduler !== "bypass")

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
    const queuedCount = this.queuedTasks(task.hostId).filter(t => t.id !== task.id).length
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
    this.persistence.saveTask(task)
    this.eventLog.log("task_queued", { taskId: task.id, hostId: task.hostId, agentId: task.agentId })
    this.recomputeQueuePositions(task.hostId)
    return true
  }

  private pumpQueue(hostId: string): void {
    for (const task of this.queuedTasks(hostId)) {
      const blockers = this.findBlockers(task)
      if (blockers.length > 0) break
      this.startTask(task)
    }
    this.recomputeQueuePositions(hostId)
  }

  private recomputeQueuePositions(hostId: string): void {
    const queued = this.queuedTasks(hostId)
    for (let i = 0; i < queued.length; i++) {
      queued[i].queuePosition = i + 1
      this.persistence.saveTask(queued[i])
    }
  }

  private runningTasks(hostId: string): ScheduledTask[] {
    return Array.from(this.tasks.values()).filter(t => t.hostId === hostId && t.status === "running")
  }

  private queuedTasks(hostId: string): ScheduledTask[] {
    return Array.from(this.tasks.values())
      .filter(t => t.hostId === hostId && t.status === "queued")
      .sort((a, b) => (a.queuedAt ?? 0) - (b.queuedAt ?? 0))
  }

  private defaultIfBusy(classification: CommandClassification): "run_anyway" | "wait" | "queue" | "fail" {
    switch (classification.cost) {
      case "tiny":
      case "small":
        return "run_anyway"
      case "medium":
      case "large":
      case "exclusive":
        return "queue"
    }
  }

  private removeWaitResolver(taskId: string, resolve: (task: ScheduledTask) => void): void {
    const resolvers = this.waitResolvers.get(taskId)
    if (!resolvers) return
    const idx = resolvers.findIndex(r => r.resolve === resolve)
    if (idx >= 0) resolvers.splice(idx, 1)
    if (resolvers.length === 0) this.waitResolvers.delete(taskId)
  }
}
