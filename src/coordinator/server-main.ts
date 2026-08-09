#!/usr/bin/env node

import { mkdirSync } from "fs"
import { dirname } from "path"
import { CoordinatorServer } from "./server.js"
import { CoordinatorStore } from "./store.js"

const socketPath = process.env.SSH_TOOL_COORDINATOR_SOCKET ?? "/run/ssh-tool-coordinator/coordinator.sock"
const observerSocketPath = process.env.SSH_TOOL_OBSERVER_SOCKET ?? "/run/ssh-tool-coordinator/observer.sock"
const dbPath = process.env.SSH_TOOL_COORDINATOR_DB ?? "/opt/ssh-tool-coordinator/data/state.db"
mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 })
const server = new CoordinatorServer({ socketPath, observerSocketPath, store: new CoordinatorStore(dbPath), version: process.env.SSH_TOOL_COORDINATOR_VERSION ?? "dev" })

await server.start()
const shutdown = async (): Promise<void> => {
  await server.stop()
  process.exit(0)
}
process.once("SIGTERM", () => { void shutdown() })
process.once("SIGINT", () => { void shutdown() })
