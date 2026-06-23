import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:net"
import { DaemonClient } from "../daemon-client.js"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("DaemonClient daemon IPC compatibility", () => {
  it("tries legacy daemon socket candidates when the preferred socket is absent", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "daemon-client-compat-"))
    const preferred = process.platform === "win32"
      ? `\\\\.\\pipe\\ssh-tool-test-missing-${process.pid}-${Date.now()}`
      : join(tmp, "missing.sock")
    const legacy = process.platform === "win32"
      ? `\\\\.\\pipe\\ssh-tool-test-legacy-${process.pid}-${Date.now()}`
      : join(tmp, "legacy.sock")

    let connected = false
    const server = createServer((socket) => {
      connected = true
      socket.end()
    })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(legacy, resolve)
      })

      const client = new DaemonClient([preferred, legacy])
      await client.connect()
      client.disconnect()
      assert.equal(connected, true)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("does not continue to fallback candidates after an explicit disconnect", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "daemon-client-disconnect-"))
    const preferred = process.platform === "win32"
      ? `\\\\.\\pipe\\ssh-tool-test-disconnect-missing-${process.pid}-${Date.now()}`
      : join(tmp, "missing.sock")
    const legacy = process.platform === "win32"
      ? `\\\\.\\pipe\\ssh-tool-test-disconnect-legacy-${process.pid}-${Date.now()}`
      : join(tmp, "legacy.sock")

    let connected = false
    const server = createServer((socket) => {
      connected = true
      socket.end()
    })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(legacy, resolve)
      })

      const client = new DaemonClient([preferred, legacy])
      const connectPromise = client.connect()
      client.disconnect()
      await assert.rejects(() => connectPromise, /disconnected/)
      await new Promise((resolve) => setTimeout(resolve, 25))
      assert.equal(connected, false)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
