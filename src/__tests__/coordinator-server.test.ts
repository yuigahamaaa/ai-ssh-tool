import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { connect } from "net"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { CoordinatorServer } from "../coordinator/server.js"
import { CoordinatorStore } from "../coordinator/store.js"
import { createClientIdentity } from "../coordinator/protocol.js"

async function request(path: string, value: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = connect(path)
    let data = ""
    socket.setEncoding("utf8")
    socket.on("connect", () => socket.write(`${JSON.stringify(value)}\n`))
    socket.on("data", (chunk) => {
      data += chunk
      const line = data.indexOf("\n")
      if (line >= 0) { socket.destroy(); resolve(JSON.parse(data.slice(0, line))) }
    })
    socket.on("error", reject)
  })
}

describe("coordinator server", () => {
  it("serves health and lease requests over unix sockets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "coordinator-server-"))
    const socketPath = join(dir, "coordinator.sock")
    const observerSocketPath = join(dir, "observer.sock")
    const server = new CoordinatorServer({ socketPath, observerSocketPath, store: new CoordinatorStore() })
    await server.start()
    const health = await request(socketPath, { action: "health", protocolVersion: 1 })
    assert.equal(health.ok, true)
    const client = createClientIdentity("alice", "alice", "2.0.0")
    const registration = await request(socketPath, { action: "registerClient", protocolVersion: 1, client })
    assert.equal(registration.ok, true)
    const observationRejected = await request(socketPath, { action: "submitObservation", protocolVersion: 1, sessions: [], processes: [] })
    assert.equal(observationRejected.ok, false)
    const observation = await request(observerSocketPath, { action: "submitObservation", protocolVersion: 1, sessions: [], processes: [] })
    assert.equal(observation.ok, true)
    await server.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  it("rejects malformed requests without stopping", async () => {
    const dir = mkdtempSync(join(tmpdir(), "coordinator-server-"))
    const socketPath = join(dir, "coordinator.sock")
    const server = new CoordinatorServer({ socketPath, store: new CoordinatorStore() })
    await server.start()
    const response = await request(socketPath, "{")
    assert.equal(response.ok, false)
    assert.equal(response.errorCode, "INVALID_REQUEST")
    const health = await request(socketPath, { action: "health", protocolVersion: 1 })
    assert.equal(health.ok, true)
    await server.stop()
    rmSync(dir, { recursive: true, force: true })
  })
})
