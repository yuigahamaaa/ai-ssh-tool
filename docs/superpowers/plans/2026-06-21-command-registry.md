# Command Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a project command recipe registry with CRUD, lookup, and managed execution.

**Architecture:** Store recipes in a small versioned JSON registry. Expose MCP tools for list/get/register/update/delete/run. Managed run delegates to the existing scheduler/background machinery so logs and task status stay centralized.

**Tech Stack:** TypeScript, Node test runner, existing MCP response envelopes, existing scheduler daemon APIs.

---

### Task 1: Registry Store

**Files:**
- Create: `src/command-registry.ts`
- Create: `src/__tests__/command-registry.test.ts`

- [x] Add tests for register/get/list/update/delete.
- [x] Add tests for schema envelope persistence.
- [x] Add tests for legacy bare-array compatibility.
- [x] Add tests that partial update ignores undefined fields.
- [x] Add tests that concurrent store instances merge latest persisted state.
- [x] Implement `CommandRegistryStore`.

### Task 2: MCP Tools

**Files:**
- Modify: `src/mcp-server.ts`
- Modify: `src/mcp-response.ts`

- [x] Add `command_result` envelope kind.
- [x] Add `ssh_command_list`, `ssh_command_get`, `ssh_command_register`, `ssh_command_update`, `ssh_command_delete`, and `ssh_command_run`.
- [x] Make `ssh_command_run(run_mode="managed")` delegate to existing scheduler/background execution.
- [x] Make `ssh_command_run(run_mode="lookup")` return the recipe without executing.

### Task 3: Docs And Verification

**Files:**
- Modify: `README.md`
- Modify: `SKILL.md`
- Modify: `docs/AI_AGENT_USAGE.zh-CN.md`
- Modify: `package.json`

- [x] Document command recipe tools and AI usage rules.
- [x] Add the new test to `npm test`.
- [x] Run focused build/tests.
- [x] Run full `npm test`.
