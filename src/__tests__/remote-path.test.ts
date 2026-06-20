import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { remoteParentDir } from "../remote-path.js"

describe("remote path helpers", () => {
  it("uses current directory as parent for bare filenames", () => {
    assert.equal(remoteParentDir("app.log"), ".")
  })

  it("returns slash for files directly under root", () => {
    assert.equal(remoteParentDir("/app.log"), "/")
  })

  it("returns the containing directory for nested paths", () => {
    assert.equal(remoteParentDir("/var/log/app.log"), "/var/log")
  })
})
