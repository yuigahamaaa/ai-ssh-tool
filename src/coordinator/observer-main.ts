#!/usr/bin/env node

import { UnixSocketCoordinatorTransport } from "./client.js"
import { SshToolObserver, createSystemObserverReaders } from "./observer.js"
import type { ObservedProcess, ObservedSession } from "./protocol.js"

const transport = new UnixSocketCoordinatorTransport(process.env.SSH_TOOL_COORDINATOR_OBSERVER_SOCKET ?? "/run/ssh-tool-coordinator/observer.sock")
const observer = new SshToolObserver(createSystemObserverReaders(), {
  async submit(sessions: ObservedSession[], processes: ObservedProcess[]): Promise<void> {
    const response = await transport.request({ action: "submitObservation", protocolVersion: 1, sessions, processes })
    if (!response.ok) throw new Error(response.message)
  },
})

await observer.scan()
observer.start()
const shutdown = (): void => { observer.stop(); process.exit(0) }
process.once("SIGTERM", shutdown)
process.once("SIGINT", shutdown)
