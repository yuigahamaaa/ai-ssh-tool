import type { ScheduleDecision, ScheduledTask, TaskOutputResult } from "./scheduler/types.js"

export type McpResponseKind =
  | "schedule_decision"
  | "task_status"
  | "wait_result"
  | "cancel_result"
  | "queue_status"
  | "cleanup_result"
  | "host_load"
  | "cwd_result"
  | "dequeue_result"
  | "error"

export interface McpEnvelope<T> {
  ok: boolean
  kind: McpResponseKind
  data?: T
  error?: string
  agentGuidance: string[]
}

export type ScheduleDecisionEnvelope = McpEnvelope<ScheduleDecision> & ScheduleDecision

export interface TaskStatusPayload {
  task: ScheduledTask
  output?: TaskOutputResult
}

export interface WaitTaskPayload {
  task: ScheduledTask
  output?: TaskOutputResult
  waitTimedOut: boolean
}

export interface CancelTaskPayload {
  taskId: string
  cancelled: boolean
}

export function guidanceForScheduleDecision(decision: ScheduleDecision): string[] {
  const guidance: string[] = []

  if (decision.action === "queued") {
    guidance.push("Task was queued. Do not immediately resubmit the same command. Continue unrelated read/search/planning work, then call ssh_queue_status or ssh_wait_task with this taskId.")
  } else if (decision.waitTimedOut) {
    guidance.push("The foreground wait timed out but the task is still registered. Use ssh_exec_status with taskId to check status/output instead of rerunning the command.")
  } else if (decision.action === "wait_recommended") {
    guidance.push("A conflicting task is running. Prefer waiting for a blocker or doing unrelated work before retrying.")
  } else if (decision.action === "needs_confirmation") {
    guidance.push("This command is risky. Explain the risk and retry with force=true only if the user intends it.")
  } else if (decision.action === "rejected") {
    guidance.push("The scheduler rejected this command. Read reason/blockers before retrying or changing if_busy/force.")
  }

  const result = decision.result
  if (result?.truncated) {
    guidance.push(`Returned stdout/stderr are tails only. Read full output from stdoutPath=${result.stdoutPath} and stderrPath=${result.stderrPath}, or call ssh_exec_status with mode=full when this task is still tracked.`)
  }

  return guidance
}

export function guidanceForTaskStatus(task: ScheduledTask, output?: TaskOutputResult): string[] {
  const guidance: string[] = []

  if (task.status === "queued") {
    guidance.push("Task is still queued. Do not resubmit the command; continue unrelated work or wait for this taskId.")
  } else if (task.status === "running") {
    guidance.push("Task is still running. Do not resubmit the command; call ssh_exec_status or ssh_wait_task later.")
  } else if (task.status === "completed") {
    guidance.push("Task completed. Use output.stdout/output.stderr below; if truncated, read stdoutPath/stderrPath for full logs.")
  } else if (task.status === "failed" || task.status === "timeout") {
    guidance.push("Task finished unsuccessfully. Inspect output.stderr/output.stdout and full output files before deciding whether to rerun.")
  } else if (task.status === "cancelled" || task.status === "stale") {
    guidance.push("Task is no longer active. Check reason/status before submitting replacement work.")
  }

  if (output?.truncated) {
    guidance.push(`Output is truncated inline. Read stdoutPath=${output.stdoutPath} and stderrPath=${output.stderrPath} for full logs.`)
  }

  return guidance
}

export function guidanceForWaitResult(task: ScheduledTask, waitTimedOut: boolean, output?: TaskOutputResult): string[] {
  if (waitTimedOut) {
    return [
      "Wait timed out, but the task is still registered. Do not rerun the command; call ssh_exec_status or ssh_wait_task again with the same taskId.",
    ]
  }
  return guidanceForTaskStatus(task, output)
}

export function mcpEnvelope<T>(
  kind: McpResponseKind,
  data: T,
  agentGuidance: string[] = [],
): McpEnvelope<T> {
  return { ok: true, kind, data, agentGuidance }
}

export function mcpErrorEnvelope(kind: McpResponseKind, error: string, agentGuidance: string[] = []): McpEnvelope<never> {
  return { ok: false, kind, error, agentGuidance }
}

export function scheduleDecisionEnvelope(decision: ScheduleDecision): ScheduleDecisionEnvelope {
  const envelope = mcpEnvelope("schedule_decision", decision, guidanceForScheduleDecision(decision))
  return {
    ...decision,
    ...envelope,
  }
}

export function jsonText(data: unknown): string {
  return JSON.stringify(data, null, 2)
}
