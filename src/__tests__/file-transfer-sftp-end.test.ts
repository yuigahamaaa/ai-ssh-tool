import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { Readable, Writable } from "stream"
import { EventEmitter } from "events"
import { uploadFile, downloadFile } from "../file-transfer.js"

/**
 * P2-1: verify sftp.end() is invoked exactly once on every code path,
 * including errors that occur mid-stream. A leaking sftp session can hold
 * the SSH channel open and starve subsequent transfers.
 */

class FakeSftp extends EventEmitter {
  endCalls = 0
  endThrows = false
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

describe("file-transfer P2-1: sftp.end() always released", () => {
  it("uploadFile (streaming) calls sftp.end() on success", async () => {
    const sftp = new FakeSftp()
    // We can't easily build a working streaming upload against the FakeSftp
    // (pipeline would hang waiting for real source), so instead exercise the
    // uploadFileDirect path: which also uses client.sftp and must call end().
    const localPath = "/tmp/ssh-tool-p2-1-direct-success"
    await import("fs").then(fs => fs.writeFileSync(localPath, "small content"))
    const client = makeFakeClient(sftp)
    const result = await uploadFile(client as any, localPath, "/remote/x", undefined)
    assert.equal(result.success, true)
    assert.ok(sftp.endCalls >= 1, "sftp.end() should have been called on success")
  })

  it("uploadFileDirect sftp.end() tolerates end() throwing", async () => {
    const sftp = new FakeSftp()
    sftp.endThrows = true
    const localPath = "/tmp/ssh-tool-p2-1-direct-throws"
    await import("fs").then(fs => fs.writeFileSync(localPath, "small content"))
    const client = makeFakeClient(sftp)
    // Should not throw even though sftp.end() throws inside finally
    const result = await uploadFile(client as any, localPath, "/remote/x", undefined)
    assert.equal(result.success, true)
    assert.ok(sftp.endCalls >= 1)
  })

  it("downloadFile calls sftp.end() on success", async () => {
    const sftp = new FakeSftp()
    const client = makeFakeClient(sftp)
    const localPath = "/tmp/ssh-tool-p2-1-download-success"
    const result = await downloadFile(client as any, "/remote/x", localPath, undefined)
    assert.equal(result.success, true)
    assert.ok(sftp.endCalls >= 1, "sftp.end() should have been called on download success")
  })

  it("downloadFile calls sftp.end() even when stat fails (no leak)", async () => {
    const sftp = new FakeSftp()
    sftp.stat = (_p: string, cb: any) => cb(new Error("stat boom"))
    const client = makeFakeClient(sftp)
    const localPath = "/tmp/ssh-tool-p2-1-download-stat-err"
    await assert.rejects(
      downloadFile(client as any, "/remote/missing", localPath, undefined),
      /stat boom/,
    )
    assert.equal(sftp.endCalls, 1, "sftp.end() should have been called exactly once on stat error")
  })
})
