import { posix as pathPosix } from "path"

export function remoteParentDir(path: string): string {
  const dir = pathPosix.dirname(path)
  return dir === "" ? "." : dir
}
