import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { assertEnvName, assertOctalMode, shellQuote } from "../shell-quote.js"

describe("shellQuote", () => {
  it("single-quotes shell arguments so command substitution stays literal", () => {
    const quoted = shellQuote("/tmp/$(touch injected)`whoami` $HOME 'x'")

    assert.equal(quoted, "'/tmp/$(touch injected)`whoami` $HOME '\\''x'\\'''")
  })

  it("is safe to evaluate as one literal shell argument", async () => {
    const value = "/tmp/$(printf injected)`printf bad` $HOME 'x'"
    const { execFile } = await import("node:child_process")
    const result = await new Promise<string>((resolve, reject) => {
      execFile("sh", ["-c", `printf '%s' ${shellQuote(value)}`], (err, stdout) => {
        if (err) reject(err)
        else resolve(stdout)
      })
    })

    assert.equal(result, value)
  })
})

describe("assertOctalMode", () => {
  it("accepts 3 or 4 digit octal modes", () => {
    assert.equal(assertOctalMode("644"), "644")
    assert.equal(assertOctalMode("0755"), "0755")
  })

  it("rejects shell metacharacters and invalid octal digits", () => {
    assert.throws(() => assertOctalMode("644; touch /tmp/pwned"), /Invalid file mode/)
    assert.throws(() => assertOctalMode("888"), /Invalid file mode/)
  })
})

describe("assertEnvName", () => {
  it("accepts shell-compatible environment variable names", () => {
    assert.equal(assertEnvName("FOO"), "FOO")
    assert.equal(assertEnvName("_BAR_1"), "_BAR_1")
  })

  it("rejects names that could inject shell syntax", () => {
    assert.throws(() => assertEnvName("BAD=1; touch /tmp/pwned"), /Invalid environment variable name/)
    assert.throws(() => assertEnvName("1BAD"), /Invalid environment variable name/)
  })
})
