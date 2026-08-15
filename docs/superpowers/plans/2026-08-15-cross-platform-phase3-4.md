# 跨平台兼容 P3-P4 实施计划（第二批）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 P3 PowerShell 方言与 P4 cmd 方言，实现 `DialectSpec` 全接口并接入 `dialectForKind`，为 P5 执行链接线提供可用的 Windows 方言实现。

**Architecture:** 新建 `src/remote-dialect/powershell.ts`（`-EncodedCommand` 编码消灭引号/反斜杠/管道的多层 shell 解析）与 `src/remote-dialect/cmd.ts`（无 PowerShell 兜底，能力受限明示）。`index.ts` 的 `dialectForKind` 按探测结果返回对应方言。两方言均为纯字符串构造 + 精确断言单测，不改变现有执行行为（当前无调用方传 sessionKey，`getDialect()` 无参仍返回 posix）。

**Tech Stack:** TypeScript (ESM, node:test), Node Buffer (utf16le→base64)。

**前置上下文（执行者必读）：**

- 设计文档 P3/P4 节：[2026-08-15-cross-platform-compat-design.md](../specs/2026-08-15-cross-platform-compat-design.md#phase-3--powershell-方言p0windows-主路径)
- P1 已建 `src/remote-dialect/{types,posix,index}.ts`；`DialectSpec` 接口见 `types.ts`（`buildKill` 已含 `opts?: { group?, signal? }`）
- **字节红线**：本批不改动 posix 方言与现有 exec 站点；`getDialect()` 无 sessionKey 时恒返回 posix
- **验证环境**：Node v22；构建 `npm run build:test`；全量回归 `SSH_TOOL_DATA_DIR=/tmp/ssh-tool-sync-data npm run test:fast` + `test:transfer`（mcp-server/integration 有 6 个存量失败，与本次无关）
- **约定**：TDD（先红后绿）；每 Task 一个 commit；PS 单引号内唯一特殊字符是 `'`（转义为 `''`）；`-EncodedCommand` = UTF-16LE→Base64（Node `Buffer.from(script, "utf16le").toString("base64")`，无 BOM，PS 5.1+ 接受）

---

## Task 1: P3 — PowerShell 方言

**Files:**
- Create: `src/remote-dialect/powershell.ts`
- Create: `src/__tests__/remote-dialect-powershell.test.ts`
- Modify: `src/remote-dialect/index.ts`（`dialectForKind` 接入 powershell）

- [ ] **Step 1: 写失败测试**

```typescript
// src/__tests__/remote-dialect-powershell.test.ts
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { powershellDialect } from "../remote-dialect/powershell.js"

/** 解码 -EncodedCommand 外层，还原 PS 脚本原文。 */
function decodePS(cmd: string): string {
  const m = cmd.match(
    /^powershell -NoLogo -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand (\S+)$/,
  )
  assert.ok(m, `expected powershell -EncodedCommand wrapper, got: ${cmd}`)
  return Buffer.from(m![1], "base64").toString("utf16le")
}

describe("powershellDialect", () => {
  it("buildExec wraps via -EncodedCommand and decodes to the exact PS source", () => {
    const script = decodePS(powershellDialect.buildExec("echo ok"))
    assert.ok(script.includes('[Console]::Error.WriteLine("SSH_TOOL_PID:$PID")'))
    assert.ok(script.includes("Invoke-Expression -Command 'echo ok'"))
  })

  it("preserves quotes, backslashes, pipes and $ inside the user command", () => {
    const cmd = `Get-ChildItem 'C:\\Program Files' | Where-Object { $_.Name -like "*.log" }`
    const script = decodePS(powershellDialect.buildExec(cmd))
    assert.ok(script.includes(`Invoke-Expression -Command '${cmd}'`))
  })

  it("injects cwd and env before the user command", () => {
    const script = decodePS(
      powershellDialect.buildExec("echo ok", { cwd: "C:\\tmp a", env: { K: "v x" } }),
    )
    assert.ok(script.includes(`Set-Location -LiteralPath 'C:\\tmp a'`))
    assert.ok(script.includes(`$env:K = 'v x'`))
    assert.ok(script.indexOf("Invoke-Expression") > script.indexOf("Set-Location"))
  })

  it("escapes single quotes in values and commands by doubling them", () => {
    const script = decodePS(powershellDialect.buildExec("echo it's", { env: { K: "a'b" } }))
    assert.ok(script.includes(`$env:K = 'a''b'`))
    assert.ok(script.includes(`Invoke-Expression -Command 'echo it''s'`))
  })

  it("buildKill stops a single process and taskkills a tree", () => {
    assert.equal(
      powershellDialect.buildKill(4321),
      'powershell -NoProfile -Command "Stop-Process -Id 4321 -Force -ErrorAction SilentlyContinue"',
    )
    assert.equal(powershellDialect.buildKill(4321, { group: true }), "taskkill /PID 4321 /T /F")
  })

  it("buildBackground starts a hidden detached process via Start-Process -PassThru", () => {
    const script = decodePS(powershellDialect.buildBackground("sleep 10"))
    assert.ok(script.includes("Start-Process"))
    assert.ok(script.includes("-WindowStyle Hidden"))
    assert.ok(script.includes("-PassThru"))
    assert.ok(script.includes("SSH_TOOL_PID"))
  })

  it("pidMarkerPattern captures the $PID marker", () => {
    const m = "SSH_TOOL_PID:1234\n".match(powershellDialect.pidMarkerPattern())
    assert.equal(m?.[1], "1234")
  })

  it("buildCwdResolve / isValidAbsPath / supportsSemicolonSplit are Windows-shaped", () => {
    assert.equal(powershellDialect.isValidAbsPath("C:\\Users\\x"), true)
    assert.equal(powershellDialect.isValidAbsPath("C:/Users/x"), true)
    assert.equal(powershellDialect.isValidAbsPath("/tmp"), false)
    assert.equal(powershellDialect.supportsSemicolonSplit(), false)
    assert.ok(powershellDialect.buildCwdResolve("C:\\x").includes("Set-Location"))
  })
})
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npm run build:test && node --test --test-force-exit dist/__tests__/remote-dialect-powershell.test.js`

Expected: 模块不存在（`Cannot find module '.../remote-dialect/powershell.js'`）→ 红灯。

- [ ] **Step 3: 最小实现**

```typescript
// src/remote-dialect/powershell.ts
import { assertEnvName } from "../shell-quote.js"
import type { DialectSpec } from "./types.js"

/** PS 单引号字符串：唯一特殊字符是 '，转义为 ''。 */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** UTF-16LE→Base64，供 -EncodedCommand 使用（PS 5.1+，无 BOM 可接受）。 */
function encodePS(script: string): string {
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
    return baseCwd ? `Set-Location -LiteralPath ${psQuote(baseCwd)}; (Get-Location).Path` : "(Get-Location).Path"
  },

  isValidAbsPath(path) {
    return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\")
  },

  supportsSemicolonSplit() {
    // 命令整体交给 Invoke-Expression，分号由 PS 解析器处理，不做顶层拆分。
    return false
  },
}
```

- [ ] **Step 4: 接入 index.ts**

`src/remote-dialect/index.ts`：

```typescript
import { posixDialect } from "./posix.js"
import { powershellDialect } from "./powershell.js"
import { cmdDialect } from "./cmd.js" // Task 2 后才有；本步骤先只加 powershell
...
export { posixDialect, powershellDialect } from "./posix.js"  // 调整导出行
```

将 `dialectForKind` 改为：

```typescript
function dialectForKind(kind: DialectKind): DialectSpec {
  if (kind === "powershell") return powershellDialect
  return posixDialect
}
```

> 注：`cmd` 分支在 Task 2 加入，本步骤保持 posix 兜底。若本步直接写完整 switch 会因 `cmd.js` 不存在而编译失败——先只加 powershell 分支。

- [ ] **Step 5: 运行测试验证通过**

Run: `npm run build:test && node --test --test-force-exit dist/__tests__/remote-dialect-powershell.test.js`

Expected: 8/8 PASS（绿灯）。

- [ ] **Step 6: 回归 + 提交**

Run: `SSH_TOOL_DATA_DIR=/tmp/ssh-tool-sync-data npm run test:fast`（期望 582 pass，无行为变化）

```bash
git add src/remote-dialect/powershell.ts src/remote-dialect/index.ts src/__tests__/remote-dialect-powershell.test.ts
git commit -m "feat: add powershell dialect with -EncodedCommand wrapping"
```

---

## Task 2: P4 — cmd 方言

**Files:**
- Create: `src/remote-dialect/cmd.ts`
- Create: `src/__tests__/remote-dialect-cmd.test.ts`
- Modify: `src/remote-dialect/index.ts`（`dialectForKind` 完整 switch）

- [ ] **Step 1: 写失败测试**

```typescript
// src/__tests__/remote-dialect-cmd.test.ts
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { cmdDialect } from "../remote-dialect/cmd.js"

describe("cmdDialect", () => {
  it("buildExec wraps with cmd /d /s /c and a non-numeric pid marker", () => {
    const wrapped = cmdDialect.buildExec("echo ok")
    assert.match(wrapped, /^cmd \/d \/s \/c "/)
    assert.ok(wrapped.includes("echo SSH_TOOL_PID:unavailable 1>&2 & echo ok"))
  })

  it("prepends set env and cd /d before the command", () => {
    const wrapped = cmdDialect.buildExec("dir", { cwd: "C:\\tmp", env: { K: "v" } })
    assert.ok(wrapped.includes('set "K=v"'))
    assert.ok(wrapped.includes('cd /d "C:\\tmp"'))
  })

  it("buildKill uses taskkill /T /F for single and group", () => {
    assert.equal(cmdDialect.buildKill(4321), "taskkill /PID 4321 /T /F")
    assert.equal(cmdDialect.buildKill(4321, { group: true }), "taskkill /PID 4321 /T /F")
  })

  it("pidMarkerPattern does NOT match the unavailable marker (no pid capture)", () => {
    assert.equal("SSH_TOOL_PID:unavailable\n".match(cmdDialect.pidMarkerPattern()), null)
  })

  it("buildBackground uses start /b", () => {
    assert.ok(cmdDialect.buildBackground("ping -t 1.1.1.1").includes("start /b"))
  })

  it("isValidAbsPath / supportsSemicolonSplit / buildCwdResolve are cmd-shaped", () => {
    assert.equal(cmdDialect.isValidAbsPath("C:\\a"), true)
    assert.equal(cmdDialect.isValidAbsPath("C:/a"), true)
    assert.equal(cmdDialect.isValidAbsPath("/a"), false)
    assert.equal(cmdDialect.supportsSemicolonSplit(), false)
    assert.ok(cmdDialect.buildCwdResolve("C:\\x").includes('cd /d "C:\\x"'))
  })
})
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npm run build:test && node --test --test-force-exit dist/__tests__/remote-dialect-cmd.test.js`

Expected: 模块不存在 → 红灯。

- [ ] **Step 3: 最小实现**

```typescript
// src/remote-dialect/cmd.ts
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
```

- [ ] **Step 4: 接入 index.ts（完整 switch）**

`src/remote-dialect/index.ts`：

```typescript
import { cmdDialect } from "./cmd.js"
import { powershellDialect } from "./powershell.js"
...
export { posixDialect, powershellDialect, cmdDialect } from "./posix.js"  // 拆分调整
```

```typescript
function dialectForKind(kind: DialectKind): DialectSpec {
  switch (kind) {
    case "powershell":
      return powershellDialect
    case "cmd":
      return cmdDialect
    default:
      return posixDialect
  }
}
```

导出行调整为：

```typescript
export { posixDialect } from "./posix.js"
export { powershellDialect } from "./powershell.js"
export { cmdDialect } from "./cmd.js"
```

- [ ] **Step 5: 运行测试验证通过**

Run: `npm run build:test && node --test --test-force-exit dist/__tests__/remote-dialect-cmd.test.js dist/__tests__/remote-dialect-powershell.test.js dist/__tests__/remote-dialect-posix.test.js`

Expected: 全部 PASS（cmd 6/6 + powershell 8/8 + posix 8/8）。

- [ ] **Step 6: 回归 + 提交**

Run:
```bash
SSH_TOOL_DATA_DIR=/tmp/ssh-tool-sync-data npm run test:fast
SSH_TOOL_DATA_DIR=/tmp/ssh-tool-sync-data npm run test:transfer
```
Expected: 582 + 68 全绿（方言未接线到 exec，无行为变化）。

```bash
git add src/remote-dialect/cmd.ts src/remote-dialect/index.ts src/__tests__/remote-dialect-cmd.test.ts
git commit -m "feat: add cmd dialect as fallback for Windows without PowerShell"
```

---

## 阶段验收（P3-P4 完成定义）

1. `npm run build:test` 零错误。
2. 三个方言测试文件全 PASS：`remote-dialect-posix`、`remote-dialect-powershell`、`remote-dialect-cmd`。
3. `test:fast` 582 + `test:transfer` 68 全绿，现有行为无变化（getDialect 无参仍 posix）。
4. `git log --oneline -2` 出现 feat: powershell / feat: cmd 两个 commit。
5. `getDialect(undefined, "powershell").kind === "powershell"`、`getDialect(undefined, "cmd").kind === "cmd"`（hint 路径已生效，供 P5 接线后使用）。

## 后续阶段（不在本计划内）

P5 执行链全面接线：gateway 连接成功探测触发（`detectAndCache`）、exec 主入口传 `sessionKey` 使探测结果真实生效、`resolveRemoteCwd` 方言化（`buildCwdResolve` + `isValidAbsPath`）、`splitTopLevelSemicolonCommands` 按 `supportsSemicolonSplit` 控制、ETM `SSH_TOOL_NOHUP_PID` 分支统一、daemon-streaming 补 cwd/kill 断言用例。随后 P6-P8 工具层、P9 CI 矩阵、P10 188 手测。
