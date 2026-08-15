# 跨平台兼容 P0-P2 实施计划（第一批）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 12 阶段跨平台兼容设计的第一批基石：P0 连接层私钥路径/内容修复、P1 DialectSpec 方言抽象 + POSIX 方言（字节一致迁移）、P2 远端 shell 探测器 + 缓存。

**Architecture:** 新建 `src/remote-dialect/`（types/posix/detect/cache/index），把 3 处 wrapper 构造 + 6 处 kill + PID 捕获正则收拢到方言层。P0 新建 `src/private-key.ts` 在 `toConnectConfig` 唯一出口处把"路径 vs 内容"统一解析。P2 用三态探针 `echo __A__%OS%__B__$env:OS__C__` 不经过 wrapper 直接探测默认 shell，结果按 `user@host:port` 缓存，失败回退 posix。P1 严格保持现网输出字节一致，P0/P2 不改变 POSIX 行为。

**Tech Stack:** TypeScript (ESM, node:test), ssh2, node:fs/os/path。

**前置上下文（执行者必读）：**

- 设计文档：[2026-08-15-cross-platform-compat-design.md](../specs/2026-08-15-cross-platform-compat-design.md)（P0/P1/P2 三节为准）
- 现有 8 处重复字符串分布（改动目标）：
  - wrapper 构造：`src/remote-shell.ts:157`、`src/exec-task-manager.ts:303`、`src/daemon.ts:100`（后台变体 `src/daemon.ts:285`）
  - kill 构造：`src/remote-shell.ts:104`、`src/exec-task-manager.ts:265` 与 `:475`（signal 变体）、`src/daemon.ts:122/:268/:383`（后两处为进程组变体）
  - PID 正则：`src/remote-shell.ts:187`、`src/exec-task-manager.ts:323`（含 NOHUP 变体）、`src/daemon.ts:136/:335/:353`
- P0 根因已确认：profile `lobster-188` 的 `privateKey` 值为路径 `/Users/wanghaizhi/.ssh/id_e...`（33 字符、无换行），被当 PEM 内容直传给 ssh2 → `Unsupported key format`。修复点在 `src/connection.ts:310-311`（唯一 ssh2 出口）。
- **验证环境**：Node v22（`/Users/wanghaizhi/.nvm/versions/node/v22.22.3/bin/node`）；构建 `npm run build:test`；跑含调度器的全量回归需 `SSH_TOOL_DATA_DIR=/tmp/ssh-tool-sync-data` 避开 sandbox 写入限制。
- **约定**：TDD（先写失败测试 → 验证失败 → 最小实现 → 验证通过 → 提交）；每 Task 一个 commit；`noUnusedLocals=false`，无用 import 不阻断构建但顺手清理。

---

## Task 1: Phase 0 — 私钥路径 vs 内容自动区分

**Files:**
- Create: `src/private-key.ts`
- Create: `src/__tests__/profile-key-format.test.ts`
- Modify: `src/connection.ts:310-311`（`toConnectConfig` 中 `config.privateKey` 赋值）
- Test: `dist/__tests__/profile-key-format.test.js`

- [ ] **Step 1: 写失败测试**

```typescript
// src/__tests__/profile-key-format.test.ts
import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { resolvePrivateKeyContent } from "../private-key.js"

const PEM_ED25519 = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAA",
  "-----END OPENSSH PRIVATE KEY-----",
  "",
].join("\n")

const PEM_PUBLIC = "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE\n-----END PUBLIC KEY-----\n"
const PUBKEY_ONELINER = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGV4YW1wbGU= user@host"

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ssh-tool-key-"))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe("resolvePrivateKeyContent", () => {
  it("reads key content from an absolute file path", () => {
    const keyPath = join(tmp, "id_ed25519")
    writeFileSync(keyPath, PEM_ED25519, "utf-8")
    assert.equal(resolvePrivateKeyContent(keyPath), PEM_ED25519)
  })

  it("resolves relative key paths against cwd", () => {
    const keyPath = join(tmp, "id_ed25519")
    writeFileSync(keyPath, PEM_ED25519, "utf-8")
    const prevCwd = process.cwd()
    try {
      process.chdir(tmp)
      assert.equal(resolvePrivateKeyContent("id_ed25519"), PEM_ED25519)
    } finally {
      process.chdir(prevCwd)
    }
  })

  it("passes inline PEM content through unchanged", () => {
    assert.equal(resolvePrivateKeyContent(PEM_ED25519), PEM_ED25519)
  })

  it("accepts RSA and EC PEM headers", () => {
    const rsa = "-----BEGIN RSA PRIVATE KEY-----\nTU9DSw==\n-----END RSA PRIVATE KEY-----\n"
    assert.equal(resolvePrivateKeyContent(rsa), rsa)
  })

  it("normalizes CRLF line endings to LF with a single trailing newline", () => {
    const crlf =
      "-----BEGIN OPENSSH PRIVATE KEY-----\r\nc29tZS1jcnRsZg==\r\n-----END OPENSSH PRIVATE KEY-----\r\n\r\n"
    const expected =
      "-----BEGIN OPENSSH PRIVATE KEY-----\nc29tZS1jcnRsZg==\n-----END OPENSSH PRIVATE KEY-----\n"
    assert.equal(resolvePrivateKeyContent(crlf), expected)
  })

  it("throws a clear error when the value is a public key", () => {
    assert.throws(() => resolvePrivateKeyContent(PUBKEY_ONELINER), /public key/i)
    assert.throws(() => resolvePrivateKeyContent(PEM_PUBLIC), /public key/i)
  })

  it("throws a clear error when a path-like value does not exist", () => {
    assert.throws(() => resolvePrivateKeyContent(join(tmp, "missing-key")), /does not exist/i)
  })

  it("rejects empty values", () => {
    assert.throws(() => resolvePrivateKeyContent("   "), /Empty private key/)
  })
})
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npm run build:test && node --test --test-force-exit dist/__tests__/profile-key-format.test.js`

Expected: 模块加载失败（`Cannot find module '.../dist/private-key.js'`）或全部 FAIL。这是 TDD 的红灯。

- [ ] **Step 3: 最小实现**

```typescript
// src/private-key.ts
/**
 * Private-key resolution for SSH credentials.
 *
 * Profiles historically stored a filesystem PATH in `auth.privateKey`; feeding
 * that path to ssh2 as PEM content produced "Unsupported key format". This
 * module distinguishes path vs inline content, reads the file when a path is
 * detected, and normalizes line endings so serialized profiles can't corrupt
 * the key.
 */

import { existsSync, readFileSync, statSync } from "fs"
import { homedir } from "os"
import { isAbsolute, join, resolve } from "path"

const PRIVATE_KEY_HEADER = /-----BEGIN (OPENSSH|RSA|EC|DSA|SSH2 ENCRYPTED) PRIVATE KEY-----/
const PUBLIC_KEY_HEADER = /-----BEGIN (\w+ )?PUBLIC KEY-----/
const PUBLIC_KEY_ONELINER = /^(ssh|ecdsa|sk-)\S+\s+AAAA[A-Za-z0-9+/]+/

/** CRLF→LF 归一，并确保恰好一个结尾换行。 */
function normalizeKeyContent(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\n+$/, "\n")
}

export function resolvePrivateKeyContent(input: string): string {
  const value = input.trim()
  if (!value) {
    throw new Error("Empty private key value")
  }

  if (value.startsWith("-----BEGIN")) {
    if (PUBLIC_KEY_HEADER.test(value)) {
      throw new Error(
        "privateKey looks like a PUBLIC key (-----BEGIN PUBLIC KEY-----), not a private key. Generate a private key with `ssh-keygen -t ed25519`.",
      )
    }
    if (!PRIVATE_KEY_HEADER.test(value)) {
      throw new Error(
        `Unrecognized private key header. Convert the key first, e.g. \`ssh-keygen -p -f <file>\` (value starts: ${value.slice(0, 40)}…).`,
      )
    }
    return normalizeKeyContent(value)
  }

  if (PUBLIC_KEY_ONELINER.test(value)) {
    throw new Error(
      "privateKey looks like a PUBLIC key (ssh-ed25519 AAAA…), not a private key. Generate a private key with `ssh-keygen -t ed25519`.",
    )
  }

  // 多行内容但无 PEM 头：视为已损坏内容，归一后交给 ssh2 报错。
  if (value.includes("\n")) {
    return normalizeKeyContent(value)
  }

  // 否则按文件路径处理：~ 展开、相对 cwd 解析；命中文件则递归校验内容头。
  const expanded = value.startsWith("~") ? join(homedir(), value.slice(1)) : value
  const abs = isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded)
  if (existsSync(abs) && statSync(abs).isFile()) {
    return resolvePrivateKeyContent(readFileSync(abs, "utf8"))
  }

  throw new Error(
    `privateKey looks like a file path but no such file exists: ${input}. Use an absolute path to the key file, or paste the key content directly.`,
  )
}
```

- [ ] **Step 4: 接线到连接层**

`src/connection.ts`：

```typescript
import { resolvePrivateKeyContent } from "./private-key.js"
```

```typescript
    if (host.auth.privateKey) {
      config.privateKey = resolvePrivateKeyContent(host.auth.privateKey)
    }
```

说明：`connectDirect`/`connectThrough` 的 Promise executor 内同步 throw 会被自动转为 reject，`connect()` 的 try/catch 会 emit error 事件并 cleanup（`src/connection.ts:83-92`），无需额外处理。注意：`resolvePrivateKeyContent` 抛错时错误信息直接进 `err.message`，即用户看到的连接错误。

- [ ] **Step 5: 运行测试验证通过**

Run:
```bash
npm run build:test && node --test --test-force-exit dist/__tests__/profile-key-format.test.js
```
Expected: 8/8 PASS。

- [ ] **Step 6: 回归 + 提交**

Run:
```bash
SSH_TOOL_DATA_DIR=/tmp/ssh-tool-sync-data npm run test:fast
```
Expected: 全绿（connection.test.ts 等不受影响）。

```bash
git add src/private-key.ts src/connection.ts src/__tests__/profile-key-format.test.ts
git commit -m "fix: resolve privateKey path vs content before passing to ssh2"
```

---

## Task 2: Phase 1 — DialectSpec 抽象 + POSIX 方言（字节一致迁移）

**Files:**
- Create: `src/remote-dialect/types.ts`
- Create: `src/remote-dialect/posix.ts`
- Create: `src/remote-dialect/index.ts`
- Create: `src/__tests__/remote-dialect-posix.test.ts`
- Modify: `src/remote-shell.ts`（L104 kill、L157 wrapper、L187 PID 正则）
- Modify: `src/exec-task-manager.ts`（删除 L240-249 cwd/env 手动拼接、L264/L475 kill、L303 wrapper、L323 PID 正则）
- Modify: `src/daemon.ts`（L100 wrapper、L122/L268/L383 kill、L136/L335/L353 PID 正则、L285 background wrapper）

**字节一致红线**：posix 方言产出的字符串与改造前逐字节相同，除 kill 侧按设计统一 `sleep 0.1→1`、`kill -9→kill -KILL`（语义等价，现有测试无断言 `kill -9`/`sleep 0.1`）。

- [ ] **Step 1: 写失败测试**

```typescript
// src/__tests__/remote-dialect-posix.test.ts
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { posixDialect } from "../remote-dialect/posix.js"

describe("posixDialect", () => {
  it("buildExec wraps a plain command byte-identically", () => {
    assert.equal(
      posixDialect.buildExec("echo ok"),
      `echo "SSH_TOOL_PID:$$" >&2; exec sh -c 'echo ok'`,
    )
  })

  it("buildExec composes env then cwd inside the sh -c string", () => {
    assert.equal(
      posixDialect.buildExec("echo ok", { cwd: "/tmp/a b", env: { K: "v x" } }),
      String.raw`echo "SSH_TOOL_PID:$$" >&2; exec sh -c 'export K='\''v x'\''; cd '\''/tmp/a b'\'' && echo ok'`,
    )
  })

  it("buildExec rejects invalid env names", () => {
    assert.throws(
      () => posixDialect.buildExec("x", { env: { "bad name": "v" } }),
      /Invalid environment variable name/,
    )
  })

  it("buildBackground reproduces the setsid form", () => {
    assert.equal(
      posixDialect.buildBackground("sleep 10"),
      `setsid sh -c 'echo "SSH_TOOL_PID:$$" >&2; exec sh -c "$1"' ssh-tool 'sleep 10'`,
    )
  })

  it("buildKill emits TERM then KILL with an integer sleep", () => {
    assert.equal(
      posixDialect.buildKill(4321),
      `kill -TERM 4321 2>/dev/null; sleep 1; kill -KILL 4321 2>/dev/null; true`,
    )
  })

  it("buildKill supports process-group and custom-signal variants", () => {
    assert.equal(
      posixDialect.buildKill(4321, { group: true, signal: "HUP" }),
      `kill -HUP -4321 2>/dev/null || kill -HUP 4321 2>/dev/null; sleep 1; kill -KILL -4321 2>/dev/null || kill -KILL 4321 2>/dev/null; true`,
    )
  })

  it("pidMarkerPattern captures the marker", () => {
    const m = "SSH_TOOL_PID:99\n".match(posixDialect.pidMarkerPattern())
    assert.equal(m?.[1], "99")
  })

  it("buildCwdResolve / isValidAbsPath / supportsSemicolonSplit are POSIX-shaped", () => {
    assert.equal(posixDialect.buildCwdResolve(), "pwd -P")
    assert.equal(posixDialect.buildCwdResolve("/base"), "cd '/base' && pwd -P")
    assert.equal(posixDialect.isValidAbsPath("/a"), true)
    assert.equal(posixDialect.isValidAbsPath("C:\\a"), false)
    assert.equal(posixDialect.supportsSemicolonSplit(), true)
  })
})
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npm run build:test && node --test --test-force-exit dist/__tests__/remote-dialect-posix.test.js`

Expected: 模块不存在 / 全 FAIL（红灯）。

- [ ] **Step 3: 实现方言层**

```typescript
// src/remote-dialect/types.ts
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
```

```typescript
// src/remote-dialect/posix.ts
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
    return `setsid sh -c 'echo "SSH_TOOL_PID:$$" >&2; exec sh -c "$1"' ssh-tool ${shellQuote(full)}`
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
```

```typescript
// src/remote-dialect/index.ts
import { posixDialect } from "./posix.js"
import type { DialectSpec } from "./types.js"

export type { DialectKind, DialectSpec } from "./types.js"
export { posixDialect } from "./posix.js"

/** Phase 1：恒返回 posix。Phase 2 起按 sessionKey/hint 查缓存。 */
export function getDialect(_sessionKey?: string): DialectSpec {
  return posixDialect
}
```

- [ ] **Step 4: 接线 remote-shell.ts**

`src/remote-shell.ts` 增加 import：

```typescript
import { getDialect } from "./remote-dialect/index.js"
```

L103-105 改为：

```typescript
function killRemoteProcess(client: Client, pid: number): void {
  const killCmd = getDialect().buildKill(pid)
  client.exec(killCmd, () => {})
}
```

L157 改为：

```typescript
const wrappedCommand = getDialect().buildExec(command)
```

L187 改为：

```typescript
const pidMatch = text.match(getDialect().pidMarkerPattern())
```

- [ ] **Step 5: 接线 exec-task-manager.ts**

`src/exec-task-manager.ts`：
- L16 import 改为 `import { getDialect } from "./remote-dialect/index.js"`（移除不再使用的 `assertEnvName, shellQuote`）
- 删除 L240-249 的 `fullCommand` 拼接块
- L303 改为：

```typescript
const wrappedCommand = getDialect().buildExec(command, {
  cwd: options?.cwd,
  env: options?.env,
})
```

- L264 改为：

```typescript
const killCmd = getDialect().buildKill(pid)
```

- L323 改为：

```typescript
let pidMatch = text.match(getDialect().pidMarkerPattern())
```

- L475 改为：

```typescript
const killCmd = getDialect().buildKill(pid, { signal })
```

> 注意：`env` 前缀与 `cwd` 的组合顺序必须保持"env 在前、cd 在后"（`export K=V; cd '/cwd' && cmd`），与改造前逐字节一致；该顺序已由 `buildExec` 内部逻辑保证并有单测覆盖。

- [ ] **Step 6: 接线 daemon.ts**

`src/daemon.ts` 增加 import：

```typescript
import { getDialect } from "./remote-dialect/index.js"
```

- L100 改为：

```typescript
const wrappedCommand = getDialect().buildExec(command)
```

- L122 改为：

```typescript
const killCmd = getDialect().buildKill(pid)
```

- L136 / L335 / L353 改为：

```typescript
const pidMatch = text.match(getDialect().pidMarkerPattern())
```

（L335/L353 保留各自的 stdout/stderr 输出逻辑与 `task.pid = currentPid` 赋值，仅替换正则来源。）

- L268 改为：

```typescript
const killCmd = getDialect().buildKill(task.pid, { group: true })
```

- L285 改为：

```typescript
const wrappedCommand = getDialect().buildBackground(fullCommand)
```

（`fullCommand` 在 L281-284 已含 cd 前缀，字节不变。）

- [ ] **Step 7: 验证方言测试通过**

Run: `npm run build:test && node --test --test-force-exit dist/__tests__/remote-dialect-posix.test.js`

Expected: 8/8 PASS（绿灯）。

- [ ] **Step 8: 全量回归（关键：现有 wrapper 断言测试不改应通过）**

Run:
```bash
SSH_TOOL_DATA_DIR=/tmp/ssh-tool-sync-data npm run test:fast
SSH_TOOL_DATA_DIR=/tmp/ssh-tool-sync-data npm run test:transfer
node --test --test-force-exit dist/__tests__/remote-shell.test.js dist/__tests__/daemon-streaming-runner.test.js dist/__tests__/mcp-server.test.js dist/__tests__/integration.test.js dist/__tests__/multi-hop-auth.test.js dist/__tests__/file-transfer.test.js
```
Expected: 全绿。若 `mcp-server.test.ts`（L50 前缀剥离正则）、`integration.test.ts`（L290-293 解包正则）、`file-transfer.test.ts`（L35 前缀）、`multi-hop-auth.test.ts`（L67-68 解包正则）有失败，说明字节漂移——回到 posix.ts 对照现状核对。

- [ ] **Step 9: 提交**

```bash
git add src/remote-dialect src/remote-shell.ts src/exec-task-manager.ts src/daemon.ts src/__tests__/remote-dialect-posix.test.ts
git commit -m "refactor: extract posix dialect spec and wire exec/kill builders"
```

---

## Task 3: Phase 2 — 远端 shell 探测器 + 缓存

**Files:**
- Create: `src/remote-dialect/detect.ts`
- Create: `src/remote-dialect/cache.ts`
- Create: `src/__tests__/remote-dialect-detect.test.ts`
- Modify: `src/remote-dialect/index.ts`（`getDialect` 查缓存/hint、新增 `detectAndCache`）
- Modify: `src/types.ts`（`SSHProfile` 增加 `remoteShellHint?`）

- [ ] **Step 1: 写失败测试**

```typescript
// src/__tests__/remote-dialect-detect.test.ts
import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "events"
import { classifyProbeOutput, probeAndDetect } from "../remote-dialect/detect.js"
import { detectAndCache, getDialect } from "../remote-dialect/index.js"
import { clearDialectCache, getCachedDialect } from "../remote-dialect/cache.js"

type Scripted = { out?: string; err?: string; code?: number }

function createProbeClient(scripted: Scripted[]): any {
  const client = new EventEmitter() as any
  client.exec = (_cmd: string, cb: Function) => {
    const response = scripted.shift() ?? { code: 0 }
    const stream = new EventEmitter() as any
    stream.stderr = new EventEmitter()
    process.nextTick(() => {
      if (response.out) stream.emit("data", Buffer.from(response.out))
      if (response.err) stream.stderr.emit("data", Buffer.from(response.err))
      stream.emit("close", response.code ?? 0)
    })
    cb(null, stream)
  }
  return client
}

function createTimeoutClient(): any {
  const client = new EventEmitter() as any
  client.exec = (_cmd: string, cb: Function) => {
    // 永不回调 → 触发 rawExec 超时
    const stream = new EventEmitter() as any
    stream.stderr = new EventEmitter()
    cb(null, stream)
  }
  return client
}

beforeEach(() => clearDialectCache())

describe("classifyProbeOutput", () => {
  it("detects cmd when %OS% expanded but $env:OS left literal", () => {
    assert.equal(classifyProbeOutput("__A__Windows_NT__B__$env:OS__C__\r\n"), "cmd")
  })
  it("detects powershell when $env:OS expanded but %OS% left literal", () => {
    assert.equal(classifyProbeOutput("__A__%OS%__B__Windows_NT__C__\r\n"), "powershell")
  })
  it("detects posix when nothing expands", () => {
    assert.equal(classifyProbeOutput("__A__%OS%__B__:OS__C__\n"), "posix")
  })
  it("falls back to posix on malformed output", () => {
    assert.equal(classifyProbeOutput("__A__xxx"), "posix")
    assert.equal(classifyProbeOutput(""), "posix")
  })
})

describe("probeAndDetect", () => {
  it("resolves cmd default shell with powershell available (sub=powershell)", async () => {
    const client = createProbeClient([
      { out: "__A__Windows_NT__B__$env:OS__C__" },
      { code: 0 }, // powershell -NoProfile -Command "exit 0"
    ])
    const d = await probeAndDetect(client)
    assert.equal(d.kind, "cmd")
    assert.equal(d.sub, "powershell")
  })

  it("resolves cmd default shell without powershell (sub=cmd)", async () => {
    const client = createProbeClient([
      { out: "__A__Windows_NT__B__$env:OS__C__" },
      { code: 1 },
    ])
    const d = await probeAndDetect(client)
    assert.equal(d.kind, "cmd")
    assert.equal(d.sub, "cmd")
  })

  it("resolves powershell default shell", async () => {
    const client = createProbeClient([
      { out: "__A__%OS%__B__Windows_NT__C__" },
      { code: 0 },
    ])
    const d = await probeAndDetect(client)
    assert.equal(d.kind, "powershell")
    assert.equal(d.sub, "powershell")
  })

  it("resolves posix darwin", async () => {
    const client = createProbeClient([
      { out: "__A__%OS%__B__:OS__C__" },
      { out: "Darwin\n" }, // uname -s
    ])
    const d = await probeAndDetect(client)
    assert.equal(d.kind, "posix")
    assert.equal(d.sub, "darwin")
  })

  it("resolves posix linux with busybox detection", async () => {
    const client = createProbeClient([
      { out: "__A__%OS%__B__:OS__C__" },
      { out: "Linux\n" },
      { out: "BusyBox v1.36.1 (2023-06-26)\n" },
    ])
    const d = await probeAndDetect(client)
    assert.equal(d.kind, "posix")
    assert.equal(d.sub, "busybox")
  })

  it("resolves posix linux gnu", async () => {
    const client = createProbeClient([
      { out: "__A__%OS%__B__:OS__C__" },
      { out: "Linux\n" },
      { out: "" },
    ])
    const d = await probeAndDetect(client)
    assert.equal(d.kind, "posix")
    assert.equal(d.sub, "gnu")
  })

  it("falls back to posix when the probe never responds (timeout)", async () => {
    const d = await probeAndDetect(createTimeoutClient(), 20)
    assert.equal(d.kind, "posix")
  })

  it("falls back to posix when exec throws synchronously", async () => {
    const client = new EventEmitter() as any
    client.exec = () => { throw new Error("dead client") }
    const d = await probeAndDetect(client, 20)
    assert.equal(d.kind, "posix")
  })
})

describe("detectAndCache + getDialect", () => {
  it("caches per host and returns the detected kind", async () => {
    const client = createProbeClient([
      { out: "__A__%OS%__B__Windows_NT__C__" },
      { code: 0 },
    ])
    const d = await detectAndCache(client, "win188", 22, "user")
    assert.equal(d.kind, "powershell")
    assert.equal(getCachedDialect("user@win188:22")?.kind, "powershell")
  })

  it("reuses a fresh cache entry without probing again", async () => {
    let execCalls = 0
    const client = new EventEmitter() as any
    client.exec = (_cmd: string, cb: Function) => {
      execCalls++
      const stream = new EventEmitter() as any
      stream.stderr = new EventEmitter()
      process.nextTick(() => stream.emit("close", 0))
      cb(null, stream)
    }
    await detectAndCache(client, "h1", 22, "u")
    await detectAndCache(client, "h1", 22, "u")
    assert.equal(execCalls, 1)
  })

  it("getDialect honours the remoteShellHint (windows dialects land in P3/P4)", () => {
    assert.equal(getDialect(undefined, "posix").kind, "posix")
    assert.equal(getDialect(undefined, "powershell").kind, "posix")
  })
})
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npm run build:test && node --test --test-force-exit dist/__tests__/remote-dialect-detect.test.js`

Expected: 模块不存在 / 全 FAIL（红灯）。

- [ ] **Step 3: 实现探测器**

```typescript
// src/remote-dialect/detect.ts
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
```

```typescript
// src/remote-dialect/cache.ts
import type { DetectedDialect } from "./detect.js"

const CACHE_TTL_MS = 10 * 60 * 1000
const cache = new Map<string, DetectedDialect>()

export function hostIdOf(host: string, port: number, username: string): string {
  return `${username}@${host}:${port}`
}

export function getCachedDialect(id: string): DetectedDialect | undefined {
  const entry = cache.get(id)
  if (!entry) return undefined
  if (Date.now() - entry.detectedAt > CACHE_TTL_MS) {
    cache.delete(id)
    return undefined
  }
  return entry
}

export function putCachedDialect(id: string, detected: DetectedDialect): void {
  cache.set(id, detected)
}

export function clearDialectCache(): void {
  cache.clear()
}
```

- [ ] **Step 4: 接入 index.ts + types.ts**

`src/types.ts`（在 `SSHProfile` 接口内、`lastUsed` 之后追加）：

```typescript
  /** 声明式远端 shell 提示，设置后跳过自动探测（受限环境旁路）。 */
  remoteShellHint?: "posix" | "powershell" | "cmd"
```

`src/remote-dialect/index.ts` 整文件替换为：

```typescript
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
```

- [ ] **Step 5: 验证探测测试通过**

Run: `npm run build:test && node --test --test-force-exit dist/__tests__/remote-dialect-detect.test.js`

Expected: 14/14 PASS（绿灯）。

- [ ] **Step 6: 回归 + 提交**

Run:
```bash
SSH_TOOL_DATA_DIR=/tmp/ssh-tool-sync-data npm run test:fast
SSH_TOOL_DATA_DIR=/tmp/ssh-tool-sync-data npm run test:transfer
```
Expected: 全绿（探测未接线到执行链，不影响现有行为）。

```bash
git add src/remote-dialect src/types.ts src/__tests__/remote-dialect-detect.test.ts
git commit -m "feat: add remote shell dialect detection with per-host cache"
```

---

## 阶段验收（P0-P2 完成定义）

1. `npm run build:test` 零错误。
2. 新增 3 个测试文件全 PASS：`profile-key-format`、`remote-dialect-posix`、`remote-dialect-detect`。
3. `npm run test:fast` + `npm run test:transfer` 全绿，现有 wrapper 断言测试未改动即通过（字节一致验证）。
4. `git log --oneline -3` 出现 3 个 commit（fix/refactor/feat 各一）。
5. P0 真机验收（可选，需 188 可达）：`node dist/cli/ssh-exec.js --profile-name lobster-188 --command "echo ok"` 返回 `ok` 或明确的密钥格式指引，不再出现 `Unsupported key format`。

## 后续阶段（不在本计划内）

P3 PowerShell 方言 → P4 cmd 方言 → P5 执行链全面接线（含 `resolveRemoteCwd`、`supportsSemicolonSplit` 生效、`getDialect(sessionKey)` 真实切换）→ P6-P8 工具层 → P9 CI 矩阵 → P10 真机手测 → P11/P12 收口。
