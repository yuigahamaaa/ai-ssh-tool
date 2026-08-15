import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { posixDialect } from "../remote-dialect/posix.js"

describe("posixDialect", () => {
  it("buildExec wraps a plain command byte-identically", () => {
    assert.equal(
      posixDialect.buildExec("echo ok"),
      `echo "SSH_TOOL_PID:$$" >&2; exec sh -c 'echo ok'`,
    )
  })

  it("buildExec composes env then cwd inside the sh -c string", () => {
    assert.equal(
      posixDialect.buildExec("echo ok", { cwd: "/tmp/a b", env: { K: "v x" } }),
      String.raw`echo "SSH_TOOL_PID:$$" >&2; exec sh -c 'export K='\''v x'\''; cd '\''/tmp/a b'\'' && echo ok'`,
    )
  })

  it("buildExec rejects invalid env names", () => {
    assert.throws(
      () => posixDialect.buildExec("x", { env: { "bad name": "v" } }),
      /Invalid environment variable name/,
    )
  })

  it("buildBackground reproduces the setsid form", () => {
    assert.equal(
      posixDialect.buildBackground("sleep 10"),
      `setsid sh -c 'echo "SSH_TOOL_PID:$$" >&2; exec sh -c "$1"' ssh-tool 'sleep 10'`,
    )
  })

  it("buildKill emits TERM then KILL with an integer sleep", () => {
    assert.equal(
      posixDialect.buildKill(4321),
      `kill -TERM 4321 2>/dev/null; sleep 1; kill -KILL 4321 2>/dev/null; true`,
    )
  })

  it("buildKill supports process-group and custom-signal variants", () => {
    assert.equal(
      posixDialect.buildKill(4321, { group: true, signal: "HUP" }),
      `kill -HUP -4321 2>/dev/null || kill -HUP 4321 2>/dev/null; sleep 1; kill -KILL -4321 2>/dev/null || kill -KILL 4321 2>/dev/null; true`,
    )
  })

  it("pidMarkerPattern captures the marker", () => {
    const m = "SSH_TOOL_PID:99\n".match(posixDialect.pidMarkerPattern())
    assert.equal(m?.[1], "99")
  })

  it("buildCwdResolve / isValidAbsPath / supportsSemicolonSplit are POSIX-shaped", () => {
    assert.equal(posixDialect.buildCwdResolve(), "pwd -P")
    assert.equal(posixDialect.buildCwdResolve("/base"), "cd '/base' && pwd -P")
    assert.equal(posixDialect.isValidAbsPath("/a"), true)
    assert.equal(posixDialect.isValidAbsPath("C:\\a"), false)
    assert.equal(posixDialect.supportsSemicolonSplit(), true)
  })
})
