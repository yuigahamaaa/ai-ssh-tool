import type { CwdSource, CwdState, ScheduleDecision, ScheduledTask, TaskOutputResult } from "./scheduler/types.js"

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
  | "transfer_result"
  | "file_result"
  | "profile_result"
  | "session_result"
  | "forward_result"
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

export interface TransferGuidancePayload {
  success: boolean
  path: string
  finalPath?: string
  requestedPath?: string
  sourcePath?: string
  action?: string
  targetType?: string
  size: number
  sourceBytes?: number
  bytesTransferred?: number
  checksum?: {
    algorithm?: string
    source?: string
    destination?: string
  }
  verification?: {
    sizeMatched?: boolean
    checksumMatched?: boolean
  }
  error?: string
}

export interface CwdStateInput {
  effectiveCwd?: string
  virtualCwd?: string
  source?: CwdSource
}

export function makeCwdState(input: CwdStateInput): CwdState {
  return {
    effectiveCwd: input.effectiveCwd ?? null,
    virtualCwd: input.virtualCwd ?? null,
    source: input.source ?? "none",
  }
}

function looksLongRunning(taskLike: { command?: string; classification?: { intent?: string } }): boolean {
  const command = taskLike.command ?? ""
  if (taskLike.classification?.intent === "server") return true
  return /\b(npm|pnpm|yarn|bun)\s+run\s+(dev|start|serve|watch)\b/.test(command)
    || /\b(vite|next\s+dev|webpack-dev-server|nodemon|pm2|forever)\b/.test(command)
    || /\b(tail\s+-f|journalctl\s+-f|docker\s+logs\s+-f)\b/.test(command)
}

export function guidanceForScheduleDecision(decision: ScheduleDecision): string[] {
  const guidance: string[] = []

  if (decision.action === "queued") {
    guidance.push("Task was queued. Do not immediately resubmit the same command. Continue unrelated read/search/planning work, then call ssh_queue_status or ssh_wait_task with this taskId.")
  } else if (decision.waitTimedOut) {
    guidance.push("The foreground wait timed out but the task is still registered. Use ssh_exec_status with taskId to check status/output instead of rerunning the command.")
    if (looksLongRunning(decision)) {
      guidance.push("This looks like a long-running server/watch/log command. For future runs, start it with ssh_exec_background first, then monitor it with ssh_exec_status.")
    }
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

  if (decision.cwdState?.source === "virtual") {
    guidance.push("Command used this AI session's default cwd. If unsure, call ssh_get_cwd or pass cwd explicitly.")
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

  if (task.cwdSource === "virtual") {
    guidance.push("This task is using this AI session's default cwd. If unsure, call ssh_get_cwd or pass cwd explicitly.")
  }

  return guidance
}

export function guidanceForWaitResult(task: ScheduledTask, waitTimedOut: boolean, output?: TaskOutputResult): string[] {
  if (waitTimedOut) {
    const guidance = [
      "Wait timed out, but the task is still registered. Do not rerun the command; call ssh_exec_status or ssh_wait_task again with the same taskId.",
    ]
    if (looksLongRunning(task)) {
      guidance.push("This looks like a long-running server/watch/log command. For future runs, start it with ssh_exec_background first, then monitor it with ssh_exec_status.")
    }
    return guidance
  }
  return guidanceForTaskStatus(task, output)
}

export function guidanceForTransferResult(direction: "upload" | "download", result: TransferGuidancePayload): string[] {
  if (!result.success) {
    return [
      `${direction === "upload" ? "Upload" : "Download"} failed: ${result.error ?? "unknown error"}. Inspect the error and adjust paths/options first.`,
      "Do not retry with manual shell/base64 unless the user explicitly asks; ssh_upload/ssh_download are the binary-safe transfer path.",
    ]
  }

  const finalPath = result.finalPath ?? result.path
  const action = result.action ?? (direction === "upload" ? "uploaded" : "downloaded")
  const guidance = [
    `${direction === "upload" ? "Upload" : "Download"} ${action}. Final ${direction === "upload" ? "remote" : "local"} path: ${finalPath}.`,
  ]

  if (result.requestedPath && result.requestedPath !== finalPath) {
    guidance.push(`Requested destination was ${result.requestedPath}; use finalPath for follow-up operations.`)
  }

  if (result.bytesTransferred !== undefined || result.sourceBytes !== undefined) {
    guidance.push(`Transferred ${result.bytesTransferred ?? result.size} bytes from ${result.sourceBytes ?? result.size} source bytes.`)
  }

  if (result.verification?.sizeMatched === true) {
    guidance.push("Size verification passed.")
  } else if (result.verification?.sizeMatched === false) {
    guidance.push("Size verification did not match; inspect the transfer result before using the file.")
  }

  const checksum = result.checksum?.destination ?? result.checksum?.source
  if (checksum && result.checksum?.algorithm) {
    guidance.push(`${result.checksum.algorithm} checksum: ${checksum}.`)
  }

  guidance.push("This transfer path is binary-safe and lossless; do not use shell/base64 as a workaround.")
  return guidance
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
