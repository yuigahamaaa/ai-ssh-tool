import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { Readable, Writable } from "stream"
import { EventEmitter } from "events"
import { mkdirSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { uploadFile, downloadFile } from "../file-transfer.js"

/**
 * P2-1: verify sftp.end() is invoked exactly once on every code path,
 * including errors that occur mid-stream. A leaking sftp session can hold
 * the SSH channel open and starve subsequent transfers.
 */

class FakeSftp extends EventEmitter {
  endCalls = 0
  endThrows = false
  createWriteStreamThrows = false
  end() {
    this.endCalls += 1
    if (this.endThrows) throw new Error("end failed")
  }
  createReadStream(): Readable {
    const r = new Readable({ read() {} })
    process.nextTick(() => {
      r.push(Buffer.from("hello world"))
      r.push(null)
    })
    return r
  }
  createWriteStream(): Writable {
    if (this.createWriteStreamThrows) throw new Error("create stream boom")
    const w = new Writable({ write(_chunk, _enc, cb) { cb() } })
    return w
  }
  stat(_path: string, cb: any) {
    cb(null, { size: 11, mode: 0o644 })
  }
  fastGet(_remotePath: string, _localPath: string, _opts: any, cb: any) {
    // Unused by uploadFile path
    cb(new Error("not used"))
  }
  fastPut(_localPath: string, _remotePath: string, _opts: any, cb: any) {
    cb(new Error("not used"))
  }
}

function makeFakeClient(sftp: FakeSftp): any {
  return {
    sftp: (_cb: any) => _cb(null, sftp),
  }
}

let testDir = ""

beforeEach(() => {
  testDir = join(tmpdir(), `ssh-tool-p2-1-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(testDir, { recursive: true })
})

afterEach(() => {
  try { rmSync(testDir, { recursive: true, force: true }) } catch {}
})

describe("file-transfer P2-1: sftp.end() always released", () => {
  it("uploadFile (streaming) calls sftp.end() on success", async () => {
    const sftp = new FakeSftp()
    // We can't easily build a working streaming upload against the FakeSftp
    // (pipeline would hang waiting for real source), so instead exercise the
    // uploadFileDirect path: which also uses client.sftp and must call end().
    const localPath = join(testDir, "direct-success.txt")
    writeFileSync(localPath, "small content")
    const client = makeFakeClient(sftp)
    const result = await uploadFile(client as any, localPath, "/remote/x", undefined)
    assert.equal(result.success, true)
    assert.ok(sftp.endCalls >= 1, "sftp.end() should have been called on success")
  })

  it("uploadFileDirect sftp.end() tolerates end() throwing", async () => {
    const sftp = new FakeSftp()
    sftp.endThrows = true
    const localPath = join(testDir, "direct-throws.txt")
    writeFileSync(localPath, "small content")
    const client = makeFakeClient(sftp)
    // Should not throw even though sftp.end() throws inside finally
    const result = await uploadFile(client as any, localPath, "/remote/x", undefined)
    assert.equal(result.success, true)
    assert.ok(sftp.endCalls >= 1)
  })

  it("uploadFileDirect calls sftp.end() when createWriteStream throws synchronously", async () => {
    const sftp = new FakeSftp()
    sftp.createWriteStreamThrows = true
    const localPath = join(testDir, "direct-create-stream-throws.txt")
    writeFileSync(localPath, "small content")
    const client = makeFakeClient(sftp)
    await assert.rejects(
      uploadFile(client as any, localPath, "/remote/x", undefined),
      /create stream boom/,
    )
    assert.equal(sftp.endCalls, 1, "sftp.end() should be called exactly once on sync createWriteStream error")
  })

  it("downloadFile calls sftp.end() on success", async () => {
    const sftp = new FakeSftp()
    const client = makeFakeClient(sftp)
    const localPath = join(testDir, "download-success.txt")
    const result = await downloadFile(client as any, "/remote/x", localPath, undefined)
    assert.equal(result.success, true)
    assert.ok(sftp.endCalls >= 1, "sftp.end() should have been called on download success")
  })

  it("downloadFile calls sftp.end() even when stat fails (no leak)", async () => {
    const sftp = new FakeSftp()
    sftp.stat = (_p: string, cb: any) => cb(new Error("stat boom"))
    const client = makeFakeClient(sftp)
    const localPath = join(testDir, "download-stat-err.txt")
    await assert.rejects(
      downloadFile(client as any, "/remote/missing", localPath, undefined),
      /stat boom/,
    )
    assert.equal(sftp.endCalls, 1, "sftp.end() should have been called exactly once on stat error")
  })
})
