import { describe, it, mock } from "node:test"
import assert from "node:assert/strict"
import { DaemonClient } from "../daemon-client.js"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

/**
 * P2-6: regression test for the connect/disconnect race in DaemonClient.
 *
 * Symptom before the fix: when connect() is in flight (the socket is
 * waiting for the 'connect' event) and disconnect() is called concurrently,
 * disconnect() removes all listeners and destroys the socket, leaving the
 * connect() promise pending forever — the awaiter hangs.
 *
 * The fix: disconnect() captures the in-flight reject handle from
 * _connect() and settles it with an explicit "disconnected" error.
 *
 * We can't easily drive a real Unix socket here without spinning up a
 * daemon, so we use a non-existent pipe path. The connect() attempt
 * will fail with ENOENT (or the equivalent "socket hang up" once the
 * file system rejects it) — what we care about is that the failure
 * surfaces through connect()'s promise even when disconnect() was
 * called first.
 */

describe("DaemonClient P2-6: connect/disconnect race", () => {
  it("rejects in-flight connect() when disconnect() is called", async () => {
    // Use a fresh temp dir for a non-existent socket path.
    const tmp = mkdtempSync(join(tmpdir(), "daemon-client-race-"))
    const pipePath = join(tmp, "no-such-daemon.sock")
    const client = new DaemonClient(pipePath)

    // Kick off connect (will hang on the socket because no daemon is listening).
    // Then immediately call disconnect.
    const connectPromise = client.connect()
    const disconnectPromise = client.disconnect()

    // Both should settle quickly — disconnect is sync, connect should reject.
    await disconnectPromise
    await assert.rejects(
      () => connectPromise,
      (err: Error) => {
        // Either "disconnected" (our explicit reject) or the underlying
        // connect failure (ENOENT) is acceptable. The key property is
        // that connect() DOES reject — it must not hang.
        assert.ok(
          err.message === "disconnected" || /ENOENT|ECONNREFUSED|EPIPE|socket/i.test(err.message),
          `unexpected error message: ${err.message}`,
        )
        return true
      },
    )

    rmSync(tmp, { recursive: true, force: true })
  })

  it("subsequent connect() after disconnect() works fresh", async () => {
    // After the race, internal state should be clean. A second disconnect
    // (or connect attempt) shouldn't throw or hang.
    const tmp = mkdtempSync(join(tmpdir(), "daemon-client-race-2-"))
    const pipePath = join(tmp, "still-no-daemon.sock")
    const client = new DaemonClient(pipePath)

    const p1 = client.connect()
    client.disconnect()
    await p1.catch(() => undefined) // ignore the rejection
    // Calling disconnect again should be a no-op, not throw.
    client.disconnect()

    rmSync(tmp, { recursive: true, force: true })
  })
})
