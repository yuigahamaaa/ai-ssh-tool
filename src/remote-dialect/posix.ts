import { assertEnvName, shellQuote } from "../shell-quote.js"
import type { DialectSpec } from "./types.js"

export const posixDialect: DialectSpec = {
  kind: "posix",

  buildExec(command, opts) {
    let full = command
    if (opts?.cwd) full = `cd ${shellQuote(opts.cwd)} && ${full}`
    if (opts?.env) {
      const envPrefix = Object.entries(opts.env)
        .map(([k, v]) => `export ${assertEnvName(k)}=${shellQuote(v)}`)
        .join(" ")
      full = `${envPrefix}; ${full}`
    }
    return `echo "SSH_TOOL_PID:$$" >&2; exec sh -c ${shellQuote(full)}`
  },

  buildBackground(command, opts) {
    let full = command
    if (opts?.cwd) full = `cd ${shellQuote(opts.cwd)} && ${full}`
    // setsid 缺失的环境（macOS 等）退回 nohup：`$!` 即被 exec 的最终命令 PID。
    const setsidForm = `setsid sh -c 'echo "SSH_TOOL_PID:$$" >&2; exec sh -c "$1"' ssh-tool ${shellQuote(full)}`
    const nohupForm = `nohup sh -c ${shellQuote(full)} >/dev/null 2>&1 & echo "SSH_TOOL_PID:$!" >&2`
    return `if command -v setsid >/dev/null 2>&1; then ${setsidForm}; else ${nohupForm}; fi`
  },

  buildKill(pid, opts) {
    const signal = opts?.signal ?? "TERM"
    if (opts?.group) {
      return `kill -${signal} -${pid} 2>/dev/null || kill -${signal} ${pid} 2>/dev/null; sleep 1; kill -KILL -${pid} 2>/dev/null || kill -KILL ${pid} 2>/dev/null; true`
    }
    return `kill -${signal} ${pid} 2>/dev/null; sleep 1; kill -KILL ${pid} 2>/dev/null; true`
  },

  pidMarkerPattern() {
    return /SSH_TOOL_PID:(\d+)/
  },

  buildCwdResolve(baseCwd) {
    return baseCwd ? `cd ${shellQuote(baseCwd)} && pwd -P` : "pwd -P"
  },

  isValidAbsPath(path) {
    return path.startsWith("/")
  },

  supportsSemicolonSplit() {
    return true
  },
}
