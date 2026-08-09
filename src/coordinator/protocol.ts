import { randomUUID } from "crypto"

export const COORDINATOR_PROTOCOL_VERSION = 1
export const MAX_WORKSPACE_BYTES = 4096
export const MAX_SUMMARY_BYTES = 512
export const MAX_LABEL_BYTES = 128
export const MIN_TTL_MS = 30_000
export const MAX_TTL_MS = 24 * 60 * 60 * 1000

export type CoordinatorSource = "ssh-tool" | "session-observer" | "process-observer" | "manual" | "ci"
export type ActivityConfidence = "high" | "medium" | "low"
export type TaskKind = "read" | "write" | "build" | "service" | "transfer"
export type TaskOutcome = "success" | "failed" | "cancelled"

export interface ClientIdentity {
  clientId: string
  installationId: string
  operatorLabel: string
  sshUser: string
  toolVersion: string
}

export interface TaskIntent {
  clientId: string
  workspace: string
  kind: TaskKind
  summary: string
  ttlMs: number
  pid?: number
  source?: CoordinatorSource
}

export interface CoordinationConflict {
  taskId: string
  workspace: string
  kind: Exclude<TaskKind, "read">
  operatorLabel: string
  startedAt: number
  expiresAt: number
  identityTrust: "peer-uid" | "self-asserted"
  source: CoordinatorSource
  confidence: ActivityConfidence
  command?: string
}

export interface ObservedSession {
  sessionId: string
  uid: number
  username: string
  tty?: string
  sourceAddress?: string
  loginAt?: number
  firstSeenAt: number
  lastSeenAt: number
}

export interface ObservedProcess {
  observationId: string
  pid: number
  parentPid: number
  uid: number
  username: string
  tty?: string
  sourceAddress?: string
  cwd?: string
  command: string
  commandTruncated: boolean
  riskKind: Exclude<TaskKind, "read"> | "read"
  firstSeenAt: number
  lastSeenAt: number
  source: "process-observer"
  confidence: "low"
}

export type CoordinatorRequest =
  | { action: "health"; protocolVersion: number }
  | { action: "registerClient"; protocolVersion: number; client: ClientIdentity }
  | { action: "beginTask"; protocolVersion: number; task: TaskIntent; force?: boolean }
  | { action: "heartbeat"; protocolVersion: number; taskId: string; leaseToken: string }
  | { action: "finishTask"; protocolVersion: number; taskId: string; leaseToken: string; outcome: TaskOutcome }
  | { action: "listActive"; protocolVersion: number; workspace?: string }
  | { action: "submitObservation"; protocolVersion: number; sessions: ObservedSession[]; processes: ObservedProcess[] }
  | { action: "announceTask"; protocolVersion: number; task: TaskIntent; source: "manual" | "ci" }

export interface CoordinatorSuccess<T = unknown> {
  ok: true
  data: T
}

export interface CoordinatorFailure {
  ok: false
  errorCode: string
  message: string
}

export type CoordinatorResponse<T = unknown> = CoordinatorSuccess<T> | CoordinatorFailure

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TASK_KINDS = new Set<TaskKind>(["read", "write", "build", "service", "transfer"])

const CoordinatorRequestActionValues = [
  "health",
  "registerClient",
  "beginTask",
  "heartbeat",
  "finishTask",
  "listActive",
  "submitObservation",
  "announceTask",
] as const

const ACTIONS = new Set(CoordinatorRequestActionValues)
type Action = typeof CoordinatorRequestActionValues[number]

function stringField(value: unknown, name: string, maxBytes: number, required = true): string | undefined {
  if (value === undefined && !required) return undefined
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > maxBytes) {
    throw new Error(`INVALID_REQUEST: invalid ${name}`)
  }
  return value
}

function uuidField(value: unknown, name: string): string {
  const result = stringField(value, name, 128)
  if (!result || !UUID_RE.test(result)) throw new Error(`INVALID_REQUEST: invalid ${name}`)
  return result
}

function validateClient(value: unknown): ClientIdentity {
  if (!value || typeof value !== "object") throw new Error("INVALID_REQUEST: invalid client")
  const client = value as Record<string, unknown>
  return {
    clientId: uuidField(client.clientId, "clientId"),
    installationId: uuidField(client.installationId, "installationId"),
    operatorLabel: stringField(client.operatorLabel, "operatorLabel", MAX_LABEL_BYTES)!,
    sshUser: stringField(client.sshUser, "sshUser", MAX_LABEL_BYTES)!,
    toolVersion: stringField(client.toolVersion, "toolVersion", MAX_LABEL_BYTES)!,
  }
}

function validateTask(value: unknown): TaskIntent {
  if (!value || typeof value !== "object") throw new Error("INVALID_REQUEST: invalid task")
  const task = value as Record<string, unknown>
  const kind = task.kind
  if (typeof kind !== "string" || !TASK_KINDS.has(kind as TaskKind)) throw new Error("INVALID_REQUEST: invalid task kind")
  const ttlMs = task.ttlMs
  if (typeof ttlMs !== "number" || !Number.isInteger(ttlMs) || ttlMs < MIN_TTL_MS || ttlMs > MAX_TTL_MS) {
    throw new Error("INVALID_REQUEST: invalid ttlMs")
  }
  const pid = task.pid
  if (pid !== undefined && (typeof pid !== "number" || !Number.isInteger(pid) || pid < 1)) {
    throw new Error("INVALID_REQUEST: invalid pid")
  }
  const source = task.source
  if (source !== undefined && !["ssh-tool", "session-observer", "process-observer", "manual", "ci"].includes(String(source))) {
    throw new Error("INVALID_REQUEST: invalid source")
  }
  return {
    clientId: uuidField(task.clientId, "clientId"),
    workspace: stringField(task.workspace, "workspace", MAX_WORKSPACE_BYTES)!,
    kind: kind as TaskKind,
    summary: stringField(task.summary, "summary", MAX_SUMMARY_BYTES)!,
    ttlMs,
    ...(pid === undefined ? {} : { pid }),
    ...(source === undefined ? {} : { source: source as CoordinatorSource }),
  }
}

export function parseCoordinatorRequest(line: string): CoordinatorRequest {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    throw new Error("INVALID_REQUEST: malformed JSON")
  }
  if (!value || typeof value !== "object") throw new Error("INVALID_REQUEST: request must be an object")
  const request = value as Record<string, unknown>
  const actionValue = request.action
  if (typeof actionValue !== "string" || !ACTIONS.has(actionValue as Action)) throw new Error("INVALID_REQUEST: unknown action")
  const action = actionValue as Action
  if (request.protocolVersion !== COORDINATOR_PROTOCOL_VERSION) throw new Error("PROTOCOL_VERSION_UNSUPPORTED: unsupported protocol version")

  switch (action) {
    case "health":
      return { action, protocolVersion: COORDINATOR_PROTOCOL_VERSION }
    case "registerClient":
      return { action, protocolVersion: COORDINATOR_PROTOCOL_VERSION, client: validateClient(request.client) }
    case "beginTask":
    case "announceTask": {
      const task = validateTask(request.task)
      const force = request.force
      if (force !== undefined && typeof force !== "boolean") throw new Error("INVALID_REQUEST: invalid force")
      if (action === "announceTask" && request.source !== "manual" && request.source !== "ci") {
        throw new Error("INVALID_REQUEST: invalid announcement source")
      }
      return action === "beginTask"
        ? { action, protocolVersion: COORDINATOR_PROTOCOL_VERSION, task, ...(force === undefined ? {} : { force }) }
        : { action, protocolVersion: COORDINATOR_PROTOCOL_VERSION, task, source: request.source as "manual" | "ci" }
    }
    case "heartbeat":
      return {
        action,
        protocolVersion: COORDINATOR_PROTOCOL_VERSION,
        taskId: uuidField(request.taskId, "taskId"),
        leaseToken: stringField(request.leaseToken, "leaseToken", 256)!,
      }
    case "finishTask":
      if (!["success", "failed", "cancelled"].includes(String(request.outcome))) throw new Error("INVALID_REQUEST: invalid outcome")
      return {
        action,
        protocolVersion: COORDINATOR_PROTOCOL_VERSION,
        taskId: uuidField(request.taskId, "taskId"),
        leaseToken: stringField(request.leaseToken, "leaseToken", 256)!,
        outcome: request.outcome as TaskOutcome,
      }
    case "listActive":
      return {
        action,
        protocolVersion: COORDINATOR_PROTOCOL_VERSION,
        ...(request.workspace === undefined ? {} : { workspace: stringField(request.workspace, "workspace", MAX_WORKSPACE_BYTES)! }),
      }
    case "submitObservation":
      if (!Array.isArray(request.sessions) || !Array.isArray(request.processes)) throw new Error("INVALID_REQUEST: invalid observations")
      return { action, protocolVersion: COORDINATOR_PROTOCOL_VERSION, sessions: request.sessions as ObservedSession[], processes: request.processes as ObservedProcess[] }
  }
}

export function createClientIdentity(operatorLabel: string, sshUser: string, toolVersion: string): ClientIdentity {
  return { clientId: randomUUID(), installationId: randomUUID(), operatorLabel, sshUser, toolVersion }
}
