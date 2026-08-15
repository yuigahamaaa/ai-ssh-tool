import type { Client } from "ssh2"
import { log } from "../logger.js"
import type { DialectKind } from "./types.js"

export interface DetectedDialect {
  kind: DialectKind
  /** 二级探测：posix → gnu|busybox|darwin|bsd；windows → powershell|cmd（推荐执行方言） */
  sub?: string
  detectedAt: number
}

/** 三态探针：必须不经任何 wrapper 直接交给远端默认 shell。 */
export const PROBE_COMMAND = "echo __A__%OS%__B__$env:OS__C__"

export function classifyProbeOutput(output: string): DialectKind {
  // cmd 展开了 %OS% 但留下 $env:OS 字面量
  if (output.includes("$env:OS")) return "cmd"
  // PowerShell 展开了 $env:OS（__B__Windows_NT__C__）但留下 %OS% 字面量
  if (output.includes("__B__Windows_NT__C__")) return "powershell"
  // 两端标记都在、无展开 → posix
  if (/__A__.*__B__.*__C__/.test(output)) return "posix"
  // 输出畸形（受限 shell 等）→ 保守回退 posix
  log("dialect", "probe output ambiguous, fallback posix")
  return "posix"
}

function rawExec(
  client: Client,
  command: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code?: number }> {
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const settle = (v: { stdout: string; stderr: string; code?: number }) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(v)
    }
    timer = setTimeout(() => settle({ stdout: "", stderr: "" }), timeoutMs)
    try {
      client.exec(command, (err, stream) => {
        if (err) {
          settle({ stdout: "", stderr: "" })
          return
        }
        const out: string[] = []
        const errOut: string[] = []
        stream.on("data", (d: Buffer) => out.push(d.toString()))
        stream.stderr.on("data", (d: Buffer) => errOut.push(d.toString()))
        stream.on("close", (code?: number) => settle({ stdout: out.join(""), stderr: errOut.join(""), code }))
        stream.on("error", () => settle({ stdout: out.join(""), stderr: errOut.join("") }))
      })
    } catch {
      settle({ stdout: "", stderr: "" })
    }
  })
}

export async function probeAndDetect(client: Client, timeoutMs = 2000): Promise<DetectedDialect> {
  const probe = await rawExec(client, PROBE_COMMAND, timeoutMs)
  const kind = classifyProbeOutput(probe.stdout + probe.stderr)
  const detected: DetectedDialect = { kind, detectedAt: Date.now() }

  if (kind === "posix") {
    const uname = await rawExec(client, "uname -s 2>/dev/null || true", timeoutMs)
    const u = (uname.stdout + uname.stderr).trim()
    if (u.startsWith("Darwin")) detected.sub = "darwin"
    else if (u.includes("BSD")) detected.sub = "bsd"
    else if (u.startsWith("Linux")) {
      const busybox = await rawExec(client, "busybox 2>&1 || true", timeoutMs)
      detected.sub = /BusyBox/i.test(busybox.stdout + busybox.stderr) ? "busybox" : "gnu"
    }
  } else {
    const ps = await rawExec(client, 'powershell -NoProfile -Command "exit 0"', timeoutMs)
    detected.sub = ps.code === 0 ? "powershell" : "cmd"
  }
  return detected
}
