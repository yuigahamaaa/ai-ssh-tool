import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "events"
import { rmSync, mkdirSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

/**
 * P2-5: ExecTaskManager.start() accepts an explicit `host` parameter that
 * is preferred over the ssh2-internal reflection. This test mocks just
 * enough of the Client shape to exercise the host resolution path and
 * asserts that the explicit value wins.
 *
 * HOME redirect: ExecTaskManager's constructor builds a SchedulerService
 * which writes to `~/.ssh-tool/scheduler/...`. Some sandboxes don't allow
 * writing under the real $HOME, so we point HOME at a tmpdir before any
 * import + construction. We use a dynamic `import()` so the module is
 * (re-)evaluated AFTER the HOME swap.
 */

import type { Client } from "ssh2"

const testHome = join(tmpdir(), `etm-host-${Date.now()}-${process.pid}`)
const origHome = process.env.HOME
let ExecTaskManager: typeof import("../exec-task-manager.js").ExecTaskManager

before(async () => {
  mkdirSync(testHome, { recursive: true })
  process.env.HOME = testHome
  // Cache-bust so the module is re-evaluated under the new HOME.
  const mod = await import(`../exec-task-manager.js?t=${Date.now()}`)
  ExecTaskManager = mod.ExecTaskManager
})

after(() => {
  process.env.HOME = origHome
  try { rmSync(testHome, { recursive: true, force: true }) } catch {}
})

function makeFakeClient(): Client {
  // Construct a bare object that looks enough like a Client to pass
  // through getHostIdentifier's reflection without crashing, AND has
  // a no-op exec() so the manager's async machinery doesn't error.
  const fake: any = {
    _client: {
      _config: { host: "from-ssh2-internals.example.com" },
    },
    exec: (_cmd: string, cb: any) => {
      // Return a fake stream that never emits and never closes.
      const stream = new EventEmitter() as any
      stream.stderr = new EventEmitter()
      process.nextTick(() => cb(null, stream))
      return stream
    },
  }
  return fake as Client
}

describe("ExecTaskManager P2-5: explicit host overrides ssh2 reflection", () => {
  it("uses explicit `host` option when provided, ignoring ssh2 internals", () => {
    // Each test gets a fresh manager so the in-memory task map is clean.
    const mgr = new ExecTaskManager()
    const client = makeFakeClient()
    const { id } = mgr.start(client, "echo hi", { host: "explicit.example.com" })
    const status = mgr.getStatus(id)
    assert.ok(status, "task should be registered")
    assert.equal(status!.hostname, "explicit.example.com")
  })

  it("falls back to ssh2 reflection when no explicit host is given", () => {
    const mgr = new ExecTaskManager()
    const client = makeFakeClient()
    const { id } = mgr.start(client, "echo hi")
    const status = mgr.getStatus(id)
    assert.ok(status)
    assert.equal(status!.hostname, "from-ssh2-internals.example.com")
  })
})
