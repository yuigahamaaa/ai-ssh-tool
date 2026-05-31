/**
 * RemoteFs Unit Tests
 * Tests file operations with a mocked SFTPWrapper
 */

import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "events"
import { createRemoteFs } from "../remote-fs.js"
import type { RemoteFs } from "../remote-fs.js"

// --- Mock SFTPWrapper ---

function createMockSftp() {
  const sftp: any = new EventEmitter()

  sftp.realpath = mock.fn((_path: string, cb: Function) => {
    cb(null, "/home/testuser")
  })

  sftp.createReadStream = mock.fn((_path: string) => {
    const stream = new EventEmitter()
    process.nextTick(() => {
      stream.emit("data", Buffer.from("file content line 1\n"))
      stream.emit("data", Buffer.from("file content line 2\n"))
      stream.emit("end")
    })
    return stream
  })

  sftp.createWriteStream = mock.fn((_path: string, _opts?: any) => {
    const stream: any = new EventEmitter()
    stream.end = mock.fn(() => {
      process.nextTick(() => stream.emit("close"))
    })
    return stream
  })

  sftp.stat = mock.fn((_path: string, cb: Function) => {
    cb(null, {
      size: 1024,
      uid: 1000,
      gid: 1000,
      mode: 0o100644,
      atime: 1000,
      mtime: 2000,
    })
  })

  sftp.readdir = mock.fn((_path: string, cb: Function) => {
    cb(null, [
      {
        filename: "file.txt",
        longname: "-rw-r--r-- 1 user group 1024 Jan 1 00:00 file.txt",
        attrs: { size: 1024, uid: 1000, gid: 1000, mode: 0o100644, atime: 1000, mtime: 2000 },
      },
      {
        filename: "subdir",
        longname: "drwxr-xr-x 2 user group 4096 Jan 1 00:00 subdir",
        attrs: { size: 4096, uid: 1000, gid: 1000, mode: 0o040755, atime: 1000, mtime: 2000 },
      },
    ])
  })

  sftp.unlink = mock.fn((_path: string, cb: Function) => cb(null))
  sftp.mkdir = mock.fn((_path: string, _opts: any, cb: Function) => cb(null))
  sftp.rmdir = mock.fn((_path: string, cb: Function) => cb(null))
  sftp.rename = mock.fn((_old: string, _new: string, cb: Function) => cb(null))
  sftp.chmod = mock.fn((_path: string, _mode: number, cb: Function) => cb(null))
  sftp.end = mock.fn(() => {})

  return sftp
}

// Mock ssh2 Client that provides our mock SFTP
function createMockClient(sftp?: any) {
  const client = new EventEmitter() as any
  client.sftp = mock.fn((cb: Function) => {
    cb(null, sftp ?? createMockSftp())
  })
  return client
}

import { mock } from "node:test"

describe("RemoteFs", () => {
  describe("createRemoteFs", () => {
    it("should create RemoteFs from client", async () => {
      const client = createMockClient()
      const fs = await createRemoteFs(client)
      assert.ok(fs)
      assert.ok(typeof fs.readFile === "function")
      assert.ok(typeof fs.writeFile === "function")
      fs.close()
    })

    it("should reject on SFTP error", async () => {
      const client = new EventEmitter() as any
      client.sftp = mock.fn((cb: Function) => {
        cb(new Error("SFTP failed"))
      })

      await assert.rejects(
        () => createRemoteFs(client),
        { message: "Failed to open SFTP: SFTP failed" },
      )
    })
  })

  describe("readFile", () => {
    it("should read file as string with encoding", async () => {
      const client = createMockClient()
      const fs = await createRemoteFs(client)

      const content = await fs.readFile("/tmp/test.txt", { encoding: "utf-8" })
      assert.ok(typeof content === "string")
      assert.ok(content.includes("file content line 1"))
      assert.ok(content.includes("file content line 2"))
      fs.close()
    })

    it("should read file as Buffer without encoding", async () => {
      const client = createMockClient()
      const fs = await createRemoteFs(client)

      const content = await fs.readFile("/tmp/test.txt")
      assert.ok(Buffer.isBuffer(content))
      fs.close()
    })

    it("should throw when SFTP is closed", async () => {
      const client = createMockClient()
      const fs = await createRemoteFs(client)
      fs.close()

      await assert.rejects(
        () => fs.readFile("/tmp/test.txt"),
        { message: "SFTP connection is closed" },
      )
    })
  })

  describe("writeFile", () => {
    it("should write string content", async () => {
      const client = createMockClient()
      const fs = await createRemoteFs(client)

      await fs.writeFile("/tmp/out.txt", "hello world")
      // Should not throw
      fs.close()
    })

    it("should write Buffer content", async () => {
      const client = createMockClient()
      const fs = await createRemoteFs(client)

      await fs.writeFile("/tmp/out.bin", Buffer.from([0x00, 0x01, 0x02]))
      fs.close()
    })

    it("should throw when SFTP is closed", async () => {
      const client = createMockClient()
      const fs = await createRemoteFs(client)
      fs.close()

      await assert.rejects(
        () => fs.writeFile("/tmp/out.txt", "data"),
        { message: "SFTP connection is closed" },
      )
    })
  })

  describe("stat", () => {
    it("should return file stats", async () => {
      const client = createMockClient()
      const fs = await createRemoteFs(client)

      const stat = await fs.stat("/tmp/file.txt")
      assert.equal(stat.size, 1024)
      assert.equal(stat.uid, 1000)
      assert.equal(stat.gid, 1000)
      assert.equal(stat.isFile, true)
      assert.equal(stat.isDirectory, false)
      assert.equal(stat.isSymbolicLink, false)
      fs.close()
    })

    it("should detect directory mode", async () => {
      const sftp = createMockSftp()
      sftp.stat = mock.fn((_path: string, cb: Function) => {
        cb(null, {
          size: 4096,
          uid: 1000,
          gid: 1000,
          mode: 0o040755,
          atime: 1000,
          mtime: 2000,
        })
      })
      const client = createMockClient(sftp)
      const fs = await createRemoteFs(client)

      const stat = await fs.stat("/tmp/dir")
      assert.equal(stat.isDirectory, true)
      assert.equal(stat.isFile, false)
      fs.close()
    })

    it("should detect symlink mode", async () => {
      const sftp = createMockSftp()
      sftp.stat = mock.fn((_path: string, cb: Function) => {
        cb(null, {
          size: 100,
          uid: 1000,
          gid: 1000,
          mode: 0o120777,
          atime: 1000,
          mtime: 2000,
        })
      })
      const client = createMockClient(sftp)
      const fs = await createRemoteFs(client)

      const stat = await fs.stat("/tmp/link")
      assert.equal(stat.isSymbolicLink, true)
      fs.close()
    })
  })

  describe("exists", () => {
    it("should return true when file exists", async () => {
      const client = createMockClient()
      const fs = await createRemoteFs(client)

      const exists = await fs.exists("/tmp/file.txt")
      assert.equal(exists, true)
      fs.close()
    })

    it("should return false when file does not exist", async () => {
      const sftp = createMockSftp()
      sftp.stat = mock.fn((_path: string, cb: Function) => {
        cb(new Error("No such file"))
      })
      const client = createMockClient(sftp)
      const fs = await createRemoteFs(client)

      const exists = await fs.exists("/tmp/nonexistent")
      assert.equal(exists, false)
      fs.close()
    })
  })

  describe("readdir", () => {
    it("should list directory entries", async () => {
      const client = createMockClient()
      const fs = await createRemoteFs(client)

      const entries = await fs.readdir("/tmp")
      assert.equal(entries.length, 2)
      assert.equal(entries[0].filename, "file.txt")
      assert.equal(entries[0].attrs.isFile, true)
      assert.equal(entries[1].filename, "subdir")
      assert.equal(entries[1].attrs.isDirectory, true)
      fs.close()
    })
  })

  describe("unlink", () => {
    it("should delete a file", async () => {
      const client = createMockClient()
      const fs = await createRemoteFs(client)

      await fs.unlink("/tmp/file.txt")
      // Should not throw
      fs.close()
    })
  })

  describe("mkdir", () => {
    it("should create a directory", async () => {
      const client = createMockClient()
      const fs = await createRemoteFs(client)

      await fs.mkdir("/tmp/newdir", 0o755)
      fs.close()
    })
  })

  describe("rmdir", () => {
    it("should remove a directory", async () => {
      const client = createMockClient()
      const fs = await createRemoteFs(client)

      await fs.rmdir("/tmp/dir")
      fs.close()
    })
  })

  describe("rename", () => {
    it("should rename a file", async () => {
      const client = createMockClient()
      const fs = await createRemoteFs(client)

      await fs.rename("/tmp/old.txt", "/tmp/new.txt")
      fs.close()
    })
  })

  describe("chmod", () => {
    it("should change file permissions", async () => {
      const client = createMockClient()
      const fs = await createRemoteFs(client)

      await fs.chmod("/tmp/file.txt", 0o755)
      fs.close()
    })
  })

  describe("resolvePath", () => {
    it("should resolve tilde to home directory", async () => {
      const client = createMockClient()
      const fs = await createRemoteFs(client)

      const resolved = await fs.resolvePath("~/documents")
      assert.equal(resolved, "/home/testuser/documents")
      fs.close()
    })

    it("should pass through absolute paths", async () => {
      const client = createMockClient()
      const fs = await createRemoteFs(client)

      const resolved = await fs.resolvePath("/tmp/file.txt")
      assert.equal(resolved, "/tmp/file.txt")
      fs.close()
    })
  })

  describe("close", () => {
    it("should close SFTP connection", async () => {
      const sftp = createMockSftp()
      const client = createMockClient(sftp)
      const fs = await createRemoteFs(client)

      fs.close()
      assert.equal(sftp.end.mock.callCount(), 1)
    })

    it("should be idempotent", async () => {
      const sftp = createMockSftp()
      const client = createMockClient(sftp)
      const fs = await createRemoteFs(client)

      fs.close()
      fs.close()
      // end() should only be called once
      assert.equal(sftp.end.mock.callCount(), 1)
    })
  })
})
