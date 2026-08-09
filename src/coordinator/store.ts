import { createHash, randomUUID } from "crypto"
import { DatabaseSync } from "node:sqlite"
import { normalizeWorkspace, workspacesOverlap } from "./workspace.js"
import type {
  ClientIdentity,
  CoordinationConflict,
  CoordinatorSource,
  ObservedProcess,
  ObservedSession,
  TaskIntent,
  TaskOutcome,
} from "./protocol.js"

export interface BeginTaskResult {
  taskId: string
  leaseToken: string
  conflicts: CoordinationConflict[]
  observed: ActiveObservedActivity[]
  startedAt: number
  expiresAt: number
}

export interface StoreIdentity {
  peerUid?: number
  peerUsername?: string
  identityTrust: "peer-uid" | "self-asserted"
}

export interface ActiveObservedActivity {
  source: "session-observer" | "process-observer"
  confidence: "low"
  uid: number
  username: string
  workspace?: string
  command?: string
  riskKind?: string
  pid?: number
  tty?: string
  sourceAddress?: string
  firstSeenAt: number
  lastSeenAt: number
  commandTruncated?: boolean
}

const SCHEMA_VERSION = 2
const OBSERVED_RETENTION_MS = 24 * 60 * 60 * 1000

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

function json(value: unknown): string {
  return JSON.stringify(value)
}

export class CoordinatorStore {
  private db: DatabaseSync

  constructor(dbPath = ":memory:") {
    this.db = new DatabaseSync(dbPath)
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec("PRAGMA foreign_keys = ON")
    this.migrate()
  }

  private migrate(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)")
    const current = Number(this.db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get()?.version ?? 0)
    if (current < 1) {
      this.db.exec(`
        CREATE TABLE clients (
          client_id TEXT PRIMARY KEY,
          installation_id TEXT NOT NULL,
          operator_label TEXT NOT NULL,
          ssh_user TEXT NOT NULL,
          tool_version TEXT NOT NULL,
          last_seen_at INTEGER NOT NULL
        );
        CREATE TABLE leases (
          task_id TEXT PRIMARY KEY,
          client_id TEXT NOT NULL,
          workspace TEXT NOT NULL,
          kind TEXT NOT NULL,
          summary TEXT NOT NULL,
          ttl_ms INTEGER NOT NULL,
          lease_token_hash TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          outcome TEXT,
          source TEXT NOT NULL,
          peer_uid INTEGER,
          peer_username TEXT,
          identity_trust TEXT NOT NULL
        );
        CREATE INDEX leases_expiry_idx ON leases(expires_at);
        CREATE INDEX leases_workspace_idx ON leases(workspace);
        CREATE INDEX leases_client_idx ON leases(client_id);
        CREATE TABLE audit_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_type TEXT NOT NULL,
          task_id TEXT,
          client_id TEXT,
          peer_uid INTEGER,
          peer_username TEXT,
          payload_json TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX audit_events_created_idx ON audit_events(created_at);
      `)
      this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(1, Date.now())
    }
    if (current < 2) {
      this.db.exec(`
        CREATE TABLE observed_sessions (
          session_id TEXT PRIMARY KEY,
          uid INTEGER NOT NULL,
          username TEXT NOT NULL,
          tty TEXT,
          source_address TEXT,
          login_at INTEGER,
          first_seen_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          absent_scans INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE observed_processes (
          observation_id TEXT PRIMARY KEY,
          pid INTEGER NOT NULL,
          parent_pid INTEGER NOT NULL,
          uid INTEGER NOT NULL,
          username TEXT NOT NULL,
          tty TEXT,
          source_address TEXT,
          cwd TEXT,
          command TEXT NOT NULL,
          command_truncated INTEGER NOT NULL,
          risk_kind TEXT NOT NULL,
          first_seen_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          absent_scans INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE observed_process_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          observation_id TEXT NOT NULL,
          pid INTEGER NOT NULL,
          uid INTEGER NOT NULL,
          username TEXT NOT NULL,
          cwd TEXT,
          command TEXT NOT NULL,
          command_truncated INTEGER NOT NULL,
          risk_kind TEXT NOT NULL,
          observed_at INTEGER NOT NULL
        );
        CREATE INDEX observed_process_history_time_idx ON observed_process_history(observed_at);
        CREATE INDEX observed_processes_pid_idx ON observed_processes(pid);
      `)
      this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(2, Date.now())
    }
  }

  registerClient(client: ClientIdentity, now = Date.now()): void {
    this.db.prepare(`
      INSERT INTO clients(client_id, installation_id, operator_label, ssh_user, tool_version, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(client_id) DO UPDATE SET
        installation_id=excluded.installation_id,
        operator_label=excluded.operator_label,
        ssh_user=excluded.ssh_user,
        tool_version=excluded.tool_version,
        last_seen_at=excluded.last_seen_at
    `).run(client.clientId, client.installationId, client.operatorLabel, client.sshUser, client.toolVersion, now)
  }

  beginTask(task: TaskIntent, identity: StoreIdentity, now = Date.now()): BeginTaskResult {
    const workspace = normalizeWorkspace(task.workspace)
    this.cleanupExpired(now)
    const rows = this.db.prepare(`
      SELECT l.*, c.operator_label
      FROM leases l LEFT JOIN clients c ON c.client_id = l.client_id
      WHERE l.outcome IS NULL AND l.expires_at > ?
    `).all(now) as Array<Record<string, unknown>>
    const conflicts: CoordinationConflict[] = rows
      .filter((row) => task.kind !== "read" && row.kind !== "read" && workspacesOverlap(workspace, String(row.workspace)))
      .map((row) => ({
        taskId: String(row.task_id),
        workspace: String(row.workspace),
        kind: String(row.kind) as CoordinationConflict["kind"],
        operatorLabel: String(row.operator_label ?? row.client_id),
        startedAt: Number(row.started_at),
        expiresAt: Number(row.expires_at),
        identityTrust: String(row.identity_trust) as CoordinationConflict["identityTrust"],
        source: String(row.source) as CoordinatorSource,
        confidence: "high",
      }))
    const taskId = randomUUID()
    const leaseToken = randomUUID() + randomUUID()
    const expiresAt = now + task.ttlMs
    this.db.prepare(`
      INSERT INTO leases(task_id, client_id, workspace, kind, summary, ttl_ms, lease_token_hash, started_at, expires_at, source, peer_uid, peer_username, identity_trust)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(taskId, task.clientId, workspace, task.kind, task.summary, task.ttlMs, tokenHash(leaseToken), now, expiresAt, task.source ?? "ssh-tool", identity.peerUid ?? null, identity.peerUsername ?? null, identity.identityTrust)
    const observed = task.kind === "read" ? [] : this.listObserved(workspace, now)
    this.recordAudit("begin", taskId, task.clientId, identity, { workspace, kind: task.kind, source: task.source ?? "ssh-tool", conflictCount: conflicts.length, observedCount: observed.length }, now)
    return { taskId, leaseToken, conflicts, observed, startedAt: now, expiresAt }
  }

  heartbeat(taskId: string, leaseToken: string, now = Date.now()): void {
    const row = this.db.prepare("SELECT expires_at, lease_token_hash, outcome FROM leases WHERE task_id = ?").get(taskId) as Record<string, unknown> | undefined
    if (!row || row.outcome !== null || Number(row.expires_at) <= now) throw new Error("LEASE_EXPIRED: lease is no longer active")
    if (row.lease_token_hash !== tokenHash(leaseToken)) throw new Error("LEASE_TOKEN_MISMATCH: invalid lease token")
    const ttl = Number(this.db.prepare("SELECT ttl_ms FROM leases WHERE task_id = ?").get(taskId)?.ttl_ms ?? 120_000)
    this.db.prepare("UPDATE leases SET expires_at = ? WHERE task_id = ?").run(now + ttl, taskId)
  }

  finishTask(taskId: string, leaseToken: string, outcome: TaskOutcome, now = Date.now()): void {
    const row = this.db.prepare("SELECT lease_token_hash, outcome, expires_at, client_id, peer_uid, peer_username, identity_trust FROM leases WHERE task_id = ?").get(taskId) as Record<string, unknown> | undefined
    if (!row || row.outcome !== null || Number(row.expires_at) <= now) throw new Error("LEASE_EXPIRED: lease is no longer active")
    if (row.lease_token_hash !== tokenHash(leaseToken)) throw new Error("LEASE_TOKEN_MISMATCH: invalid lease token")
    this.db.prepare("UPDATE leases SET outcome = ?, expires_at = ? WHERE task_id = ?").run(outcome, now, taskId)
    this.recordAudit("finish", taskId, String(row.client_id), { peerUid: row.peer_uid === null ? undefined : Number(row.peer_uid), peerUsername: row.peer_username === null ? undefined : String(row.peer_username), identityTrust: String(row.identity_trust) as StoreIdentity["identityTrust"] }, { outcome }, now)
  }

  listActive(workspace?: string, now = Date.now()): CoordinationConflict[] {
    this.cleanupExpired(now)
    const normalized = workspace === undefined ? undefined : normalizeWorkspace(workspace)
    const rows = this.db.prepare(`
      SELECT l.*, c.operator_label FROM leases l LEFT JOIN clients c ON c.client_id = l.client_id
      WHERE l.outcome IS NULL AND l.expires_at > ?
    `).all(now) as Array<Record<string, unknown>>
    return rows.filter((row) => normalized === undefined || workspacesOverlap(normalized, String(row.workspace))).map((row) => ({
      taskId: String(row.task_id), workspace: String(row.workspace), kind: String(row.kind) as CoordinationConflict["kind"], operatorLabel: String(row.operator_label ?? row.client_id), startedAt: Number(row.started_at), expiresAt: Number(row.expires_at), identityTrust: String(row.identity_trust) as CoordinationConflict["identityTrust"], source: String(row.source) as CoordinatorSource, confidence: "high",
    }))
  }

  submitObservations(sessions: ObservedSession[], processes: ObservedProcess[], now = Date.now()): void {
    this.db.exec("BEGIN")
    try {
      const sessionIds = new Set(sessions.map((session) => session.sessionId))
      const processIds = new Set(processes.map((process) => process.observationId))
      for (const session of sessions) {
        const old = this.db.prepare("SELECT first_seen_at FROM observed_sessions WHERE session_id = ?").get(session.sessionId) as Record<string, unknown> | undefined
        const firstSeenAt = old?.first_seen_at === undefined ? session.firstSeenAt : Number(old.first_seen_at)
        this.db.prepare(`INSERT INTO observed_sessions(session_id, uid, username, tty, source_address, login_at, first_seen_at, last_seen_at, absent_scans) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0) ON CONFLICT(session_id) DO UPDATE SET uid=excluded.uid, username=excluded.username, tty=excluded.tty, source_address=excluded.source_address, login_at=excluded.login_at, last_seen_at=excluded.last_seen_at, absent_scans=0`).run(session.sessionId, session.uid, session.username, session.tty ?? null, session.sourceAddress ?? null, session.loginAt ?? null, firstSeenAt, now)
      }
      for (const process of processes) {
        const old = this.db.prepare("SELECT first_seen_at FROM observed_processes WHERE observation_id = ?").get(process.observationId) as Record<string, unknown> | undefined
        const firstSeenAt = old?.first_seen_at === undefined ? process.firstSeenAt : Number(old.first_seen_at)
        this.db.prepare(`INSERT INTO observed_processes(observation_id, pid, parent_pid, uid, username, tty, source_address, cwd, command, command_truncated, risk_kind, first_seen_at, last_seen_at, absent_scans) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0) ON CONFLICT(observation_id) DO UPDATE SET pid=excluded.pid, parent_pid=excluded.parent_pid, uid=excluded.uid, username=excluded.username, tty=excluded.tty, source_address=excluded.source_address, cwd=excluded.cwd, command=excluded.command, command_truncated=excluded.command_truncated, risk_kind=excluded.risk_kind, last_seen_at=excluded.last_seen_at, absent_scans=0`).run(process.observationId, process.pid, process.parentPid, process.uid, process.username, process.tty ?? null, process.sourceAddress ?? null, process.cwd ?? null, process.command, process.commandTruncated ? 1 : 0, process.riskKind, firstSeenAt, now)
        this.db.prepare("INSERT INTO observed_process_history(observation_id, pid, uid, username, cwd, command, command_truncated, risk_kind, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(process.observationId, process.pid, process.uid, process.username, process.cwd ?? null, process.command, process.commandTruncated ? 1 : 0, process.riskKind, now)
      }
      this.db.prepare("UPDATE observed_sessions SET absent_scans = absent_scans + 1 WHERE last_seen_at < ?").run(now)
      this.db.prepare("UPDATE observed_processes SET absent_scans = absent_scans + 1 WHERE last_seen_at < ?").run(now)
      this.db.prepare("DELETE FROM observed_sessions WHERE absent_scans >= 2").run()
      this.db.prepare("DELETE FROM observed_processes WHERE absent_scans >= 2").run()
      this.db.prepare("DELETE FROM observed_process_history WHERE observed_at < ?").run(now - OBSERVED_RETENTION_MS)
      this.db.exec("COMMIT")
      void sessionIds
      void processIds
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  listObserved(workspace?: string, now = Date.now()): ActiveObservedActivity[] {
    this.db.prepare("DELETE FROM observed_process_history WHERE observed_at < ?").run(now - OBSERVED_RETENTION_MS)
    const rows = this.db.prepare("SELECT * FROM observed_processes WHERE absent_scans < 2").all() as Array<Record<string, unknown>>
    return rows.filter((row) => workspace === undefined || row.cwd === null || workspacesOverlap(normalizeWorkspace(workspace), String(row.cwd))).map((row) => ({ source: "process-observer", confidence: "low", uid: Number(row.uid), username: String(row.username), workspace: row.cwd === null ? undefined : String(row.cwd), command: String(row.command), riskKind: String(row.risk_kind), pid: Number(row.pid), tty: row.tty === null ? undefined : String(row.tty), sourceAddress: row.source_address === null ? undefined : String(row.source_address), firstSeenAt: Number(row.first_seen_at), lastSeenAt: Number(row.last_seen_at), commandTruncated: Boolean(row.command_truncated) }))
  }

  cleanupExpired(now = Date.now()): void {
    this.db.prepare("UPDATE leases SET outcome = 'expired', expires_at = ? WHERE outcome IS NULL AND expires_at <= ?").run(now, now)
    this.db.prepare("DELETE FROM observed_process_history WHERE observed_at < ?").run(now - OBSERVED_RETENTION_MS)
  }

  recordAudit(eventType: string, taskId: string | undefined, clientId: string | undefined, identity: StoreIdentity, payload: Record<string, unknown>, now = Date.now()): void {
    this.db.prepare("INSERT INTO audit_events(event_type, task_id, client_id, peer_uid, peer_username, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(eventType, taskId ?? null, clientId ?? null, identity.peerUid ?? null, identity.peerUsername ?? null, json(payload), now)
  }

  close(): void {
    this.db.close()
  }
}
