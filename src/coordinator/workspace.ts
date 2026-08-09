export function normalizeWorkspace(value: string): string {
  if (typeof value !== "string" || value.length === 0 || !value.startsWith("/")) {
    throw new Error("INVALID_WORKSPACE: workspace must be an absolute path")
  }
  const parts: string[] = []
  for (const part of value.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") {
      if (parts.length === 0) throw new Error("INVALID_WORKSPACE: workspace escapes root")
      parts.pop()
      continue
    }
    parts.push(part)
  }
  return parts.length === 0 ? "/" : `/${parts.join("/")}`
}

export function workspacesOverlap(left: string, right: string): boolean {
  const a = normalizeWorkspace(left)
  const b = normalizeWorkspace(right)
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}
