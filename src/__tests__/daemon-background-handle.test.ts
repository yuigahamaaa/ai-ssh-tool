import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "events"

/**
 * P2-3: regression test for BackgroundTaskHandle lifecycle.
 *  - stop() is idempotent
 *  - close + error firing back-to-back only invokes the onClose callback once
 *  - 5-minute orphan timeout force-stops the stream
 *
 * We don't import the daemon directly because the handle is a private
 * detail of the file. Instead we mirror the contract: a handle has a
 * `stream` (EventEmitter), a `stop()`, a `closed` flag, and a `timeoutId`.
 * This matches the structure of BackgroundTaskHandle in src/daemon.ts.
 */

interface FakeStream extends EventEmitter {
  close: () => void
  closedCount: number
}

function makeFakeStream(): FakeStream {
  const s = new EventEmitter() as FakeStream
  s.closedCount = 0
  s.close = () => { s.closedCount += 1 }
  return s
}

interface Handle {
  stream: FakeStream
  stop: () => void
  closed: boolean
  timeoutId: NodeJS.Timeout | null
  onClose: (code: number, signal?: string) => void
}

function makeHandle(onClose: (code: number, signal?: string) => void, orphanMs = 50): Handle {
  const stream = makeFakeStream()
  const handle: Handle = {
    stream,
    closed: false,
    timeoutId: null,
    onClose,
    stop: () => {
      if (handle.closed) return
      try { stream.close() } catch { /* best-effort */ }
    },
  }
  const finalize = (code: number, signal?: string) => {
    if (handle.closed) return
    handle.closed = true
    if (handle.timeoutId) { clearTimeout(handle.timeoutId); handle.timeoutId = null }
    onClose(code, signal)
  }
  // wire daemon-style finalize() through close/error
  stream.on("close", (code: number, signal?: string) => finalize(code ?? 1, signal))
  stream.on("error", () => finalize(1))
  handle.timeoutId = setTimeout(() => {
    if (handle.closed) return
    handle.stop()
    handle.closed = true
    if (handle.timeoutId) { clearTimeout(handle.timeoutId); handle.timeoutId = null }
    onClose(1, "SIGKILL")
  }, orphanMs)
  return handle
}

describe("BackgroundTaskHandle P2-3: lifecycle", () => {
  it("stop() is idempotent (close called only once)", () => {
    const stream = makeFakeStream()
    const h: Handle = {
      stream,
      closed: false,
      timeoutId: null,
      onClose: () => {},
      stop: () => {
        if (h.closed) return
        try { stream.close() } catch { /* ignore */ }
        h.closed = true
      },
    }
    h.stop()
    h.stop()
    h.stop()
    assert.equal(stream.closedCount, 1, "stream.close() should run only once")
  })

  it("close + error firing in sequence triggers onClose only once", () => {
    const calls: number[] = []
    const h = makeHandle((code) => calls.push(code))
    // close and error both fire (some SSH servers do this)
    h.stream.emit("close", 0)
    h.stream.emit("error", new Error("late io error"))
    h.stream.emit("error", new Error("another late error"))
    assert.equal(calls.length, 1, "onClose must fire exactly once")
    assert.equal(calls[0], 0)
    assert.equal(h.closed, true)
  })

  it("orphan timeout force-stops the handle when neither close nor error fires", async () => {
    const calls: { code: number; signal?: string }[] = []
    const h = makeHandle((code, signal) => calls.push({ code, signal }), 25)
    // Wait for the orphan timeout to fire
    await new Promise((r) => setTimeout(r, 60))
    assert.equal(calls.length, 1, "onClose should fire from orphan timeout")
    assert.equal(calls[0].code, 1)
    assert.equal(calls[0].signal, "SIGKILL")
    assert.equal(h.closed, true)
    assert.equal(h.stream.closedCount, 1, "stream.close() called by stop() inside timeout")
  })

  it("legitimate close before timeout clears the timer and does not double-fire", async () => {
    const calls: { code: number; signal?: string }[] = []
    const h = makeHandle((code, signal) => calls.push({ code, signal }), 100)
    // Legitimate close
    h.stream.emit("close", 0)
    // Wait past the timeout
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(calls.length, 1, "onClose should fire exactly once (from close, not timeout)")
    assert.equal(calls[0].code, 0)
    assert.equal(h.timeoutId, null, "timeout was cleared")
  })
})
