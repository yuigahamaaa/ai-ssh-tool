# ExecTaskManager Thin Facade Design

## Goal

Make `ExecTaskManager` a compatibility facade over `SchedulerService` instead of a second task system. The scheduler must own task state, output persistence, completion, cancellation status, and listing. `ExecTaskManager` should only adapt an existing raw `ssh2.Client` into a scheduler `TaskRunner` and expose the legacy API shape.

## Current State

The previous convergence slice aligned ids, final status, and live output between `ExecTaskManager` and `SchedulerService`, but `ExecTaskManager.start()` still maintains its own running task entries, stdout/stderr chunks, and legacy JSON files under `~/.ssh-tool/exec-tasks`. That leaves three sources of truth:

- Runtime control state in `ExecTaskManager.tasks`
- Legacy task snapshots in `~/.ssh-tool/exec-tasks`
- Scheduler task state and `OutputStore`

Read paths already consult the scheduler first, which lets us remove the legacy write path without breaking callers that use `getStatus()`, `getOutput()`, and `list()`.

## Implementation Status

Implemented on 2026-06-14:

- `SchedulerService.runWithRunner()` schedules one task with a per-task runner while preserving scheduler-owned lifecycle, persistence, locking, output, and queue behavior.
- `TaskRunner.start()` may return `TaskRunHandle`; `SchedulerService` stores foreground controllers and stops them from `cancelTask()`/`dispose()`.
- `ExecTaskManager.start()` now adapts the supplied raw `ssh2.Client` into a scheduler runner and no longer writes new `~/.ssh-tool/exec-tasks/*.json` files.
- `ExecTaskManager.cancel()` delegates to `SchedulerService.cancelTask()` first; the scheduler-held foreground/background controller stops the raw SSH stream.
- `getStatus()`, `getOutput()`, and `list()` still expose the legacy API shape, with old legacy disk snapshots retained as fallback only.

## Chosen Design

Use scheduler-owned lifecycle for new `ExecTaskManager.start()` calls:

1. Extend `TaskRunner.start()` so it may return a foreground controller with a `stop()` method.
2. Teach `SchedulerService` to retain foreground controllers, just like it already retains background controllers.
3. Implement a small `SchedulerTaskRunner` inside `ExecTaskManager.start()` that executes the command on the provided `ssh2.Client`, streams output through `onOutput`, captures the PID marker, and returns a controller able to close the stream and send a kill command.
4. Call `scheduler.schedule()` with a caller-owned id and `scheduler: "bypass"`.
5. Return the same id plus a promise that resolves/rejects from the runner promise.
6. Make `cancel()` delegate lifecycle status to `scheduler.cancelTask()` while using the scheduler-held controller to stop the raw SSH work.

`ExecTaskManager` may keep no long-lived task metadata for new tasks. If temporary runtime objects are needed during `start()` before the scheduler records the controller, keep them closure-scoped and release them when the promise settles.

## Compatibility

Legacy callers keep the same public API:

- `start(client, command, options)` returns `{ id, promise }`
- `cancel(id, client, signal)` returns `boolean`
- `getStatus(id)`, `getOutput(id)`, `getOutputSince(id, ...)`, and `list(hostname?)` return legacy `ExecTask`/output shapes
- Existing legacy disk snapshots remain readable as fallback for old task files

New tasks created by `ExecTaskManager.start()` must not create or update `~/.ssh-tool/exec-tasks/*.json`. The scheduler storage under `~/.ssh-tool/scheduler` is the durable record.

## Cancellation

Foreground cancellation needs a first-class scheduler controller. `TaskRunner.start()` should be allowed to resolve either:

- a normal task result, or
- an object containing `promise` and `stop()`

To keep the implementation narrow, add a `TaskRunHandle` type:

```ts
export interface TaskRunHandle {
  promise: Promise<{ stdout: string; stderr: string; code: number; signal?: string }>
  stop: () => void
}
```

`TaskRunner.start()` becomes:

```ts
start(
  task: ScheduledTask,
  onOutput?: (stdout: string, stderr: string) => void
): Promise<{ stdout: string; stderr: string; code: number; signal?: string }> | TaskRunHandle
```

`SchedulerService.startTask()` detects a handle, stores `stop()` in a foreground controller map, and wires `handle.promise` to `finishTask()`. `cancelTask()` stops either a foreground or background controller before marking the task cancelled.

## Output

`ExecTaskManager` should no longer keep stdout/stderr chunk arrays for authoritative reads. The raw SSH runner must call `onOutput(stdout, stderr)` for every non-PID output segment. `SchedulerService` already writes streamed output to `OutputStore` and suppresses duplicate result output when a stream was used.

The returned legacy `promise` should still resolve with stdout/stderr for compatibility. The runner can aggregate stdout/stderr in closure-local arrays only for the returned result; these arrays are not a second task state store and are released when the promise settles.

## Timeout

Timeout handling should move into the runner created by `ExecTaskManager.start()` for now, because the timeout kill command depends on the raw SSH client and captured remote PID. On timeout, the runner must call its own stop logic, then reject with the existing `Command timed out after ${timeout}ms` message. `SchedulerService.startTask()` already maps runner rejection to a failed task; a later small improvement can classify timeout as `timeout`.

## Tests

The first implementation pass must add failing tests before changing production code:

- `ExecTaskManager.start()` does not create legacy `exec-tasks` JSON files for new tasks.
- `ExecTaskManager.start()` uses scheduler lifecycle: status/output remain readable after memory eviction with no legacy file.
- `ExecTaskManager.cancel()` delegates to scheduler cancellation and the raw stream is stopped once.
- `SchedulerService` stores and invokes foreground runner controllers on `cancelTask()`.

Existing tests that assert disk fallback should be kept, but their wording must distinguish "old legacy disk snapshots" from new tasks.

## Non-Goals

- Do not remove legacy disk fallback readers in this pass; old task files still need migration compatibility.
- Do not rewrite daemon scheduled execution; it already uses scheduler runner paths.
- Do not change command classification or queue policy.
- Do not remove the migrator; it remains responsible for old `exec-tasks` imports.
