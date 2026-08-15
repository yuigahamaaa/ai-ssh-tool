import type { DetectedDialect } from "./detect.js"

const CACHE_TTL_MS = 10 * 60 * 1000
const cache = new Map<string, DetectedDialect>()

export function hostIdOf(host: string, port: number, username: string): string {
  return `${username}@${host}:${port}`
}

export function getCachedDialect(id: string): DetectedDialect | undefined {
  const entry = cache.get(id)
  if (!entry) return undefined
  if (Date.now() - entry.detectedAt > CACHE_TTL_MS) {
    cache.delete(id)
    return undefined
  }
  return entry
}

export function putCachedDialect(id: string, detected: DetectedDialect): void {
  cache.set(id, detected)
}

export function clearDialectCache(): void {
  cache.clear()
}
