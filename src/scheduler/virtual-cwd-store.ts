import type { VirtualCwdState } from "./types.js"
import type { PersistenceStore } from "./persistence-store.js"

const DEBOUNCE_MS = 1000

export class VirtualCwdStore {
  private map = new Map<string, VirtualCwdState>()
  private persistence: PersistenceStore
  private dirty = false
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  // Pre-allocate the snapshot object so debounced flushes don't re-allocate.
  private snapshot: Record<string, VirtualCwdState> = {}

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

  /**
   * Mark the in-memory map dirty and schedule a single coalesced flush 1s
   * later. Multiple `set()` calls within the window collapse into one disk
   * write. The flush is also forced on `flushNow()` / `dispose()` so callers
   * that need a synchronous barrier can get it.
   */
  private schedulePersist(): void {
    this.dirty = true
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flush()
    }, DEBOUNCE_MS)
  }

  /** Force an immediate flush. Safe to call when not dirty. */
  flushNow(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.flush()
  }

  private flush(): void {
    if (!this.dirty) return
    // Reset the snapshot object in-place to avoid GC churn from a fresh
    // allocation on every flush (which can be frequent under load).
    for (const k of Object.keys(this.snapshot)) {
      delete this.snapshot[k]
    }
    for (const [key, value] of this.map) {
      this.snapshot[key] = value
    }
    this.persistence.saveVirtualCwdMap(this.snapshot)
    this.dirty = false
  }

  /**
   * Release scheduler-owned resources (the debounce timer). After dispose(),
   * pending writes are flushed synchronously so no data is lost.
   */
  dispose(): void {
    this.flushNow()
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
    this.schedulePersist()
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
