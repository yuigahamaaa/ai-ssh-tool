import { describe, it, mock } from "node:test"
import assert from "node:assert/strict"

/**
 * P2-7: silent error swallowing. We added log() statements to the two
 * places that previously dropped malformed IPC lines on the floor. The
 * regression test exercises the lower-level line handler (used by the
 * incremental parser) and confirms the callback is still invoked for
 * well-formed lines even when adjacent lines fail to parse.
 *
 * Note: we test through parseMessages() / emitLine()'s observable
 * behaviour — onMessage is called for valid lines, never for the
 * malformed ones. The log() call side-effect is intentionally not
 * asserted (it's debug-only) — what matters is that valid lines
 * aren't blocked by a bad neighbour.
 */

import { IPCMessageParser } from "../ipc-protocol.js"

describe("IPC parser P2-7: malformed lines are dropped without breaking neighbours", () => {
  it("valid lines are still delivered when a malformed line is interleaved", () => {
    const parser = new IPCMessageParser(64 * 1024)
    const received: any[] = []
    // 1. valid line, 2. malformed, 3. valid line. Each separated by \n.
    const payload = Buffer.from(
      JSON.stringify({ id: "1", action: "ping" }) +
        "\n" +
        "this is not json\n" +
        JSON.stringify({ id: "2", action: "ping" }) +
        "\n",
      "utf8",
    )
    parser.push(payload, (msg) => received.push(msg))
    assert.equal(received.length, 2)
    assert.equal(received[0].id, "1")
    assert.equal(received[1].id, "2")
  })

  it("chunked delivery: a malformed line in a later chunk doesn't drop earlier ones", () => {
    const parser = new IPCMessageParser(64 * 1024)
    const received: any[] = []
    parser.push(Buffer.from(JSON.stringify({ id: "first" }) + "\n", "utf8"), (m) => received.push(m))
    parser.push(Buffer.from("not json\n" + JSON.stringify({ id: "second" }) + "\n", "utf8"), (m) => received.push(m))
    assert.equal(received.length, 2)
    assert.equal(received[0].id, "first")
    assert.equal(received[1].id, "second")
  })

  it("back-to-back malformed lines don't crash the parser", () => {
    const parser = new IPCMessageParser(64 * 1024)
    const received: any[] = []
    parser.push(Buffer.from("garbage1\ngarbage2\ngarbage3\n", "utf8"), (m) => received.push(m))
    parser.push(Buffer.from(JSON.stringify({ id: "after-storm" }) + "\n", "utf8"), (m) => received.push(m))
    assert.equal(received.length, 1)
    assert.equal(received[0].id, "after-storm")
  })
})
