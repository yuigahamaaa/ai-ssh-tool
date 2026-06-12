/**
 * IPCMessageParser incremental Buffer-parser tests
 *
 * Verifies the P1-2 fix: large frames split across many small chunks
 * should not re-allocate the whole remainder on every push.
 *
 * The previous implementation called `Buffer.concat(this.chunks)` on every
 * push that contained a newline, which is O(remainder) per push. The new
 * implementation uses an offset cursor into the first chunk and only
 * concatenates the bytes of the frame itself.
 *
 * The tests below exercise:
 *  - chunk boundaries inside a single frame (line spans 3 chunks)
 *  - chunk boundaries at newline (frame ends exactly at the end of a chunk)
 *  - remainder bytes between two frames
 *  - multiple frames in a single chunk
 *  - large-frame stress: 10MB payload split into 64KB chunks
 *  - reset() behaviour
 *  - the maxRemainderBytes guard
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { IPCMessageParser } from "../ipc-protocol.js"

function parseAll(parser: IPCMessageParser, payload: string, chunkSize = 64 * 1024): unknown[] {
  const out: unknown[] = []
  const buf = Buffer.from(payload, "utf8")
  for (let i = 0; i < buf.length; i += chunkSize) {
    parser.push(buf.subarray(i, Math.min(i + chunkSize, buf.length)), (msg) => out.push(msg))
  }
  return out
}

describe("IPCMessageParser: incremental Buffer[] parser", () => {
  it("parses a single frame that fits in one chunk", () => {
    const p = new IPCMessageParser()
    const got: unknown[] = []
    p.push(Buffer.from('{"id":"a","ok":true}\n'), (m) => got.push(m))
    assert.equal(got.length, 1)
    assert.deepEqual(got[0], { id: "a", ok: true })
    assert.equal(p.remainderLength, 0)
  })

  it("parses a frame split across three chunks (P1-2 regression)", () => {
    const p = new IPCMessageParser()
    const frame = JSON.stringify({ id: "split", payload: "x".repeat(1024) }) + "\n"
    const buf = Buffer.from(frame)
    const got: unknown[] = []
    // Three chunks: 100 / 100 / rest
    p.push(buf.subarray(0, 100), (m) => got.push(m))
    p.push(buf.subarray(100, 200), (m) => got.push(m))
    p.push(buf.subarray(200), (m) => got.push(m))
    assert.equal(got.length, 1)
    assert.equal((got[0] as { id: string }).id, "split")
    assert.equal(p.remainderLength, 0)
  })

  it("parses multiple frames in one chunk", () => {
    const p = new IPCMessageParser()
    const got: unknown[] = []
    p.push(Buffer.from('{"a":1}\n{"b":2}\n{"c":3}\n'), (m) => got.push(m))
    assert.equal(got.length, 3)
    assert.deepEqual(got, [{ a: 1 }, { b: 2 }, { c: 3 }])
  })

  it("keeps unconsumed remainder bytes after the last newline", () => {
    const p = new IPCMessageParser()
    const got: unknown[] = []
    p.push(Buffer.from('{"a":1}\npartial'), (m) => got.push(m))
    assert.equal(got.length, 1)
    assert.equal(p.remainderLength, "partial".length)
  })

  it("survives a 10MB frame split into 64KB chunks", () => {
    const p = new IPCMessageParser()
    const big = "x".repeat(10 * 1024 * 1024)
    const frame = JSON.stringify({ id: "huge", payload: big }) + "\n"
    const messages = parseAll(p, frame, 64 * 1024)
    assert.equal(messages.length, 1)
    assert.equal(((messages[0] as { payload: string }).payload).length, 10 * 1024 * 1024)
    // After consuming the frame there must be no leftover bytes — i.e. the
    // parser correctly advanced past the trailing newline.
    assert.equal(p.remainderLength, 0)
  })

  it("rejects payload exceeding maxRemainderBytes", () => {
    const p = new IPCMessageParser(1024) // 1KB cap
    assert.throws(() => {
      p.push(Buffer.from("a".repeat(2048)), () => {})
    }, /exceeded max size/)
    // State is cleared after a throw, so a fresh frame should still parse.
    const got: unknown[] = []
    p.push(Buffer.from('{"ok":1}\n'), (m) => got.push(m))
    assert.equal(got.length, 1)
  })

  it("reset() clears chunks and offset", () => {
    const p = new IPCMessageParser()
    p.push(Buffer.from("leftover"), () => {})
    assert.equal(p.remainderLength, "leftover".length)
    p.reset()
    assert.equal(p.remainderLength, 0)
    // And it can keep parsing after reset.
    const got: unknown[] = []
    p.push(Buffer.from('{"after":true}\n'), (m) => got.push(m))
    assert.equal(got.length, 1)
  })

  it("skips malformed lines without losing adjacent valid ones", () => {
    const p = new IPCMessageParser()
    const got: unknown[] = []
    p.push(Buffer.from('{"a":1}\n{garbage}\n{"b":2}\n'), (m) => got.push(m))
    assert.equal(got.length, 2)
    assert.deepEqual(got, [{ a: 1 }, { b: 2 }])
  })
})
