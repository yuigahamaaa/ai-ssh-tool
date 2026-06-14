# ExecTaskManager Thin Facade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move new `ExecTaskManager.start()` tasks onto scheduler-owned lifecycle, output, persistence, and cancellation while preserving the legacy API.

**Architecture:** Add a foreground runner handle contract to `TaskRunner`, let `SchedulerService` retain foreground `stop()` controllers, then make `ExecTaskManager.start()` build a per-call runner over the supplied `ssh2.Client` and call `scheduler.schedule()` with the returned id. Legacy disk readers remain as fallback only for old task files.

**Tech Stack:** TypeScript, Node test runner, `ssh2`, existing `SchedulerService`, `OutputStore`, and `PersistenceStore`.

---

### Task 1: Scheduler Foreground Controller Contract

**Files:**
- Modify: `src/scheduler/types.ts`
- Modify: `src/scheduler/scheduler-service.ts`
- Test: `src/__tests__/scheduler-service.test.ts`

- [ ] **Step 1: Write the failing controller cancellation test**

Add this test near the existing `cancelTask` tests in `src/__tests__/scheduler-service.test.ts`:

```ts
it("cancelTask stops a foreground runner controller before marking task cancelled", async () => {
  let stopCount = 0
  let resolveRun!: (value: { code: number; stdout: string; stderr: string }) => void
  const scheduler = makeService({
    runner: {
      start: () => ({
        promise: new Promise((resolve) => { resolveRun = resolve }),
        stop: () => { stopCount++ },
      }),
      startBackground: () => {},
    },
  })

  const decision = scheduler.schedule(makeReq({ command: "sleep 999", scheduler: "bypass" }))
  assert.equal(decision.action, "run_now")
  assert.equal(scheduler.cancelTask(decision.taskId!), true)
  assert.equal(stopCount, 1)
  assert.equal(scheduler.getTask(decision.taskId!)?.status, "cancelled")

  resolveRun({ code: 0, stdout: "late", stderr: "" })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(scheduler.getTask(decision.taskId!)?.status, "cancelled")
})
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
npx tsc -p tsconfig.test.json && node --test --test-force-exit dist/__tests__/scheduler-service.test.js
```

Expected: TypeScript fails because `TaskRunner.start()` does not accept a `TaskRunHandle` return shape, or the test fails because `stop()` is never called.

- [ ] **Step 3: Add the `TaskRunHandle` type**

In `src/scheduler/types.ts`, add:

```ts
export interface TaskRunResult {
  stdout: string
  stderr: string
  code: number
  signal?: string
}

export interface TaskRunHandle {
  promise: Promise<TaskRunResult>
  stop: () => void
}
```

Change `TaskRunner.start()` to:

```ts
start(
  task: ScheduledTask,
  onOutput?: (stdout: string, stderr: string) => void
): Promise<TaskRunResult> | TaskRunHandle
```

- [ ] **Step 4: Store foreground controllers in `SchedulerService`**

In `src/scheduler/scheduler-service.ts`, add:

```ts
private foregroundTaskControllers = new Map<string, { stop: () => void }>()
```

In `dispose()`, stop and clear both foreground and background controller maps.

- [ ] **Step 5: Wire `TaskRunHandle` in `startTask()`**

Replace the foreground `this.runner.start(task, onOutput).then(...).catch(...)` block with:

```ts
const run = this.runner.start(task, onOutput)
const runPromise = "promise" in run ? run.promise : run
if ("promise" in run && typeof run.stop === "function") {
  this.foregroundTaskControllers.set(task.id, { stop: run.stop })
}
runPromise
  .then(result => {
    this.foregroundTaskControllers.delete(task.id)
    this.finishTask(task.id, result.code === 0 ? "completed" : "failed", result.code, result.signal, result.stdout, result.stderr)
  })
  .catch(err => {
    this.foregroundTaskControllers.delete(task.id)
    this.finishTask(task.id, "failed", 1, undefined, "", err instanceof Error ? err.message : String(err))
  })
```

- [ ] **Step 6: Stop foreground controllers in `cancelTask()`**

Before background controller handling in `cancelTask()`, add:

```ts
const fgController = this.foregroundTaskControllers.get(task.id)
if (fgController) {
  try { fgController.stop() } catch {}
  this.foregroundTaskControllers.delete(task.id)
}
```

- [ ] **Step 7: Verify scheduler tests**

Run:

```bash
npx tsc -p tsconfig.test.json && node --test --test-force-exit dist/__tests__/scheduler-service.test.js
```

Expected: scheduler-service tests pass.

### Task 2: Move New ExecTaskManager Tasks Off Legacy Disk

**Files:**
- Modify: `src/exec-task-manager.ts`
- Modify: `src/__tests__/exec-task-manager-memory.test.ts`
- Modify: `src/__tests__/exec-task-manager-list.test.ts`
- Test: `src/__tests__/exec-task-manager-delegate.test.ts`

- [ ] **Step 1: Write failing tests for no legacy JSON writes**

In `src/__tests__/exec-task-manager-delegate.test.ts`, add:

```ts
import { existsSync, readdirSync } from "fs"

function legacyTaskFiles(): string[] {
  const dir = join(testHome, ".ssh-tool", "exec-tasks")
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : []
}

it("ExecTaskManager.start does not write new tasks to legacy exec-tasks JSON", async () => {
  const scheduler = makeTrackedScheduler()
  const mgr = new ExecTaskManager({ scheduler })
  const client = new FakeClient() as any
  const { promise } = mgr.start(client, "echo no-legacy", { host: "h1", timeout: 5000 })

  await new Promise(r => setImmediate(r))
  client.channel.emit("data", Buffer.from("no legacy\n"))
  client.channel.emit("close", 0)
  await promise

  assert.deepEqual(legacyTaskFiles(), [])
})
```

Expected before implementation: this fails because `ExecTaskManager.saveTask()` writes a JSON file.

- [ ] **Step 2: Write failing tests for scheduler-only reads after finish**

Add:

```ts
it("finished ExecTaskManager tasks remain readable from scheduler without legacy disk files", async () => {
  const scheduler = makeTrackedScheduler()
  const mgr = new ExecTaskManager({ scheduler })
  const client = new FakeClient() as any
  const { id, promise } = mgr.start(client, "echo sched-only", { host: "h1", timeout: 5000 })

  await new Promise(r => setImmediate(r))
  client.channel.emit("data", Buffer.from("sched only\n"))
  client.channel.emit("close", 0)
  await promise

  assert.deepEqual(legacyTaskFiles(), [])
  assert.equal(mgr.getStatus(id)?.status, "completed")
  assert.equal(mgr.getOutput(id)?.stdout, "sched only\n")
})
```

- [ ] **Step 3: Implement a per-call scheduler runner in `ExecTaskManager.start()`**

Refactor `start()` so it:

- computes `id`, `hostname`, `fullCommand`, and `wrappedCommand`
- creates closure-local `stdoutChunks`, `stderrChunks`, `stream`, `pid`, `finished`
- builds a `TaskRunner` whose `start(task, onOutput)` executes `client.exec(wrappedCommand, ...)`
- returns a `TaskRunHandle` with `promise` and `stop()`
- creates a per-call `SchedulerService` only when no scheduler was injected, or temporarily swaps the existing scheduler runner if no setter exists

If `SchedulerService` does not support replacing the runner, add a public `runExternalWithRunner(req, runner)` helper instead of mutating private fields. The helper should register the task through the same scheduler path as `schedule(req)` and call `startTask()` with the supplied runner.

- [ ] **Step 4: Remove new-task legacy persistence calls**

Delete these from the new `start()` path:

- `this.tasks.set(id, entry)`
- `this.saveTask(entry, ...)`
- `this.finishTask(...)`
- `this.scheduler.registerExternal(...)`
- `this.scheduler.appendExternalOutput(...)`
- `this.scheduler.finishExternalTask(...)`

Leave `getStatus()`/`getOutput()` legacy disk fallback for old files.

- [ ] **Step 5: Update memory/list tests to assert scheduler ownership**

Change `exec-task-manager-memory.test.ts` wording:

- "readable from disk" becomes "readable from scheduler"
- keep `tasks` map size checks only if `ExecTaskManager` still has a runtime control map; otherwise assert the private map is absent or empty

Change `exec-task-manager-list.test.ts`:

- Keep disk fixture tests as legacy fallback tests.
- Remove assertions that in-memory entries win for new tasks unless a runtime map still exists. Scheduler tasks should win over legacy disk snapshots.

- [ ] **Step 6: Verify ExecTaskManager targeted tests**

Run:

```bash
npx tsc -p tsconfig.test.json && node --test --test-force-exit \
  dist/__tests__/exec-task-manager-delegate.test.js \
  dist/__tests__/exec-task-manager-memory.test.js \
  dist/__tests__/exec-task-manager-list.test.js \
  dist/__tests__/exec-task-manager-scheduler-read.test.js \
  dist/__tests__/exec-task-manager-host.test.js
```

Expected: all pass.

### Task 3: ExecTaskManager Cancellation Through Scheduler

**Files:**
- Modify: `src/exec-task-manager.ts`
- Test: `src/__tests__/exec-task-manager-delegate.test.ts`

- [ ] **Step 1: Write failing cancellation controller test**

In `src/__tests__/exec-task-manager-delegate.test.ts`, add:

```ts
it("ExecTaskManager.cancel delegates status to scheduler and stops the raw stream once", async () => {
  const scheduler = makeTrackedScheduler()
  const mgr = new ExecTaskManager({ scheduler })
  const client = new FakeClient() as any
  let closeCount = 0
  client.channel.close = () => {
    closeCount++
    client.channel.emit("close", 0)
  }

  const { id } = mgr.start(client, "sleep 999", { host: "h1", timeout: 5000 })
  await new Promise(r => setImmediate(r))
  client.channel.emit("data", Buffer.from("before cancel\n"))

  assert.equal(mgr.cancel(id, client), true)
  assert.equal(closeCount, 1)
  assert.equal(scheduler.getTask(id)?.status, "cancelled")
  assert.equal(mgr.getStatus(id)?.status, "cancelled")
  assert.equal(mgr.getOutput(id)?.stdout, "before cancel\n")
})
```

- [ ] **Step 2: Implement `ExecTaskManager.cancel()` as scheduler delegation**

Change `cancel()` so it:

```ts
cancel(id: string, _client: Client, _signal: "TERM" | "HUP" = "TERM"): boolean {
  return this.scheduler.cancelTask(id)
}
```

The runner controller created in Task 2 owns stream close and remote kill.

- [ ] **Step 3: Verify cancellation tests**

Run the same targeted ExecTaskManager command from Task 2.

Expected: all pass.

### Task 4: Documentation And Verification

**Files:**
- Modify: `docs/OPTIMIZATION.md`
- Modify: `docs/README.md`
- Modify: `package.json` if new tests should be included in `test:fast`

- [ ] **Step 1: Update docs**

Update `docs/OPTIMIZATION.md` architecture section:

- Replace “ExecTaskManager task id/status/output 已桥接” with “new ExecTaskManager tasks are scheduler-owned”
- Keep a remaining note only for legacy disk fallback/migrator if still present

Update `docs/README.md`:

- Replace “`ExecTaskManager` still legacy facade/execution path” with “`ExecTaskManager` is compatibility facade; scheduler owns new task lifecycle”

- [ ] **Step 2: Run final verification**

Run:

```bash
npm run test:fast
npm run test:transfer
npm run test:ssh
git diff --check
```

Expected:

- `test:fast` passes
- `test:transfer` passes
- `test:ssh` passes
- `git diff --check` reports no whitespace errors

- [ ] **Step 3: Final audit**

Confirm:

```bash
rg -n "saveTask\\(|stdoutChunks|stderrChunks|registerExternal|appendExternalOutput|finishExternalTask|exec-tasks" src/exec-task-manager.ts docs/OPTIMIZATION.md docs/README.md
```

Expected:

- `src/exec-task-manager.ts` no longer calls `saveTask()`, `registerExternal()`, `appendExternalOutput()`, or `finishExternalTask()` for new tasks
- `stdoutChunks`/`stderrChunks` appear only as closure-local aggregation for returned promise output, not in long-lived task state
- docs accurately describe only remaining legacy disk fallback/migrator support

