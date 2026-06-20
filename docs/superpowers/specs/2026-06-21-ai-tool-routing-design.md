# AI Tool Routing Design

## Goal

Make AI agents choose the right SSH MCP tool on the first attempt instead of defaulting to `ssh_exec` and discovering specialized tools only after a failure or timeout.

## Problem

The tool surface already includes background execution, asynchronous scheduling, structured file tools, transfer tools, and task status tools. The issue is presentation:

- `ssh_exec` reads like the universal default.
- `ssh_exec_background` reads like a detached fallback rather than the first choice for servers/watch/log streams.
- `ssh_exec_status` says "background task" in some docs even though it works for any scheduler taskId.
- File tool descriptions do not strongly steer agents away from `ssh_exec cat/echo/base64`.
- Documentation describes the tools but does not provide a single task-type routing rule.

## Chosen Design

Keep the existing API names and behavior, but add first-choice routing language in three places:

1. MCP tool descriptions, because agents see these at selection time.
2. `agentGuidance`, because agents see this immediately after an uncertain/timeout/queued result.
3. AI-facing documentation (`SKILL.md`, README, usage guide), because prompt authors and agents need consistent rules.

## Routing Rules

- Use `ssh_exec` for finite commands expected to complete soon.
- Use `ssh_exec_background` first for servers, watch mode, `tail -f`, log streams, dev servers, and other long-running commands.
- Use `ssh_schedule` for heavy work that can queue and be revisited later, such as tests, builds, installs, scripts, deploys, and migrations.
- Use `ssh_exec_status` for any scheduler taskId from `ssh_exec`, `ssh_exec_background`, `ssh_schedule`, or `ssh_wait_task`.
- Use `ssh_read_file` / `ssh_write_file` for normal text file IO instead of shell `cat`, `sed`, `echo`, or ad hoc base64.
- Use `ssh_upload` / `ssh_download` for full files, binary files, large files, archives, and exact local-file transfer.

## Non-Goals

- Do not rename tools.
- Do not change scheduler queue semantics.
- Do not add automatic command rewriting.
- Do not remove `ssh_exec`; make it less of an accidental catch-all.
