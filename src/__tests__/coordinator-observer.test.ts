import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { SshToolObserver, type ObserverReaders } from "../coordinator/observer.js"
import { classifyProcess, toObservedProcess } from "../coordinator/observer-protocol.js"

describe("coordinator observer", () => {
  it("classifies common process activity and bounds commands", () => {
    assert.equal(classifyProcess("npm run build"), "build")
    assert.equal(classifyProcess("systemctl restart app"), "service")
    const observed = toObservedProcess({ pid: 10, parentPid: 1, uid: 1000, username: "alice", command: "x".repeat(20_000) }, 1000)
    assert.equal(observed.source, "process-observer")
    assert.equal(observed.confidence, "low")
    assert.equal(observed.commandTruncated, true)
  })

  it("scans injected readers and submits bounded observations", async () => {
    const submitted: any[] = []
    const readers: ObserverReaders = {
      async readSessions() { return [{ sessionId: "alice:pts/1", uid: 1000, username: "alice", tty: "pts/1" }] },
      async readProcesses() { return [{ pid: 10, parentPid: 1, uid: 1000, username: "alice", cwd: "/srv/app", command: "git status" }] },
    }
    const observer = new SshToolObserver(readers, { async submit(sessions, processes) { submitted.push({ sessions, processes }) } })
    await observer.scan(1000)
    assert.equal(submitted.length, 1)
    assert.equal(submitted[0].processes[0].command, "git status")
    observer.stop()
  })
})
