
import { randomUUID } from "crypto"
import type { SchedulerLock, LockScope } from "./types.js"

const DEFAULT_TTL = 30 * 60 * 1000

export class LockManager {
  private locks = new Map<string, SchedulerLock>()
  private ttl: number

  constructor(ttl?: number) {
    this.ttl = ttl ?? DEFAULT_TTL
  }

  private lockKey(scope: LockScope, key: string, hostId: string): string {
    return `${scope}:${hostId}:${key}`
  }

  acquire(
    scope: LockScope,
    key: string,
    hostId: string,
    agentId: string,
    taskId?: string,
    reason?: string
  ): SchedulerLock | null {
    const lockKey = this.lockKey(scope, key, hostId)
    this.cleanExpired()

    const existing = this.locks.get(lockKey)
    if (existing) {
      if (existing.ownerAgentId === agentId) {
        existing.renewedAt = Date.now()
        existing.expiresAt = existing.renewedAt + this.ttl
        return existing
      }
      return null
    }

    const lock: SchedulerLock = {
      id: `lock_${randomUUID().slice(0, 10)}`,
      scope,
      key,
      hostId,
      ownerAgentId: agentId,
      ownerTaskId: taskId,
      reason,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.ttl,
      renewedAt: Date.now(),
    }
    this.locks.set(lockKey, lock)
    return lock
  }

  release(lockId: string): boolean {
    for (const [key, lock] of this.locks.entries()) {
      if (lock.id === lockId) {
        this.locks.delete(key)
        return true
      }
    }
    return false
  }

  releaseForTask(taskId: string): void {
    const toRemove: string[] = []
    for (const [key, lock] of this.locks.entries()) {
      if (lock.ownerTaskId === taskId) {
        toRemove.push(key)
      }
    }
    for (const key of toRemove) {
      this.locks.delete(key)
    }
  }

  getLocksForHost(hostId: string): SchedulerLock[] {
    this.cleanExpired()
    return Array.from(this.locks.values()).filter(l => l.hostId === hostId)
  }

  getConflictingLocks(scope: LockScope, key: string, hostId: string): SchedulerLock[] {
    this.cleanExpired()
    const conflicts: SchedulerLock[] = []

    const checkKey = (s: LockScope, k: string) => {
      const lk = this.lockKey(s, k, hostId)
      const lock = this.locks.get(lk)
      if (lock) conflicts.push(lock)
    }

    if (scope === "host") {
      checkKey("host", key)
      for (const [k, lock] of this.locks.entries()) {
        if (lock.hostId === hostId) {
          conflicts.push(lock)
        }
      }
    } else if (scope === "workdir") {
      checkKey("host", key.split(":")[0])
      checkKey("workdir", key)
    } else {
      checkKey("host", key.split(":")[0])
      checkKey(scope, key)
    }

    return conflicts
  }

  renew(lockId: string): boolean {
    for (const lock of this.locks.values()) {
      if (lock.id === lockId) {
        lock.renewedAt = Date.now()
        lock.expiresAt = lock.renewedAt + this.ttl
        return true
      }
    }
    return false
  }

  private cleanExpired(): void {
    const now = Date.now()
    const toRemove: string[] = []
    for (const [key, lock] of this.locks.entries()) {
      if (lock.expiresAt < now) {
        toRemove.push(key)
      }
    }
    for (const key of toRemove) {
      this.locks.delete(key)
    }
  }
}
