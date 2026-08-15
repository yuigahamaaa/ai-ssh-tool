import type { DialectSpec } from "./types.js"

export const cmdDialect: DialectSpec = {
  kind: "cmd",

  // cmd 无可靠 PID 标记：写占位 "unavailable"，pidMarkerPattern（要求数字）不匹配，
  // pid 永不捕获 → 超时终止退化为只关 channel（remoteProcessMayContinue 语义已有）。
  buildExec(command, opts) {
    let body = command
    if (opts?.env) {
      const envPrefix = Object.entries(opts.env)
        .map(([k, v]) => `set "${k}=${v}"`)
        .join(" && ")
      body = `${envPrefix} && ${body}`
    }
    if (opts?.cwd) body = `cd /d "${opts.cwd}" && ${body}`
    return `cmd /d /s /c "echo SSH_TOOL_PID:unavailable 1>&2 & ${body}"`
  },

  buildBackground(command, opts) {
    let body = command
    if (opts?.cwd) body = `cd /d "${opts.cwd}" && ${body}`
    return `cmd /d /s /c "start /b cmd /d /s /c \\"${body}\\""`
  },

  buildKill(pid) {
    return `taskkill /PID ${pid} /T /F`
  },

  pidMarkerPattern() {
    return /SSH_TOOL_PID:(\d+)/
  },

  buildCwdResolve(baseCwd) {
    return baseCwd ? `cd /d "${baseCwd}" && cd` : "cd"
  },

  isValidAbsPath(path) {
    return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\")
  },

  supportsSemicolonSplit() {
    // cmd 用 & 分隔语句，不做顶层分号拆分。
    return false
  },
}
