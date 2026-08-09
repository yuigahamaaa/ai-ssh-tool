import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { normalizeWorkspace, workspacesOverlap } from "../coordinator/workspace.js"

describe("coordinator workspace", () => {
  it("normalizes absolute paths", () => {
    assert.equal(normalizeWorkspace("/srv/app/../app//api/"), "/srv/app/api")
    assert.equal(normalizeWorkspace("/"), "/")
  })

  it("rejects relative and escaping paths", () => {
    assert.throws(() => normalizeWorkspace("srv/app"), /absolute path/)
    assert.throws(() => normalizeWorkspace("/../../etc"), /escapes root/)
  })

  it("detects path-boundary overlap", () => {
    assert.equal(workspacesOverlap("/srv/app", "/srv/app/api"), true)
    assert.equal(workspacesOverlap("/srv/app", "/srv/application"), false)
    assert.equal(workspacesOverlap("/srv/app/", "/srv/app"), true)
  })
})
