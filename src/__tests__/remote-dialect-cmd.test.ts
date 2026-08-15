import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { cmdDialect } from "../remote-dialect/cmd.js"

describe("cmdDialect", () => {
  it("buildExec wraps with cmd /d /s /c and a non-numeric pid marker", () => {
    const wrapped = cmdDialect.buildExec("echo ok")
    assert.match(wrapped, /^cmd \/d \/s \/c "/)
    assert.ok(wrapped.includes("echo SSH_TOOL_PID:unavailable 1>&2 & echo ok"))
  })

  it("prepends set env and cd /d before the command", () => {
    const wrapped = cmdDialect.buildExec("dir", { cwd: "C:\\tmp", env: { K: "v" } })
    assert.ok(wrapped.includes('set "K=v"'))
    assert.ok(wrapped.includes('cd /d "C:\\tmp"'))
  })

  it("buildKill uses taskkill /T /F for single and group", () => {
    assert.equal(cmdDialect.buildKill(4321), "taskkill /PID 4321 /T /F")
    assert.equal(cmdDialect.buildKill(4321, { group: true }), "taskkill /PID 4321 /T /F")
  })

  it("pidMarkerPattern does NOT match the unavailable marker (no pid capture)", () => {
    assert.equal("SSH_TOOL_PID:unavailable\n".match(cmdDialect.pidMarkerPattern()), null)
  })

  it("buildBackground uses start /b", () => {
    assert.ok(cmdDialect.buildBackground("ping -t 1.1.1.1").includes("start /b"))
  })

  it("isValidAbsPath / supportsSemicolonSplit / buildCwdResolve are cmd-shaped", () => {
    assert.equal(cmdDialect.isValidAbsPath("C:\\a"), true)
    assert.equal(cmdDialect.isValidAbsPath("C:/a"), true)
    assert.equal(cmdDialect.isValidAbsPath("/a"), false)
    assert.equal(cmdDialect.supportsSemicolonSplit(), false)
    assert.ok(cmdDialect.buildCwdResolve("C:\\x").includes('cd /d "C:\\x"'))
  })
})
