# Command Registry Design

## Goal

Give AI agents a project-level memory for reusable SSH commands so they can look up, save, update, delete, and run commands without relying on conversation memory.

## Design

Add a thin command recipe registry keyed by `project + name`. The registry stores the command, optional cwd, description, execution metadata, and managed log policy. It does not implement a workflow DSL, multi-step orchestration, dependency graph, variable template engine, or CI system.

## Data Compatibility

The on-disk format is a versioned JSON envelope:

```json
{
  "schemaVersion": 1,
  "commands": []
}
```

The loader also accepts the legacy bare-array shape so future migrations can preserve early user data. Every loaded command is normalized to `schemaVersion=1`.

The registry is persisted under the scheduler state directory by default. Mutating operations use a small cross-process file lock, then re-read the latest persisted file and apply the current register/update/delete operation before writing an atomic replacement. This keeps separate MCP server processes from overwriting each other's command changes in normal use.

## Execution

`ssh_command_run` supports two modes:

- `managed` (default): submit the saved command through ssh-tool and return scheduler data, including `taskId` when available. Logs stay managed by scheduler output storage and can be inspected with `ssh_exec_status`.
- `lookup`: return the saved command recipe only. The AI can then decide to run `ssh_exec`, `ssh_schedule`, or `ssh_exec_background` itself.

Managed execution uses the same daemon scheduler path as the existing MCP execution tools. It does not bypass VM coordination; commands still follow scheduler classification, cost limits, cwd/workdir locks, and `if_busy` behavior.

Unspecific command recipes default to `execution.mode="background"` because project command suites are usually long-running tests, builds, scripts, servers, or migrations. Short commands can explicitly set `execution.mode="exec"`.

## AI Guidance

Every command-registry response reminds agents to:

- query `ssh_command_list` / `ssh_command_get` before relying on memory;
- save reusable commands with `ssh_command_register`;
- update changed commands with `ssh_command_update`;
- delete obsolete commands with `ssh_command_delete`;
- prefer managed runs for long project commands.
