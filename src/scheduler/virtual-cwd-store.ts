import type { VirtualCwdState } from "./types.js"
import type { PersistenceStore } from "./persistence-store.js"

export class VirtualCwdStore {
  private map = new Map<string, VirtualCwdState>()
  private persistence: PersistenceStore

  constructor(persistence: PersistenceStore) {
    this.persistence = persistence
    this.loadFromDisk()
  }

  private loadFromDisk(): void {
    const data = this.persistence.loadVirtualCwdMap()
    for (const [key, value] of Object.entries(data)) {
      this.map.set(key, value)
    }
  }

  private persist(): void {
    const obj: Record<string, VirtualCwdState> = {}
    for (const [key, value] of this.map) {
      obj[key] = value
    }
    this.persistence.saveVirtualCwdMap(obj)
  }

  private static key(agentId: string, hostId: string): string {
    return `${agentId}:${hostId}`
  }

  set(agentId: string, hostId: string, cwd: string): VirtualCwdState {
    const k = VirtualCwdStore.key(agentId, hostId)
    const state: VirtualCwdState = {
      key: k,
      agentId,
      hostId,
      cwd,
      updatedAt: Date.now(),
    }
    this.map.set(k, state)
    this.persist()
    return state
  }

  resolve(agentId: string, hostId: string, explicitCwd?: string): string | undefined {
    if (explicitCwd) return explicitCwd
    const k = VirtualCwdStore.key(agentId, hostId)
    return this.map.get(k)?.cwd
  }

  get(agentId: string, hostId: string): VirtualCwdState | undefined {
    return this.map.get(VirtualCwdStore.key(agentId, hostId))
  }

  getAll(): VirtualCwdState[] {
    return Array.from(this.map.values())
  }
}
