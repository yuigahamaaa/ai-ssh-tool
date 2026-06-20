import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  handleMcpFind,
  handleMcpGrep,
  handleMcpListDir,
  handleMcpReadFile,
  handleMcpStat,
} from "../mcp-file-tools.js"
import type { ExecResult } from "../remote-shell.js"

function execWith(outputs: Array<Partial<ExecResult> & { stdout: string }>) {
  const commands: string[] = []
  const exec = async (_client: unknown, command: string): Promise<ExecResult> => {
    commands.push(command)
    const next = outputs.shift()
    if (!next) throw new Error(`unexpected command: ${command}`)
    return {
      stdout: next.stdout,
      stderr: next.stderr ?? "",
      code: next.code ?? 0,
      signal: next.signal,
    }
  }
  return { exec, commands }
}

describe("MCP file tool handlers", () => {
  it("reads metadata first and does not cat the whole file", async () => {
    const { exec, commands } = execWith([
      { stdout: "size_bytes=12\ntotal_lines=2\nbinary_detected=false\nencoding=utf-8\n" },
      { stdout: "hello\nworld\n" },
    ])

    const result = await handleMcpReadFile({ client: {} as any, remoteExec: exec as any, path: "/tmp/a.txt", offset: 4, limit: 2 })

    assert.equal(result.ok, true)
    assert.ok(result.data)
    assert.equal(result.data.content, "5\thello\n6\tworld")
    assert.equal(commands.length, 2)
    assert.match(commands[0], /size_bytes=/)
    assert.match(commands[1], /sed -n '5,6p'/)
    assert.ok(commands.every(command => !/\bcat\b/.test(command)))
  })

  it("reports binary files without issuing a content read", async () => {
    const { exec, commands } = execWith([
      { stdout: "size_bytes=99\ntotal_lines=0\nbinary_detected=true\nencoding=utf-8\n" },
    ])

    const result = await handleMcpReadFile({ client: {} as any, remoteExec: exec as any, path: "/tmp/blob.bin" })

    assert.equal(result.ok, true)
    assert.ok(result.data)
    assert.equal(result.data.binaryDetected, true)
    assert.equal(result.data.content, "")
    assert.equal(commands.length, 1)
    assert.ok(result.agentGuidance[0].includes("ssh_download"))
  })

  it("returns structured list/stat/grep/find data", async () => {
    const list = await handleMcpListDir({
      client: {} as any,
      remoteExec: execWith([{ stdout: "a.txt\tf\t1\t644\t2\t/tmp/a.txt\n" }]).exec as any,
      path: "/tmp",
      showHidden: false,
    })
    assert.ok(list.data)
    assert.equal(list.data.entries[0].name, "a.txt")

    const stat = await handleMcpStat({
      client: {} as any,
      remoteExec: execWith([{ stdout: "regular file\t1\t644\tme\tstaff\t2\t/tmp/a.txt\n" }]).exec as any,
      path: "/tmp/a.txt",
    })
    assert.ok(stat.data)
    assert.equal(stat.data.type, "file")

    const grep = await handleMcpGrep({
      client: {} as any,
      remoteExec: execWith([{ stdout: "/tmp/a.txt\x001:needle\n" }]).exec as any,
      pattern: "needle",
      path: "/tmp",
    })
    assert.ok(grep.data)
    assert.equal(grep.data.matches[0].text, "needle")

    const find = await handleMcpFind({
      client: {} as any,
      remoteExec: execWith([{ stdout: "/tmp/a.txt\tf\t1\t2\n" }]).exec as any,
      path: "/tmp",
      type: "f",
    })
    assert.ok(find.data)
    assert.equal(find.data.results[0].type, "file")
  })

  it("falls back when GNU-only commands are unavailable", async () => {
    const listExec = execWith([
      { stdout: "", stderr: "find: -printf: unknown", code: 1 },
      { stdout: "a.txt\tf\t1\t-rw-r--r--\t0\t/tmp/a.txt\n" },
    ])
    const list = await handleMcpListDir({
      client: {} as any,
      remoteExec: listExec.exec as any,
      path: "/tmp",
    })
    assert.ok(list.data)
    assert.equal(list.data.entries[0].mode, "644")
    assert.equal(listExec.commands.length, 2)

    const statExec = execWith([
      { stdout: "", stderr: "stat: illegal option", code: 1 },
      { stdout: "file\t1\t-rw-r-----\t1000\t1000\t0\t/tmp/a.txt\n" },
    ])
    const stat = await handleMcpStat({
      client: {} as any,
      remoteExec: statExec.exec as any,
      path: "/tmp/a.txt",
    })
    assert.ok(stat.data)
    assert.equal(stat.data.mode, "640")

    const grepExec = execWith([
      { stdout: "", stderr: "grep: illegal option -- Z", code: 2 },
      { stdout: "/tmp/a.txt:3:needle\n" },
    ])
    const grep = await handleMcpGrep({
      client: {} as any,
      remoteExec: grepExec.exec as any,
      pattern: "needle",
      path: "/tmp",
    })
    assert.ok(grep.data)
    assert.equal(grep.data.matches[0].line, 3)

    const findExec = execWith([
      { stdout: "", stderr: "find: -printf: unknown", code: 1 },
      { stdout: "/tmp/a.txt\tf\t1\t0\n" },
    ])
    const find = await handleMcpFind({
      client: {} as any,
      remoteExec: findExec.exec as any,
      path: "/tmp",
    })
    assert.ok(find.data)
    assert.equal(find.data.results[0].path, "/tmp/a.txt")
  })
})
