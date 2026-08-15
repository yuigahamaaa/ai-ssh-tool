import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { powershellDialect } from "../remote-dialect/powershell.js"

/** 解码 -EncodedCommand 外层，还原 PS 脚本原文。 */
function decodePS(cmd: string): string {
  const m = cmd.match(
    /^powershell -NoLogo -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand (\S+)$/,
  )
  assert.ok(m, `expected powershell -EncodedCommand wrapper, got: ${cmd}`)
  return Buffer.from(m![1], "base64").toString("utf16le")
}

describe("powershellDialect", () => {
  it("buildExec wraps via -EncodedCommand and decodes to the exact PS source", () => {
    const script = decodePS(powershellDialect.buildExec("echo ok"))
    assert.ok(script.includes('[Console]::Error.WriteLine("SSH_TOOL_PID:$PID")'))
    assert.ok(script.includes("Invoke-Expression -Command 'echo ok'"))
  })

  it("preserves quotes, backslashes, pipes and $ inside the user command", () => {
    const cmd = `Get-ChildItem 'C:\\Program Files' | Where-Object { $_.Name -like "*.log" }`
    const script = decodePS(powershellDialect.buildExec(cmd))
    // 反斜杠/管道/$/双引号原样保留；单引号按 PS 规则双写（''），这是唯一转换。
    const expected = `Invoke-Expression -Command '${cmd.replace(/'/g, "''")}'`
    assert.ok(script.includes(expected))
  })

  it("injects cwd and env before the user command", () => {
    const script = decodePS(
      powershellDialect.buildExec("echo ok", { cwd: "C:\\tmp a", env: { K: "v x" } }),
    )
    assert.ok(script.includes(`Set-Location -LiteralPath 'C:\\tmp a'`))
    assert.ok(script.includes(`$env:K = 'v x'`))
    assert.ok(script.indexOf("Invoke-Expression") > script.indexOf("Set-Location"))
  })

  it("escapes single quotes in values and commands by doubling them", () => {
    const script = decodePS(powershellDialect.buildExec("echo it's", { env: { K: "a'b" } }))
    assert.ok(script.includes(`$env:K = 'a''b'`))
    assert.ok(script.includes(`Invoke-Expression -Command 'echo it''s'`))
  })

  it("buildKill stops a single process and taskkills a tree", () => {
    assert.equal(
      powershellDialect.buildKill(4321),
      'powershell -NoProfile -Command "Stop-Process -Id 4321 -Force -ErrorAction SilentlyContinue"',
    )
    assert.equal(powershellDialect.buildKill(4321, { group: true }), "taskkill /PID 4321 /T /F")
  })

  it("buildBackground starts a hidden detached process via Start-Process -PassThru", () => {
    const script = decodePS(powershellDialect.buildBackground("sleep 10"))
    assert.ok(script.includes("Start-Process"))
    assert.ok(script.includes("-WindowStyle Hidden"))
    assert.ok(script.includes("-PassThru"))
    assert.ok(script.includes("SSH_TOOL_PID"))
  })

  it("pidMarkerPattern captures the $PID marker", () => {
    const m = "SSH_TOOL_PID:1234\n".match(powershellDialect.pidMarkerPattern())
    assert.equal(m?.[1], "1234")
  })

  it("buildCwdResolve / isValidAbsPath / supportsSemicolonSplit are Windows-shaped", () => {
    assert.equal(powershellDialect.isValidAbsPath("C:\\Users\\x"), true)
    assert.equal(powershellDialect.isValidAbsPath("C:/Users/x"), true)
    assert.equal(powershellDialect.isValidAbsPath("/tmp"), false)
    assert.equal(powershellDialect.supportsSemicolonSplit(), false)
    assert.ok(powershellDialect.buildCwdResolve("C:\\x").includes("Set-Location"))
  })
})
