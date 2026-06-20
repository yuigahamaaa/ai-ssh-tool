# SSH CWD State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `ssh_cd` easier for AI agents to trust by adding an explicit cwd-state model, a dedicated cwd query tool, and clearer execution responses.

**Architecture:** Preserve the scheduler's existing virtual cwd mechanism, add a small persisted cwd-source field to scheduled tasks, then normalize MCP responses around a shared `cwdState` shape. Implement `ssh_get_cwd` as a thin MCP/daemon read path over existing scheduler state.

**Tech Stack:** TypeScript, Node test runner, existing MCP server/daemon IPC, `SchedulerService`, `VirtualCwdStore`.

---

### Task 1: Add cwd-state types and scheduler metadata

**Files:**
- Modify: `src/scheduler/types.ts`
- Modify: `src/scheduler/scheduler-service.ts`
- Test: `src/__tests__/scheduler-service.test.ts`

- [ ] Add failing tests for `cwdSource` persistence in scheduled tasks.
- [ ] Verify the tests fail before implementation.
- [ ] Add shared cwd-state/cwd-source types.
- [ ] Persist `cwdSource` on scheduled tasks as `explicit`, `virtual`, or `none`.
- [ ] Run the targeted scheduler tests.

### Task 2: Add daemon/MCP cwd query support

**Files:**
- Modify: `src/ipc-protocol.ts`
- Modify: `src/daemon-client.ts`
- Modify: `src/daemon.ts`
- Modify: `src/mcp-server.ts`
- Test: `src/__tests__/daemon-scheduler.test.ts`

- [ ] Add failing tests for a new `getCwd` IPC action.
- [ ] Verify the tests fail before implementation.
- [ ] Add the `getCwd` IPC request path and daemon handler.
- [ ] Add `DaemonClient.getCwd(...)`.
- [ ] Implement `ssh_get_cwd` in the MCP server.
- [ ] Run the targeted daemon/IPC tests.

### Task 3: Normalize MCP cwdState responses

**Files:**
- Modify: `src/mcp-response.ts`
- Modify: `src/mcp-server.ts`
- Test: `src/__tests__/mcp-response.test.ts`
- Test: `src/__tests__/mcp-scheduler-contract.test.ts`

- [ ] Add failing tests for `cwdState` normalization and guidance text.
- [ ] Verify the tests fail before implementation.
- [ ] Add shared helpers to build `cwdState`.
- [ ] Attach `cwdState` to `ssh_exec`, `ssh_schedule`, `ssh_exec_status`, `ssh_wait_task`, and `ssh_queue_status`.
- [ ] Update `ssh_cd` descriptions/messages to positive wording.
- [ ] Run the targeted MCP response tests.

### Task 4: Final verification

**Files:**
- Test: `src/__tests__/scheduler-service.test.ts`
- Test: `src/__tests__/daemon-scheduler.test.ts`
- Test: `src/__tests__/mcp-response.test.ts`

- [ ] Run the focused test set for cwd-state changes.
- [ ] Run a TypeScript test build.
- [ ] Review diffs to ensure no unrelated work was touched.
