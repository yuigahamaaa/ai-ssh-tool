#!/usr/bin/env node

import { createInterface } from "readline"
import { UnixSocketCoordinatorTransport, RemoteCoordinatorClient } from "./client.js"
import { parseCoordinatorRequest } from "./protocol.js"

const socketPath = process.env.SSH_TOOL_COORDINATOR_SOCKET ?? "/run/ssh-tool-coordinator/coordinator.sock"
const transport = new UnixSocketCoordinatorTransport(socketPath)
const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
let handled = false

input.on("line", async (line) => {
  if (handled || line.length > 64 * 1024) return
  handled = true
  try {
    const request = parseCoordinatorRequest(line)
    const response = await transport.request(request)
    process.stdout.write(`${JSON.stringify(response)}\n`)
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, errorCode: "COORDINATION_UNAVAILABLE", message: (error as Error).message })}\n`)
  } finally {
    input.close()
  }
})
