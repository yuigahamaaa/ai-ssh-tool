# Remote SSH Coordination Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional, gracefully-degrading remote coordinator service that lets independent SSH Tool clients register active workspace work and warn AI users about possible conflicts on one shared Linux VM.

**Architecture:** Build a standalone coordinator server and Unix-socket protocol under `src/coordinator/`. The local SSH daemon invokes a small remote helper over the existing SSH connection; the helper talks to the coordinator socket. The coordinator stores short-lived leases and audit records in SQLite, while the existing SSH execution path remains authoritative and never depends on the coordinator for command execution.

**Tech Stack:** TypeScript 5, Node.js ESM, `node:net` Unix sockets, `node:sqlite`/the repository-supported SQLite option after dependency verification, `node:test`, ssh2, systemd unit templates, SHA-256 and Ed25519 verification.

---

## Scope and file map

The implementation is split into independently testable units:

- `src/coordinator/protocol.ts`: request/response types, validation, line-delimited JSON framing, stable error codes.
- `src/coordinator/workspace.ts`: absolute-path normalization and path-boundary overlap checks.
- `src/coordinator/store.ts`: SQLite schema, migrations, clients, leases, audit events, TTL cleanup.
- `src/coordinator/server.ts`: Unix-socket server, peer UID identity, request dispatch, graceful shutdown.
- `src/coordinator/client.ts`: local client protocol implementation and bounded request timeout.
- `src/coordinator/installer.ts`: remote probe, signed artifact verification, deployment lock, atomic release switch, health check, rollback.
- `src/coordinator/artifact-manifest.ts`: version/platform manifest and verification primitives.
- `src/coordinator/systemd/ssh-tool-coordinator.service`: least-privilege service template.
- `src/__tests__/coordinator-*.test.ts`: unit and socket tests using temporary directories and fake peer identity where possible.
- `src/daemon.ts`: expose coordinator-aware task lifecycle at the existing SSH daemon integration boundary.
- `src/file-transfer.ts`, `src/remote-shell.ts`, `src/scheduler/scheduler-service.ts`: add lifecycle hooks only where existing task start/finish/cancel paths are already centralized; do not duplicate command execution.
- `src/mcp-server.ts`, `src/cli/ssh-exec.ts`: preserve existing result shapes while exposing optional coordination metadata and explicit force/confirmation input.
- `src/types.ts` or `src/scheduler/types.ts`: additive coordination metadata and task intent types.
- `package.json`, `package-lock.json`: add only a SQLite dependency if the existing Node runtime cannot provide the required SQLite API; verify before editing.

No changes may add a public TCP listener, save SSH credentials, or make coordinator availability a prerequisite for SSH execution.

## Shared command convention

Use the complete Node path in every command:

```bash
export PATH=/Users/wanghaizhi/.nvm/versions/node/v22.22.3/bin:/bin:/usr/bin:$PATH
```

Build and focused tests:

```bash
npm run build:test
node --test --test-force-exit dist/__tests__/<test>.test.js
```

Required final checks:

```bash
npm run build
npm run test:fast
git diff --check
git status --short
```

---

### Task 1: Verify runtime SQLite and establish protocol types

**Files:**
- Inspect: `package.json`, `package-lock.json`, `tsconfig.json`.
- Create: `src/coordinator/protocol.ts`.
- Create: `src/__tests__/coordinator-protocol.test.ts`.

- [ ] **Step 1: Verify available SQLite implementation**

Run:

```bash
node -e 'try { const s = require("node:sqlite"); console.log("node:sqlite available", Object.keys(s)); } catch (e) { console.log("node:sqlite unavailable", e.code); }'
```

If unavailable, inspect installed dependencies and add the smallest existing-compatible SQLite package. Do not invent a dependency before checking `package.json` and `package-lock.json`.

- [ ] **Step 2: Write failing protocol tests**

Cover valid `health`, `registerClient`, `beginTask`, `heartbeat`, `finishTask`, and `listActive`; reject unknown actions, missing `protocolVersion`, invalid task kinds, overlong summaries, invalid TTL, and malformed JSON lines. Assert stable error codes `INVALID_REQUEST` and `PROTOCOL_VERSION_UNSUPPORTED`.

- [ ] **Step 3: Implement protocol types and validation**

Export `CoordinatorRequest`, `CoordinatorResponse`, `ClientIdentity`, `TaskIntent`, `CoordinationConflict`, and `parseCoordinatorRequest(line)`. Use the repository's existing validation library if suitable; otherwise use explicit type guards. Enforce bounded fields: UUID-like client/task identifiers, workspace max 4096 bytes, summary max 512 bytes, labels max 128 bytes, and TTL range 30 seconds to 24 hours.

- [ ] **Step 4: Run focused tests**

Run the build and protocol test. Expected: all protocol cases pass.

- [ ] **Step 5: Commit**

```bash
git add src/coordinator/protocol.ts src/__tests__/coordinator-protocol.test.ts package.json package-lock.json
git commit -m "feat: add remote coordinator protocol contract"
```

---

### Task 2: Implement workspace normalization and overlap rules

**Files:**
- Create: `src/coordinator/workspace.ts`.
- Create: `src/__tests__/coordinator-workspace.test.ts`.

- [ ] **Step 1: Write failing workspace tests**

Test that `/srv/app` overlaps `/srv/app/api`, identical paths overlap, `/srv/app` does not overlap `/srv/application`, relative paths are rejected or resolved only when an explicit base is provided, and trailing slashes do not change results.

- [ ] **Step 2: Implement pure helpers**

Export `normalizeWorkspace(path: string): string` and `workspacesOverlap(a: string, b: string): boolean`. Require absolute POSIX paths, normalize `.` and duplicate separators, reject empty paths and paths that normalize above `/`, and compare using `a === b || a.startsWith(b + "/") || b.startsWith(a + "/")`.

- [ ] **Step 3: Run tests and commit**

```bash
npm run build:test && node --test --test-force-exit dist/__tests__/coordinator-workspace.test.js
git add src/coordinator/workspace.ts src/__tests__/coordinator-workspace.test.ts
git commit -m "feat: add coordinator workspace overlap rules"
```

---

### Task 3: Add SQLite lease store, migrations, and audit retention

**Files:**
- Create: `src/coordinator/store.ts`.
- Create: `src/__tests__/coordinator-store.test.ts`.

- [ ] **Step 1: Write failing store tests**

Test schema initialization, migration versioning, client upsert, `beginTask` returning overlapping active leases, lease token uniqueness, heartbeat rejecting a wrong token, finish changing outcome, expired lease cleanup, restart recovery of unexpired leases, and audit records not containing the full command.

- [ ] **Step 2: Implement schema**

Create tables `schema_migrations`, `clients`, `leases`, and `audit_events`. Store timestamps as integer epoch milliseconds. Store `leaseToken` only as a cryptographically random opaque value or a one-way hash; the API must never accept a client-supplied token as a replacement for the stored token. Add indexes on lease expiry, normalized workspace, client ID, and audit timestamp.

- [ ] **Step 3: Implement transactional operations**

Export `CoordinatorStore` with `registerClient`, `beginTask`, `heartbeat`, `finishTask`, `listActive`, `cleanupExpired`, `recordAudit`, and `close`. Every state transition is transactional. `beginTask` cleans expired leases, queries path-overlapping leases, inserts the new lease, and returns conflicts plus the new token. `heartbeat` and `finishTask` require matching task ID and token hash and return `LEASE_TOKEN_MISMATCH` or `LEASE_EXPIRED` without mutating state.

- [ ] **Step 4: Implement bounded audit data**

Persist peer UID, peer username, client IDs, operator label, workspace, kind, timestamps, outcome, coordinator version, and event type. Strip or reject command strings, environment variables, credentials, and unbounded free text before insertion. Add retention cleanup by age and maximum row count/bytes.

- [ ] **Step 5: Run focused store tests**

```bash
npm run build:test && node --test --test-force-exit dist/__tests__/coordinator-store.test.js
```

Expected: all persistence, transaction, TTL, restart, and audit tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/coordinator/store.ts src/__tests__/coordinator-store.test.ts package.json package-lock.json
git commit -m "feat: persist coordinator leases and audit events"
```

---

### Task 4: Build the Unix-socket coordinator server

**Files:**
- Create: `src/coordinator/server.ts`.
- Create: `src/coordinator/server-main.ts`.
- Create: `src/__tests__/coordinator-server.test.ts`.

- [ ] **Step 1: Write failing socket tests**

Start the server on a temporary Unix socket and test health, client registration, begin/heartbeat/finish, listActive, malformed request rejection, unknown action rejection, request timeout/connection close cleanup, and no TCP listener creation. Test that a second server cannot bind the same socket and stale socket cleanup is safe.

- [ ] **Step 2: Implement server lifecycle**

Export `CoordinatorServer` with `start()`, `stop()`, and `socketPath`. On start, remove only a stale socket that is confirmed to be a Unix socket and not an active listener. On stop, stop accepting new connections, close clients, flush the store, and unlink the socket. Set socket mode/ownership through the configured service options; never make the socket world-writable.

- [ ] **Step 3: Implement request dispatch**

Parse one bounded JSON request per line, derive peer UID using the Node Unix-socket credential API where supported, and dispatch to the store. Responses must be one-line JSON and include stable `ok`, `errorCode`, and `message` fields. Unknown or invalid requests return errors without killing the server. A client disconnect must not leave a server-side operation holding resources.

- [ ] **Step 4: Implement server main entrypoint**

Add signal handling for SIGTERM/SIGINT, configured paths, service version, and database path. The entrypoint must run under systemd without shell interpolation or user-controlled command construction.

- [ ] **Step 5: Run focused tests and commit**

```bash
npm run build:test && node --test --test-force-exit dist/__tests__/coordinator-server.test.js
git add src/coordinator/server.ts src/coordinator/server-main.ts src/__tests__/coordinator-server.test.ts
git commit -m "feat: serve coordinator leases over unix socket"
```

---

### Task 5: Add the remote coordinator client and helper protocol

**Files:**
- Create: `src/coordinator/client.ts`.
- Create: `src/coordinator/remote-helper.ts`.
- Create: `src/__tests__/coordinator-client.test.ts`.
- Modify: `src/remote-shell.ts` only if an existing bounded SSH exec helper is needed; preserve current behavior.

- [ ] **Step 1: Write failing client tests**

Use a fake Unix-socket server and a fake SSH client to test request/response framing, bounded response size, timeout, socket close, malformed response, protocol mismatch, and conversion of coordinator failures into `coordinationUnavailable` results. Assert no credentials or full command text are sent.

- [ ] **Step 2: Implement local protocol client**

Export `RemoteCoordinatorClient` with `health`, `registerClient`, `beginTask`, `heartbeat`, `finishTask`, and `listActive`. It must accept a transport abstraction so unit tests do not need SSH. Each request has a timeout and one retry only for a transient socket/health failure; no retry for token mismatch or invalid request.

- [ ] **Step 3: Implement remote helper**

The helper receives one bounded JSON request on stdin, connects to the local Unix socket, forwards exactly one validated request, prints exactly one response to stdout, and writes diagnostics only to stderr. It must not execute arbitrary request fields as shell code, read the SQLite database, or expose the socket path outside the configured constant/argument validation.

- [ ] **Step 4: Run tests and commit**

```bash
npm run build:test && node --test --test-force-exit dist/__tests__/coordinator-client.test.js
git add src/coordinator/client.ts src/coordinator/remote-helper.ts src/__tests__/coordinator-client.test.ts
git commit -m "feat: add ssh-tunneled coordinator client"
```

---

### Task 6: Integrate task leases without changing SSH execution contracts

**Files:**
- Create: `src/coordinator/task-scope.ts`.
- Modify: `src/daemon.ts` at request dispatch and existing exec/transfer/background lifecycle boundaries.
- Modify: `src/scheduler/scheduler-service.ts` only at existing task start/finish/cancel/dispose hooks.
- Modify: `src/file-transfer.ts` only if a transfer lifecycle callback is required; do not change transfer results.
- Modify: `src/mcp-server.ts`, `src/cli/ssh-exec.ts`, and types with additive coordination metadata.
- Create: `src/__tests__/coordinator-integration.test.ts`.

- [ ] **Step 1: Write failing integration tests**

Test that a write task calls begin before execution and finish after success/failure/cancel; a long task schedules heartbeat and stops it on finish; daemon dispose releases/flushed leases; an active overlapping task produces metadata; a `force` flag records override; and coordinator transport failure leaves the original SSH result successful with `coordinationUnavailable`.

- [ ] **Step 2: Implement `CoordinatorTaskScope`**

Create an idempotent scope that owns one lease token and heartbeat timer. `begin()` returns conflicts and metadata, `finish()` is safe to call once, and `dispose()` best-effort finishes/cancels and clears timers. Use `unref()` for heartbeat timers. Never log full command text.

- [ ] **Step 3: Integrate exec and transfer boundaries**

Use the existing request/task metadata to classify only high-risk operations. Register the normalized remote cwd/workspace before execution, preserve existing IPC/MCP result envelopes, and attach coordination metadata as optional data. Keep reads unregistered or informational. Do not make coordinator availability part of the success/failure decision for the SSH operation.

- [ ] **Step 4: Integrate scheduler lifecycle**

At scheduler task creation/start/finish/cancel and daemon dispose, invoke the scope hooks exactly once. Existing Scheduler locks remain local scheduling controls; coordinator leases are cross-client observation only and must not replace them.

- [ ] **Step 5: Run focused and regression tests**

```bash
npm run build:test && node --test --test-force-exit dist/__tests__/coordinator-integration.test.js
export PATH=/Users/wanghaizhi/.nvm/versions/node/v22.22.3/bin:/bin:/usr/bin:$PATH
```

Then run `npm run test:fast`. Expected: all existing tests pass and coordination tests verify additive behavior.

- [ ] **Step 6: Commit**

```bash
git add src/coordinator/task-scope.ts src/daemon.ts src/scheduler/scheduler-service.ts src/file-transfer.ts src/mcp-server.ts src/cli/ssh-exec.ts src/types.ts src/scheduler/types.ts src/__tests__/coordinator-integration.test.ts
git commit -m "feat: report ssh task leases to remote coordinator"
```

---

### Task 7: Implement signed artifacts, atomic installation, and systemd packaging

**Files:**
- Create: `src/coordinator/artifact-manifest.ts`.
- Create: `src/coordinator/installer.ts`.
- Create: `src/coordinator/systemd/ssh-tool-coordinator.service`.
- Create: `src/__tests__/coordinator-installer.test.ts`.
- Modify: `package.json` only to include coordinator assets in build/package output.

- [ ] **Step 1: Write failing installer tests**

Test platform selection, SHA-256 mismatch rejection, Ed25519 signature mismatch rejection, install lock contention, extraction into a versioned release directory, health-check failure preserving the old `current` link, successful atomic switch, and unsupported systemd/architecture/permissions returning a non-fatal diagnostic.

- [ ] **Step 2: Implement manifest verification**

Export `verifyArtifact(manifest, bytes, publicKey)` and `selectArtifact(platform, arch, manifest)`. Use constant-time comparison for hashes where appropriate, reject unknown algorithms, require exact artifact size/hash, and never execute an artifact before verification.

- [ ] **Step 3: Implement installer state machine**

Export `CoordinatorInstaller` with `probe`, `installIfNeeded`, `upgrade`, and `rollback`. Use a lock file created atomically with exclusive mode. Upload into a private temporary directory, verify again remotely, extract to a new immutable release, start/check candidate, atomically rename the `current` link, and retain the previous release until the new health check succeeds. If anything fails, leave the old release active and return a structured non-fatal result.

- [ ] **Step 4: Add hardened systemd unit**

The unit must run as the dedicated service account, use the fixed socket/data paths, set restrictive filesystem permissions, avoid network listeners, restart on failure, and stop cleanly on SIGTERM. Do not include credentials or user-controlled arguments in the unit.

- [ ] **Step 5: Run installer tests and commit**

```bash
npm run build:test && node --test --test-force-exit dist/__tests__/coordinator-installer.test.js
git add src/coordinator/artifact-manifest.ts src/coordinator/installer.ts src/coordinator/systemd/ssh-tool-coordinator.service src/__tests__/coordinator-installer.test.ts package.json
git commit -m "feat: add verified coordinator installation and rollback"
```

---

### Task 8: Add passive SSH-session and process observation

**Files:**
- Create: `src/coordinator/observer-protocol.ts`.
- Create: `src/coordinator/observer.ts`.
- Create: `src/coordinator/observer-main.ts`.
- Create: `src/coordinator/systemd/ssh-tool-observer.service`.
- Modify: `src/coordinator/protocol.ts`, `src/coordinator/store.ts`, and `src/coordinator/server.ts`.
- Create: `src/__tests__/coordinator-observer.test.ts`.

- [ ] **Step 1: Write failing observer tests**

Test parsing `who`/`w` output into SSH-session snapshots; parsing injected `/proc` fixtures into PID, parent PID, UID, cwd, and complete command-line snapshots; classifying git/build/npm/test/docker/systemctl/editor process risk; marking all observer records with `source: "session-observer" | "process-observer"` and `confidence: "low"`; expiring unseen current snapshots after two 30-second scans; retaining complete command history exactly 24 hours; enforcing max command bytes and max records per scan; and ensuring observer input never contains environment variables, stdin, terminal contents, file contents, or network packets.

- [ ] **Step 2: Implement observer protocol and store tables**

Add an observer-only request action accepted exclusively through a private root-owned Unix socket. Define `ObservedSession`, `ObservedProcess`, and `ObservedActivity` with source, confidence, firstSeenAt, lastSeenAt, and truncation fields. Add `observed_sessions`, `observed_processes`, and `observed_process_history` tables. Current snapshots are upserted transactionally; full command history is deleted after 24 hours; observer data is never mixed with SSH Tool task lease summaries or active-task audit entries.

- [ ] **Step 3: Implement the root observer**

Create `SshToolObserver` with injected session/process readers for unit tests. The production reader runs every 30 seconds, reads only `who`/`w` and permitted `/proc/<pid>` metadata, keeps a two-scan absence counter, and posts bounded batches to the private observer socket. It must not execute user-supplied commands, open a TCP listener, write SQLite directly, read `/proc/<pid>/environ`, attach to processes, or read terminal/file contents. Use `unref()` for the polling timer and clean shutdown on SIGTERM/SIGINT.

- [ ] **Step 4: Add least-privilege service boundaries**

Create a separate `ssh-tool-observer.service` that runs as root only because cross-user `/proc` inspection may require it. Give it read-only process/session access plus write access only to its private submission socket. Keep `ssh-tool-coordinator` non-root and prevent the observer from accessing the coordinator database, public coordinator socket, release installation controls, or user command execution.

- [ ] **Step 5: Merge observed activity into conflict hints**

Extend `listActive`/`beginTask` responses with bounded observed activities. They may add warnings but never cause server-side locking or rejection. Returned text must retain source and low-confidence labels so AI wording is “detected/may be running”, not “is definitely modifying”. For shared root, show root plus available TTY/source-IP metadata without claiming a real human identity.

- [ ] **Step 6: Run focused tests and commit**

```bash
npm run build:test && node --test --test-force-exit dist/__tests__/coordinator-observer.test.js
git add src/coordinator/observer-protocol.ts src/coordinator/observer.ts src/coordinator/observer-main.ts src/coordinator/systemd/ssh-tool-observer.service src/coordinator/protocol.ts src/coordinator/store.ts src/coordinator/server.ts src/__tests__/coordinator-observer.test.ts
git commit -m "feat: observe unmanaged ssh sessions and processes"
```

---

### Task 9: Add explicit non-SSH-tool announcement support

**Files:**
- Modify: `src/coordinator/protocol.ts`.
- Modify: `src/coordinator/store.ts` and `src/coordinator/server.ts`.
- Modify: `src/coordinator/remote-helper.ts`.
- Modify: `src/cli/ssh-exec.ts` or add a focused CLI command only if it matches existing command routing.
- Create: `src/__tests__/coordinator-announce.test.ts`.

- [ ] **Step 1: Write failing announce tests**

Test a manual/CI caller can register a bounded announcement with source kind `manual` or `ci`, receives the same conflict summary, renews and finishes it with a token, and is shown as `identityTrust: "peer-uid"` only when the socket UID is the source identity. Test that announce data cannot include command bodies or secrets.

- [ ] **Step 2: Add explicit announcement action**

Add `announceTask` or reuse `beginTask` with a required `source` field. Keep it explicit: the coordinator must never infer all non-SSH activity. Expose a documented machine-readable helper invocation suitable for CI start/finish hooks, with no new network port.

- [ ] **Step 3: Run tests and commit**

```bash
npm run build:test && node --test --test-force-exit dist/__tests__/coordinator-announce.test.js
git add src/coordinator/protocol.ts src/coordinator/store.ts src/coordinator/server.ts src/coordinator/remote-helper.ts src/cli/ssh-exec.ts src/__tests__/coordinator-announce.test.ts
git commit -m "feat: support manual and ci coordinator announcements"
```

---

### Task 10: Final verification and compatibility review

**Files:**
- Modify only if verification identifies a production or test defect.

- [ ] **Step 1: Run TypeScript build and focused coordinator suites**

```bash
export PATH=/Users/wanghaizhi/.nvm/versions/node/v22.22.3/bin:/bin:/usr/bin:$PATH
npm run build
npm run build:test
node --test --test-force-exit dist/__tests__/coordinator-*.test.js
```

- [ ] **Step 2: Run existing fast regression**

```bash
npm run test:fast
```

Expected: all baseline tests plus coordinator tests pass.

- [ ] **Step 3: Run SSH regression and record sandbox limitation**

```bash
npm run test:ssh
```

Expected: SSH behavior passes except known TRAE Sandbox EPERM writes under the scheduler directory. Any non-EPERM failure must be fixed before completion.

- [ ] **Step 4: Check static diff and working tree**

```bash
git diff --check
git status --short
git log --oneline -10
```

- [ ] **Step 5: Verify compatibility checklist**

```text
[ ] Existing IPC actions and response envelopes remain readable by old clients
[ ] Existing MCP/CLI exec, transfer, background, and port-forward result fields remain present
[ ] Coordinator unavailable never blocks SSH connection or command execution
[ ] No TCP listener or public network endpoint is added
[ ] No SSH credentials, complete commands, or environment variables are persisted
[ ] Shared root is marked self-asserted rather than trusted user identity
[ ] Signed artifact verification happens before execution
[ ] Failed upgrades preserve the prior healthy release
[ ] Non-SSH clients are supported through explicit announce/CI hooks and low-confidence passive observation
[ ] Observer command history is bounded and removed after 24 hours; observer does not read environment variables, terminal contents, or files
[ ] No commit contains unrelated daemon-stability documents or generated files
```

- [ ] **Step 6: Commit final integration fixes only if needed**

```bash
git add <only-the-files-fixed-during-verification>
git commit -m "fix: harden remote coordinator integration"
```

Do not push unless explicitly requested.
