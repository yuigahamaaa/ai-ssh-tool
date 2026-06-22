# SSH CWD State Design

## Goal

Make remote working-directory state explicit and low-friction for AI agents so they do not need to remember prior `ssh_cd` calls from conversation context.

## Problem

`ssh_cd` already works as an agent+host virtual cwd, but the current MCP UX still makes agents behave cautiously:

- `ssh_cd` is described primarily as a warning about what it is not.
- Agents must remember the current working directory from earlier tool calls.
- Execution responses expose `effectiveCwd`, but not as a first-class cwd state model that can be re-checked every step.
- There is no dedicated read tool for "what is my current default cwd on this host?"

This leads agents to fall back to repeating explicit `cwd` parameters or to avoid `ssh_cd` entirely.

## Chosen Design

Keep the existing virtual cwd model, but make cwd state explicit in tool responses.

1. Keep `ssh_cd` for compatibility.
2. Reword `ssh_cd` to describe it positively as "set this AI session's default cwd on this host".
3. Add a read-only `ssh_get_cwd` tool that returns the current virtual cwd state for the current MCP agent on the target host.
4. Add a normalized `cwdState` object to execution-related responses so agents can re-check state from the latest tool output instead of relying on memory.

## Response Shape

Execution-related responses should expose:

```json
{
  "cwdState": {
    "effectiveCwd": "/repo/app",
    "virtualCwd": "/repo/app",
    "source": "virtual"
  }
}
```

Where:

- `source = "explicit"` when the tool call passed `cwd`
- `source = "virtual"` when the tool call omitted `cwd` and the agent's virtual cwd was applied
- `source = "none"` when no cwd was used

## Tool Surface

### `ssh_cd`

- Keep the tool name and parameters unchanged.
- Update description and success message to emphasize "default cwd for this AI session on this host".
- Keep the isolation note, but as supporting guidance rather than the primary framing.

### `ssh_get_cwd`

Return:

- `virtualCwd`
- `updatedAt`
- `hostId`
- `profileName`
- `targetHost`
- `targetUser`
- `cwdState`

When unset, return `virtualCwd: null` and `cwdState.source = "none"`.

## Data Flow

- Scheduler remains the source of truth for stored virtual cwd.
- MCP scheduling helpers compute `cwdState` from:
  - the explicit `cwd` in the request, when present
  - the resolved virtual cwd from the scheduler decision/task/queue status
- To make `ssh_exec_status` and `ssh_wait_task` accurate after the fact, scheduled tasks should persist enough cwd metadata to reconstruct whether `effectiveCwd` came from an explicit cwd or the virtual default.

## Testing

Add focused tests for:

- `ssh_cd` success messaging
- `ssh_get_cwd` returning null/unset state
- `ssh_get_cwd` returning stored state after `ssh_cd`
- `cwdState.source` for explicit, virtual, and none cases
- execution guidance mentioning `ssh_get_cwd` only when virtual cwd is in use

## Non-Goals

- No persistent remote shell state
- No change to scheduler queue policy
- No change to how explicit `cwd` overrides virtual cwd
