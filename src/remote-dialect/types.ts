export type DialectKind = "posix" | "powershell" | "cmd"

export interface DialectSpec {
  readonly kind: DialectKind
  /** 包装命令：PID 标记写到 stderr + 以正确方言执行用户命令 */
  buildExec(command: string, opts?: { cwd?: string; env?: Record<string, string> }): string
  /** 后台启动（POSIX: setsid；Windows: Start-Process / start /b） */
  buildBackground(command: string, opts?: { cwd?: string; env?: Record<string, string> }): string
  /** 终止进程。group=true 时先杀进程组（负 PGID）再回退单 PID */
  buildKill(pid: number, opts?: { group?: boolean; signal?: "TERM" | "HUP" | "KILL" }): string
  /** PID 标记正则（stderr 中捕获） */
  pidMarkerPattern(): RegExp
  /** cwd 解析命令（POSIX: pwd -P；Windows: Get-Location） */
  buildCwdResolve(baseCwd?: string): string
  /** 校验远端返回的绝对路径是否合法（/ 开头 vs 盘符） */
  isValidAbsPath(path: string): boolean
  /** 顶层分号拆分是否适用（cmd 用 & 拆分，powershell 语义不同） */
  supportsSemicolonSplit(): boolean
}
