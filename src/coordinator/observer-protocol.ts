import type { ObservedProcess, ObservedSession } from "./protocol.js"

export interface ProcessSample {
  pid: number
  parentPid: number
  uid: number
  username: string
  tty?: string
  sourceAddress?: string
  cwd?: string
  command: string
  startTime?: number
}

export interface SessionSample {
  sessionId: string
  uid: number
  username: string
  tty?: string
  sourceAddress?: string
  loginAt?: number
}

export const MAX_OBSERVED_COMMAND_BYTES = 16 * 1024
export const MAX_OBSERVED_PROCESSES = 2000

export function classifyProcess(command: string): ObservedProcess["riskKind"] {
  const value = command.toLowerCase()
  if (/\b(systemctl|service)\b/.test(value)) return "service"
  if (/\b(docker|podman|kubectl)\b/.test(value)) return "service"
  if (/\b(git|vim|vi|nvim|emacs|sed -i|perl -i)\b/.test(value)) return "write"
  if (/\b(npm|pnpm|yarn|bun|make|cmake|cargo|mvn|gradle|go build|tsc|webpack|vite)\b/.test(value)) return "build"
  if (/\b(pytest|jest|mocha|vitest|go test|cargo test)\b/.test(value)) return "build"
  if (/\b(tar|rsync|scp|sftp)\b/.test(value)) return "transfer"
  return "read"
}

export function toObservedProcess(sample: ProcessSample, now = Date.now()): ObservedProcess {
  const raw = sample.command
  const bytes = Buffer.from(raw, "utf8")
  const commandTruncated = bytes.length > MAX_OBSERVED_COMMAND_BYTES
  const command = commandTruncated ? bytes.subarray(0, MAX_OBSERVED_COMMAND_BYTES).toString("utf8") : raw
  return {
    observationId: `${sample.pid}:${sample.startTime ?? now}`,
    pid: sample.pid,
    parentPid: sample.parentPid,
    uid: sample.uid,
    username: sample.username,
    tty: sample.tty,
    sourceAddress: sample.sourceAddress,
    cwd: sample.cwd,
    command,
    commandTruncated,
    riskKind: classifyProcess(command),
    firstSeenAt: now,
    lastSeenAt: now,
    source: "process-observer",
    confidence: "low",
  }
}

export function toObservedSession(sample: SessionSample, now = Date.now()): ObservedSession {
  return { ...sample, firstSeenAt: now, lastSeenAt: now }
}
