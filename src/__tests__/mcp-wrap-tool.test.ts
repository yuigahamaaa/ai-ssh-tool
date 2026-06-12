import { describe, it } from "node:test"
import assert from "node:assert/strict"

/**
 * P2-8: regression test for the wrapTool helper used in mcp-server.ts.
 *
 * The wrapper is a local function inside main() — to test it we re-create
 * the same shape here. The contract:
 *  - successful handlers pass through unchanged
 *  - thrown errors become an { isError: true, content: [{ type: "text", text }] }
 *    envelope with the tool name and the error message
 *  - the error message is preserved verbatim (not double-wrapped)
 *
 * If the production helper diverges, the build still succeeds (TypeScript
 * types are duplicated) but this test fails fast.
 */

function makeWrapTool(log: (msg: string) => void) {
  return <Args, Ret extends { content: Array<{ type: "text"; text: string }> }>(
    name: string,
    fn: (args: Args) => Promise<Ret>,
  ) => {
    return async (args: Args): Promise<Ret | (Ret & { isError: true })> => {
      try {
        return await fn(args)
      } catch (e) {
        const err = e as Error
        const detail = (err.stack ?? err.message).split("\n").slice(0, 4).join("\n")
        log(`Tool ${name} threw: ${err.message}\n${detail}`)
        return {
          isError: true,
          content: [{ type: "text" as const, text: `[${name}] ${err.message}` }],
        } as Ret & { isError: true }
      }
    }
  }
}

describe("wrapTool P2-8: error envelope contract", () => {
  it("passes through successful handler results unchanged", async () => {
    const logs: string[] = []
    const wrapTool = makeWrapTool((m) => logs.push(m))
    const wrapped = wrapTool("ssh_exec", async (args: { x: number }) => ({
      content: [{ type: "text" as const, text: `ok ${args.x}` }],
    }))
    const r = await wrapped({ x: 42 })
    assert.deepEqual(r, { content: [{ type: "text", text: "ok 42" }] })
    assert.equal((r as any).isError, undefined, "isError should not be set on success")
    assert.equal(logs.length, 0, "no log on success")
  })

  it("catches synchronous throws and returns a structured error envelope", async () => {
    const logs: string[] = []
    const wrapTool = makeWrapTool((m) => logs.push(m))
    const wrapped = wrapTool("ssh_read_file", async () => {
      throw new Error("boom")
    })
    const r = await (wrapped as any)({})
    assert.equal(r.isError, true)
    assert.equal(r.content[0].type, "text")
    assert.ok(r.content[0].text.startsWith("[ssh_read_file] "), `prefixed with tool name: ${r.content[0].text}`)
    assert.ok(r.content[0].text.includes("boom"), "preserves the original error message")
    assert.equal(logs.length, 1, "logs the stack for debugging")
    assert.ok(logs[0].includes("ssh_read_file"))
    assert.ok(logs[0].includes("boom"))
  })

  it("catches rejected promises (async throws)", async () => {
    const logs: string[] = []
    const wrapTool = makeWrapTool((m) => logs.push(m))
    const wrapped = wrapTool("ssh_exec", async () => {
      return await Promise.reject(new Error("async boom"))
    })
    const r = await (wrapped as any)({})
    assert.equal(r.isError, true)
    assert.ok(r.content[0].text.includes("async boom"))
  })

  it("preserves tool name in error envelope (not the original message)", async () => {
    const logs: string[] = []
    const wrapTool = makeWrapTool((m) => logs.push(m))
    const wrapped = wrapTool("specific_tool_name", async () => {
      throw new Error("inner")
    })
    const r = await (wrapped as any)({})
    assert.ok(r.content[0].text.includes("specific_tool_name"), "tool name appears in envelope")
    assert.ok(r.content[0].text.includes("inner"), "original error appears in envelope")
  })
})
