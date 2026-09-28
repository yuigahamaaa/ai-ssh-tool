/** Build metadata is replaced in dist by scripts/write-build-info.js. */
export interface BuildInfo {
  version: string
  commit: string
  builtAt: string
}

export const buildInfo: BuildInfo = {
  version: "2.0.0",
  commit: "development",
  builtAt: "unknown",
}
