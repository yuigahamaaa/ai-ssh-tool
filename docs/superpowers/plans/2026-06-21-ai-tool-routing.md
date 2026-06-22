# AI Tool Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve first-attempt tool selection by making specialized SSH MCP tools show their intended use at selection time and in follow-up guidance.

**Architecture:** Preserve all existing tool behavior. Update guidance helpers, MCP tool descriptions, and AI-facing docs so routing rules are explicit and consistent.

**Tech Stack:** TypeScript, Node test runner, existing MCP response helpers, README/SKILL markdown docs.

---

### Task 1: Guidance Tests

**Files:**
- Modify: `src/__tests__/mcp-response.test.ts`
- Modify: `src/mcp-response.ts`

- [x] Add tests proving foreground wait timeout guidance suggests `ssh_exec_background` for long-running commands.
- [x] Add tests proving long-running schedule decisions mention `ssh_exec_status` and `ssh_exec_background`.
- [x] Implement guidance helper logic.

### Task 2: MCP Tool Descriptions

**Files:**
- Modify: `src/mcp-server.ts`

- [x] Reframe `ssh_exec` as a finite-command tool.
- [x] Reframe `ssh_exec_background` as first choice for servers/watch/log streams and long-running commands.
- [x] Reframe `ssh_schedule` as first choice for heavy work that can be revisited later.
- [x] Reframe `ssh_exec_status` as valid for any scheduler taskId.
- [x] Strengthen file tool descriptions so agents prefer structured file APIs over shell IO.

### Task 3: AI-Facing Docs

**Files:**
- Modify: `SKILL.md`
- Modify: `README.md`
- Modify: `docs/AI_AGENT_USAGE.zh-CN.md`

- [x] Add task-type routing rules.
- [x] Update background/status/file tool descriptions.
- [x] Add common mistake rows for foreground long-running commands and shell-based file IO.

### Task 4: Verification

**Files:**
- Test: `src/__tests__/mcp-response.test.ts`

- [x] Run `npm run build:test && node --test dist/__tests__/mcp-response.test.js`.
- [x] Run a broader focused set if the build touches shared types.
