# SSH Host-Key Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add safe-by-default, per-hop SSH host-key verification with configurable known-hosts storage while preserving an explicit `strictHostKeyChecking: "no"` compatibility escape hatch.

**Architecture:** `known-hosts.ts` owns OpenSSH known_hosts parsing, hashed-host matching, fingerprint formatting, append-only enrollment, and warning/error messages. `ProfileManager.chainFromProfile()` applies profile-level host-key defaults to each hop without changing authentication fields; `SSHConnection` creates one verifier per hop and preserves the verifier error context when ssh2 reports its generic handshake failure.

**Tech Stack:** TypeScript, Node.js `crypto`/`fs`/`path`/`os`, ssh2 hostVerifier, Node `node:test`.

---

### Task 1: Define host-key configuration and failing behavior tests

**Files:**
- Modify: `src/types.ts`
- Modify: `src/profile-manager.ts`
- Test: `src/__tests__/known-hosts.test.ts`
- Test: `src/__tests__/profile-manager.test.ts`

- [x] **Step 1: Add tests for the public policy contract**

  Add tests that assert a profile-level `strictHostKeyChecking` and `knownHostsPath` are copied to every hop, while a hop-level value wins; assert authentication fields are unchanged. Add known-host tests for accept-new enrollment, yes rejection of unknown keys, hashed-host matching, changed-key rejection text, append-only writes, and unavailable-file warning/continue behavior.

- [x] **Step 2: Run the focused tests and confirm RED**

  Run `npm run build:test && node --test dist/__tests__/known-hosts.test.js dist/__tests__/profile-manager.test.js`.
  Expected: the new test file cannot compile or the new imports/API are missing, and the profile propagation assertion fails because the fields are not defined/propagated yet.

- [x] **Step 3: Add the optional security fields**

  Define `StrictHostKeyChecking = "accept-new" | "yes" | "no"`; add optional `strictHostKeyChecking` and `knownHostsPath` to `SSHHostConfig` and `SSHProfile`; update `chainFromProfile()` so profile values fill only undefined hop values.

- [x] **Step 4: Run the profile tests and keep the known-host tests RED**

  Run `npm run build:test && node --test dist/__tests__/known-hosts.test.js dist/__tests__/profile-manager.test.js`.
  Expected: profile tests pass; known-host tests still fail because the implementation module has not been added.

### Task 2: Implement known_hosts verification

**Files:**
- Create: `src/known-hosts.ts`
- Modify: `src/ssh2.d.ts`
- Test: `src/__tests__/known-hosts.test.ts`

- [x] **Step 1: Implement the smallest parser and matcher**

  Parse non-comment OpenSSH lines into line-numbered entries, support comma-separated host fields, `host`/`[host]:port` canonical candidates, and `|1|salt|hash` HMAC-SHA1 hashed host tokens. Decode the stored key, extract its SSH algorithm, and format SHA256 fingerprints from the raw SSH key blob.

- [x] **Step 2: Implement append-only policy evaluation**

  For `no`, accept without reading or writing. For `accept-new`, accept and append an unknown host key, accept an exact existing key, and reject a changed key. For `yes`, require a matching entry when the known_hosts file is readable. If the file is missing/unreadable or an enrollment append fails, issue a warning and continue rather than blocking. Never rewrite or replace existing lines.

- [x] **Step 3: Implement actionable verification messages**

  Include host:port, algorithm, new fingerprint, old fingerprint(s), the exact `known_hosts` line number/path when available, and both repair choices: delete that line after verifying the replacement key, or set that hop's `strictHostKeyChecking: "no"` for a pooled/shared-address jump host. State that host-key verification is independent of login authentication.

- [x] **Step 4: Run the focused tests and confirm GREEN**

  Run `npm run build:test && node --test dist/__tests__/known-hosts.test.js`.
  Expected: all known-host parser, policy, hashed-host, warning, append-only, and message tests pass.

### Task 3: Wire one verifier into every SSH hop

**Files:**
- Modify: `src/connection.ts`
- Test: `src/__tests__/known-hosts.test.ts`
- Test: `src/__tests__/multi-hop-auth.test.ts`

- [x] **Step 1: Add integration tests against mock ssh2 servers**

  Test the default accept-new path with public-key authentication and no password, reconnect with a changed server key and assert rejection includes all repair details, set `strictHostKeyChecking: "no"` and assert the changed-key server still connects, and build a two-hop chain with separate known_hosts entries so both hop keys are independently enrolled and checked.

- [x] **Step 2: Run the integration tests and confirm RED**

  Run `npm run build:test && node --test dist/__tests__/known-hosts.test.js dist/__tests__/multi-hop-auth.test.js`.
  Expected: changed keys are currently accepted because `SSHConnection` has no hostVerifier, and per-hop enrollment assertions fail.

- [x] **Step 3: Inject hostVerifier per hop**

  Resolve the configured known-hosts path, create a fresh verifier closure for each host in `toConnectConfig()`, omit the verifier for `no`, and retain a policy error from the verifier so the outer connection rejection contains the actionable message instead of only ssh2's generic “Host denied” text. Keep all password/private-key/agent fields unchanged.

- [x] **Step 4: Run the integration tests and confirm GREEN**

  Run `npm run build:test && node --test dist/__tests__/known-hosts.test.js dist/__tests__/multi-hop-auth.test.js`.
  Expected: default enrollment, changed-key rejection, no-mode compatibility, authentication orthogonality, and independent multi-hop verification all pass.

### Task 4: Document and gate the behavior

**Files:**
- Modify: `README.md`
- Modify: `docs/AI_AGENT_USAGE.zh-CN.md`
- Modify: `package.json`
- Test: `src/__tests__/profile-manager.test.ts`

- [x] **Step 1: Add documentation examples and operational warnings**

  Document default `accept-new`, profile-level and per-hop overrides, `knownHostsPath`, the fact that host-key verification is orthogonal to password/key/agent authentication, the pooled jump-host `no` escape hatch, and the changed-fingerprint repair message.

- [x] **Step 2: Include the new test file in the fast suite**

  Add `dist/__tests__/known-hosts.test.js` to `test:fast` so the P0 regression coverage cannot become an orphan test.

- [x] **Step 3: Run full verification**

  Run `npm run build`, `npm test`, `npm run test:all`, and `npm run test:ssh`.
  Evidence: `npm run build` and `npm test` pass (607/607). The executed `test:all` and `test:ssh` runs reported only the same pre-existing mock/integration failures recorded in the audit (9 and 7 respectively); all new host-key and propagation suites passed. The final warning-only missing-file assertion also passes in the focused known-hosts run. Inspect `git diff` and `git status` to ensure only the intended implementation, tests, docs, and plan changed.
