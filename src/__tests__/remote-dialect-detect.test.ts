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
    client.exec = () => {
      throw new Error("dead client")
    }
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
    const callsAfterFirst = execCalls
    assert.ok(callsAfterFirst >= 1)
    await detectAndCache(client, "h1", 22, "u")
    assert.equal(execCalls, callsAfterFirst)
  })

  it("getDialect honours the remoteShellHint (windows dialects land in P3/P4)", () => {
    assert.equal(getDialect(undefined, "posix").kind, "posix")
    assert.equal(getDialect(undefined, "powershell").kind, "powershell")
  })
})
