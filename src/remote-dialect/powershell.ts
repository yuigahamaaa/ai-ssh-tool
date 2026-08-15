import { assertEnvName } from "../shell-quote.js"
import type { DialectSpec } from "./types.js"

/** PS 单引号字符串：唯一特殊字符是 '，转义为 ''。 */
export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** UTF-16LE→Base64，供 -EncodedCommand 使用（PS 5.1+，无 BOM 可接受）。 */
export function encodePS(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64")
}

export const powershellDialect: DialectSpec = {
  kind: "powershell",

  buildExec(command, opts) {
    const lines: string[] = []
    lines.push('[Console]::Error.WriteLine("SSH_TOOL_PID:$PID")')
    if (opts?.cwd) lines.push(`Set-Location -LiteralPath ${psQuote(opts.cwd)}`)
    if (opts?.env) {
      for (const [k, v] of Object.entries(opts.env)) {
        lines.push(`$env:${assertEnvName(k)} = ${psQuote(v)}`)
      }
    }
    lines.push(`Invoke-Expression -Command ${psQuote(command)}`)
    return `powershell -NoLogo -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand ${encodePS(lines.join("\n"))}`
  },

  buildBackground(command, opts) {
    const inner: string[] = []
    if (opts?.cwd) inner.push(`Set-Location -LiteralPath ${psQuote(opts.cwd)}`)
    inner.push(`Invoke-Expression -Command ${psQuote(command)}`)
    const innerEncoded = encodePS(inner.join("\n"))
    // -ArgumentList 各项单引号包裹；Base64 无空格/引号，无二次拆词风险。
    const outer =
      `$p = Start-Process -FilePath "powershell" -ArgumentList '-NoProfile','-EncodedCommand','${innerEncoded}' -WindowStyle Hidden -PassThru; ` +
      '[Console]::Error.WriteLine("SSH_TOOL_PID:" + $p.Id)'
    return `powershell -NoLogo -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand ${encodePS(outer)}`
  },

  buildKill(pid, opts) {
    // Stop-Process 不杀进程树；组终止用 taskkill /T /F。
    if (opts?.group) return `taskkill /PID ${pid} /T /F`
    return `powershell -NoProfile -Command "Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue"`
  },

  pidMarkerPattern() {
    return /SSH_TOOL_PID:(\d+)/
  },

  buildCwdResolve(baseCwd) {
    return baseCwd
      ? `Set-Location -LiteralPath ${psQuote(baseCwd)}; (Get-Location).Path`
      : "(Get-Location).Path"
  },

  isValidAbsPath(path) {
    return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\")
  },

  supportsSemicolonSplit() {
    // 命令整体交给 Invoke-Expression，分号由 PS 解析器处理，不做顶层拆分。
    return false
  },
}
