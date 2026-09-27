import type { CoordinationConflict, TaskIntent } from "./protocol.js"
import type { RemoteCoordinatorClient } from "./client.js"

export interface CoordinationMetadata {
  available: boolean
  coordinationUnavailable?: boolean
  warning?: string
  taskId?: string
  workspace?: string
  conflicts?: CoordinationConflict[]
  observed?: Array<Record<string, unknown>>
}

export class CoordinatorTaskScope {
  private taskId: string | undefined
  private leaseToken: string | undefined
  private heartbeatTimer: NodeJS.Timeout | null = null
  private finished = false
  private beginPromise: Promise<CoordinationMetadata> | null = null
  private metadata: CoordinationMetadata = { available: false }

  constructor(private readonly client: RemoteCoordinatorClient, private readonly task: TaskIntent, private readonly force = false, private readonly heartbeatMs = 30_000) {}

  async begin(): Promise<CoordinationMetadata> {
    if (this.finished) return this.metadata
    if (this.beginPromise) return this.beginPromise
    this.beginPromise = this.beginInternal()
    return this.beginPromise
  }

  private async beginInternal(): Promise<CoordinationMetadata> {
    const response = await this.client.beginTask(this.task, this.force)
    if (!response.ok) {
      this.metadata = { available: false, coordinationUnavailable: true, warning: response.message, workspace: this.task.workspace }
      return this.metadata
    }
    const data = response.data as { taskId: string; leaseToken: string; conflicts?: CoordinationConflict[]; observed?: Array<Record<string, unknown>> }
    this.taskId = data.taskId
    this.leaseToken = data.leaseToken
    if (this.finished) {
      // The task can finish while the remote coordinator is still opening its
      // request channel. Release a lease that arrived too late instead of
      // leaving an orphaned active task and heartbeat.
      await this.client.finishTask(data.taskId, data.leaseToken, "cancelled")
      this.metadata = {
        available: true,
        taskId: data.taskId,
        workspace: this.task.workspace,
        warning: "task finished before coordinator lease was acquired",
        conflicts: data.conflicts ?? [],
        observed: data.observed ?? [],
      }
      return this.metadata
    }
    this.metadata = { available: true, taskId: data.taskId, workspace: this.task.workspace, conflicts: data.conflicts ?? [], observed: data.observed ?? [], ...((data.conflicts?.length || data.observed?.length) ? { warning: "workspace has active observed activity" } : {}) }
    this.heartbeatTimer = setInterval(() => { void this.heartbeat() }, this.heartbeatMs)
    this.heartbeatTimer.unref()
    return this.metadata
  }

  getMetadata(): CoordinationMetadata { return this.metadata }

  async heartbeat(): Promise<void> {
    if (this.finished || !this.taskId || !this.leaseToken) return
    await this.client.heartbeat(this.taskId, this.leaseToken)
  }

  async finish(outcome: "success" | "failed" | "cancelled"): Promise<void> {
    if (this.finished) return
    this.finished = true
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
    if (this.taskId && this.leaseToken) await this.client.finishTask(this.taskId, this.leaseToken, outcome)
  }

  async dispose(): Promise<void> {
    await this.finish("cancelled")
  }
}
