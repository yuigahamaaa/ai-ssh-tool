import { posixDialect } from "./posix.js"
import type { DialectSpec } from "./types.js"

export type { DialectKind, DialectSpec } from "./types.js"
export { posixDialect } from "./posix.js"

/** Phase 1：恒返回 posix。Phase 2 起按 sessionKey/hint 查缓存。 */
export function getDialect(_sessionKey?: string): DialectSpec {
  return posixDialect
}
