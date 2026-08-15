import type { Client } from "ssh2"
import { log } from "../logger.js"
import { posixDialect } from "./posix.js"
import { probeAndDetect, type DetectedDialect } from "./detect.js"
import { getCachedDialect, putCachedDialect, hostIdOf } from "./cache.js"
import type { DialectKind, DialectSpec } from "./types.js"

export type { DialectKind, DialectSpec } from "./types.js"
export { posixDialect } from "./posix.js"
export { classifyProbeOutput, probeAndDetect, type DetectedDialect } from "./detect.js"
export { clearDialectCache, getCachedDialect } from "./cache.js"

/** Phase 2：仅 posix 方言已实现；powershell/cmd 在 P3/P4 落地后切换。 */
function dialectForKind(kind: DialectKind): DialectSpec {
  return posixDialect
}

/** 返回远端方言：hint > 缓存 > posix 兜底。 */
export function getDialect(
  sessionKey?: string,
  hint?: "posix" | "powershell" | "cmd",
): DialectSpec {
  const kind = hint ?? (sessionKey ? getCachedDialect(sessionKey)?.kind : undefined) ?? "posix"
  return dialectForKind(kind)
}

/** 探测并缓存（幂等：新鲜缓存直接返回）。 */
export async function detectAndCache(
  client: Client,
  host: string,
  port: number,
  username: string,
): Promise<DetectedDialect> {
  const id = hostIdOf(host, port, username)
  const fresh = getCachedDialect(id)
  if (fresh) return fresh
  const detected = await probeAndDetect(client)
  putCachedDialect(id, detected)
  log("dialect", `detected ${detected.kind}${detected.sub ? `/${detected.sub}` : ""} for ${id}`)
  return detected
}
