import { describe, it, afterEach } from "node:test"
import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { createConnection } from "node:net"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import ssh2 from "ssh2"
import { SSHConnection } from "../connection.js"
import {
  KnownHostsStore,
  describeHostKey,
  knownHostToken,
} from "../known-hosts.js"
import { createStableEd25519KeyPair } from "./ssh-test-key.js"

const { Server } = ssh2
const userKey = createStableEd25519KeyPair()

type TestServer = {
  port: number
  cleanup: () => Promise<void>
}

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ssh-tool-known-hosts-"))
  tempDirs.push(dir)
  return dir
}

function publicKeyBlob(keyPair: ReturnType<typeof createStableEd25519KeyPair>): Buffer {
  return (ssh2.utils as any).parseKey(keyPair.private).getPublicSSH()
}

function hashedHostToken(host: string, salt: Buffer): string {
  const digest = createHmac("sha1", salt).update(host).digest("base64")
  return `|1|${salt.toString("base64")}|${digest}`
}

function startServer(
  hostKey: ReturnType<typeof createStableEd25519KeyPair>,
  port = 0,
  forward = false,
): Promise<TestServer> {
  return new Promise((resolve, reject) => {
    const clients = new Set<any>()
    const sockets = new Set<any>()
    const server = new Server({ hostKeys: [hostKey.private] }, (client: any) => {
      clients.add(client)
      client.on("close", () => clients.delete(client))
      client.on("error", () => {})
      client.on("authentication", (ctx: any) => {
        if (ctx.method === "publickey") ctx.accept()
        else ctx.reject()
      })
      client.on("ready", () => {
        if (forward) {
          client.on("tcpip", (accept: any, rejectConn: any, info: any) => {
            const socket = createConnection(info.destPort, info.destIP, () => {
              sockets.add(socket)
              const stream = accept()
              stream.on("error", () => {})
              socket.on("error", () => {
                sockets.delete(socket)
                try { stream.close() } catch {}
              })
              socket.on("close", () => sockets.delete(socket))
              stream.on("close", () => {
                sockets.delete(socket)
                try { socket.destroy() } catch {}
              })
              socket.pipe(stream)
              stream.pipe(socket)
            })
            socket.on("error", () => {
              try { rejectConn() } catch {}
            })
          })
        }
        client.on("session", (accept: any) => {
          const session = accept()
          session.on("pty", (acceptPty: any) => acceptPty())
          session.on("shell", (acceptShell: any) => {
            const stream = acceptShell()
            stream.on("error", () => {})
            stream.on("close", () => {})
          })
        })
      })
    })

    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        reject(new Error("test server did not expose a TCP port"))
        return
      }
      resolve({
        port: address.port,
        cleanup: () => new Promise<void>((done) => {
          for (const socket of sockets) {
            try { socket.destroy() } catch {}
          }
          sockets.clear()
          for (const client of clients) {
            try { client.end() } catch {}
            try { client._sock?.destroy?.() } catch {}
          }
          server.close(() => done())
        }),
      })
    })
  })
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe("KnownHostsStore", () => {
  it("accepts a new key by default and appends it without replacing existing lines", () => {
    const dir = makeTempDir()
    const path = join(dir, "known_hosts")
    const key = publicKeyBlob(createStableEd25519KeyPair())
    const existing = "# keep this comment\nlegacy.example ssh-ed25519 AAAAlegacy comment\n"
    writeFileSync(path, existing)

    const result = new KnownHostsStore(path).verify("new.example", 22, key)

    assert.equal(result.accepted, true)
    assert.equal(result.warning, undefined)
    const contents = readFileSync(path, "utf8")
    assert.ok(contents.startsWith(existing))
    assert.ok(contents.includes(`new.example ${describeHostKey(key).algorithm} ${key.toString("base64")}`))
  })

  it("does not overwrite an exact existing entry", () => {
    const dir = makeTempDir()
    const path = join(dir, "known_hosts")
    const key = publicKeyBlob(createStableEd25519KeyPair())
    writeFileSync(path, `${knownHostToken("same.example", 22)} ${describeHostKey(key).algorithm} ${key.toString("base64")} old-comment\n`)
    const before = readFileSync(path, "utf8")

    const result = new KnownHostsStore(path).verify("same.example", 22, key)

    assert.equal(result.accepted, true)
    assert.equal(readFileSync(path, "utf8"), before)
  })

  it("warns while creating a missing known_hosts file and still accepts the first key", () => {
    const dir = makeTempDir()
    const path = join(dir, "known_hosts")
    const key = publicKeyBlob(createStableEd25519KeyPair())
    const warnings: string[] = []

    const result = new KnownHostsStore(path, { warn: (message) => warnings.push(message) })
      .verify("new-file.example", 22, key)

    assert.equal(result.accepted, true)
    assert.ok(result.warning)
    assert.ok(warnings.some((message) => /did not exist|created/i.test(message)))
    assert.ok(existsSync(path))
  })

  it("matches hashed host entries", () => {
    const dir = makeTempDir()
    const path = join(dir, "known_hosts")
    const key = publicKeyBlob(createStableEd25519KeyPair())
    const salt = Buffer.from("known-host-salt")
    const token = hashedHostToken("hashed.example", salt)
    writeFileSync(path, `${token} ${describeHostKey(key).algorithm} ${key.toString("base64")}\n`)
    const before = readFileSync(path, "utf8")

    const result = new KnownHostsStore(path).verify("hashed.example", 22, key)

    assert.equal(result.accepted, true)
    assert.equal(readFileSync(path, "utf8"), before)
  })

  it("rejects a changed fingerprint with actionable repair instructions", () => {
    const dir = makeTempDir()
    const path = join(dir, "known_hosts")
    const oldKey = publicKeyBlob(createStableEd25519KeyPair())
    const newKey = publicKeyBlob(createStableEd25519KeyPair())
    writeFileSync(path, `${knownHostToken("changed.example", 2222)} ${describeHostKey(oldKey).algorithm} ${oldKey.toString("base64")} bastion\n`)
    const before = readFileSync(path, "utf8")

    const result = new KnownHostsStore(path).verify("changed.example", 2222, newKey)

    assert.equal(result.accepted, false)
    assert.ok(result.error)
    assert.match(result.error!.message, /changed\.example:2222/)
    assert.match(result.error!.message, new RegExp(describeHostKey(newKey).algorithm))
    assert.match(result.error!.message, new RegExp(describeHostKey(oldKey).fingerprint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    assert.match(result.error!.message, new RegExp(describeHostKey(newKey).fingerprint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    assert.match(result.error!.message, /known_hosts.*line 1/i)
    assert.match(result.error!.message, /strictHostKeyChecking:\s*["']no["']/)
    assert.match(result.error!.message, /authentication/i)
    assert.equal(readFileSync(path, "utf8"), before)
  })

  it("requires an existing entry in yes mode when storage is available", () => {
    const dir = makeTempDir()
    const path = join(dir, "known_hosts")
    writeFileSync(path, "")
    const key = publicKeyBlob(createStableEd25519KeyPair())

    const result = new KnownHostsStore(path).verify("strict.example", 22, key, "yes")

    assert.equal(result.accepted, false)
    assert.match(result.error?.message ?? "", /no matching known_hosts entry/i)
    assert.match(result.error?.message ?? "", /new fingerprint/i)
    assert.match(result.error?.message ?? "", /old fingerprint.*none/i)
  })

  it("accepts no mode without reading storage, preserving pooled jump-host behavior", () => {
    const dir = makeTempDir()
    const path = join(dir, "does-not-exist", "known_hosts")
    const key = publicKeyBlob(createStableEd25519KeyPair())
    const warnings: string[] = []

    const result = new KnownHostsStore(path, { warn: (message) => warnings.push(message) })
      .verify("pooled.example", 22, key, "no")

    assert.equal(result.accepted, true)
    assert.deepEqual(warnings, [])
    assert.equal(existsSync(path), false)
  })

  it("warns and continues when known_hosts storage is unavailable", () => {
    const dir = makeTempDir()
    const warnings: string[] = []
    const key = publicKeyBlob(createStableEd25519KeyPair())

    // A missing parent cannot be read or appended to, which gives a
    // deterministic missing-file case without relying on chmod/root behavior.
    const missingPath = join(dir, "missing", "known_hosts")
    const result = new KnownHostsStore(missingPath, { warn: (message) => warnings.push(message) })
      .verify("unavailable.example", 22, key)

    assert.equal(result.accepted, true)
    assert.ok(warnings.some((message) => /known_hosts/i.test(message)))
  })
})

describe("SSHConnection host-key verification", () => {
  it("uses accept-new independently from password/key login authentication", async () => {
    const dir = makeTempDir()
    const path = join(dir, "known_hosts")
    const server = await startServer(createStableEd25519KeyPair())
    const conn = new SSHConnection()
    try {
      await conn.connect({
        chain: [{
          id: "public-key-hop",
          name: "public-key-hop",
          host: "127.0.0.1",
          port: server.port,
          knownHostsPath: path,
          auth: { username: "testuser", privateKey: userKey.private },
        }],
        timeout: 5000,
      })
      assert.equal(conn.isConnected(), true)
      assert.ok(readFileSync(path, "utf8").includes("127.0.0.1"))
    } finally {
      await conn.disconnect()
      await server.cleanup()
    }
  })

  it("rejects a changed server key and preserves the repair details at the connection boundary", async () => {
    const dir = makeTempDir()
    const path = join(dir, "known_hosts")
    const first = await startServer(createStableEd25519KeyPair())
    const firstConn = new SSHConnection()
    const port = first.port
    try {
      await firstConn.connect({
        chain: [{ id: "first", name: "first", host: "127.0.0.1", port, knownHostsPath: path, auth: { username: "u", privateKey: userKey.private } }],
        timeout: 5000,
      })
      await firstConn.disconnect()
      await first.cleanup()

      const second = await startServer(createStableEd25519KeyPair(), port)
      try {
        const secondConn = new SSHConnection()
        await assert.rejects(
          () => secondConn.connect({
            chain: [{ id: "changed", name: "changed", host: "127.0.0.1", port, knownHostsPath: path, auth: { username: "u", privateKey: userKey.private } }],
            timeout: 5000,
          }),
          (error: Error) => {
            assert.match(error.message, /Host key verification failed/i)
            assert.match(error.message, new RegExp(`127\\.0\\.0\\.1:${port}`))
            assert.match(error.message, /ssh-ed25519/)
            assert.match(error.message, /new fingerprint/i)
            assert.match(error.message, /old fingerprint/i)
            assert.match(error.message, /known_hosts.*line/i)
            assert.match(error.message, /strictHostKeyChecking.*no/i)
            return true
          },
        )
      } finally {
        await second.cleanup()
      }
    } finally {
      if (firstConn.isConnected()) await firstConn.disconnect()
    }
  })

  it("keeps the old accept-any-key behavior when a pooled jump host opts into no", async () => {
    const dir = makeTempDir()
    const path = join(dir, "known_hosts")
    const first = await startServer(createStableEd25519KeyPair())
    const firstConn = new SSHConnection()
    const port = first.port
    try {
      await firstConn.connect({
        chain: [{ id: "first", name: "first", host: "127.0.0.1", port, knownHostsPath: path, auth: { username: "u", privateKey: userKey.private } }],
        timeout: 5000,
      })
      await firstConn.disconnect()
      await first.cleanup()

      const second = await startServer(createStableEd25519KeyPair(), port)
      const secondConn = new SSHConnection()
      try {
        await secondConn.connect({
          chain: [{ id: "pooled", name: "pooled", host: "127.0.0.1", port, knownHostsPath: path, strictHostKeyChecking: "no", auth: { username: "u", privateKey: userKey.private } }],
          timeout: 5000,
        })
        assert.equal(secondConn.isConnected(), true)
      } finally {
        await secondConn.disconnect()
        await second.cleanup()
      }
    } finally {
      if (firstConn.isConnected()) await firstConn.disconnect()
    }
  })

  it("records and checks every hop independently", async () => {
    const dir = makeTempDir()
    const path = join(dir, "known_hosts")
    const gateway = await startServer(createStableEd25519KeyPair(), 0, true)
    const target = await startServer(createStableEd25519KeyPair())
    const conn = new SSHConnection()
    try {
      await conn.connect({
        chain: [
          { id: "gateway", name: "gateway", host: "127.0.0.1", port: gateway.port, knownHostsPath: path, auth: { username: "u", privateKey: userKey.private } },
          { id: "target", name: "target", host: "127.0.0.1", port: target.port, knownHostsPath: path, auth: { username: "u", privateKey: userKey.private } },
        ],
        timeout: 10000,
      })
      assert.equal(conn.isConnected(), true)
      const contents = readFileSync(path, "utf8")
      assert.ok(contents.includes(`[127.0.0.1]:${gateway.port}`))
      assert.ok(contents.includes(`[127.0.0.1]:${target.port}`))
    } finally {
      await conn.disconnect()
      await gateway.cleanup()
      await target.cleanup()
    }
  })

  it("rejects a changed key on the first hop before authenticating the final hop", async () => {
    const dir = makeTempDir()
    const path = join(dir, "known_hosts")
    const firstGateway = await startServer(createStableEd25519KeyPair(), 0, true)
    const target = await startServer(createStableEd25519KeyPair())
    const initial = new SSHConnection()
    const gatewayPort = firstGateway.port
    try {
      await initial.connect({
        chain: [
          { id: "gateway", name: "gateway", host: "127.0.0.1", port: gatewayPort, knownHostsPath: path, auth: { username: "u", privateKey: userKey.private } },
          { id: "target", name: "target", host: "127.0.0.1", port: target.port, knownHostsPath: path, auth: { username: "u", privateKey: userKey.private } },
        ],
        timeout: 10000,
      })
      await initial.disconnect()
      await firstGateway.cleanup()

      const replacementGateway = await startServer(createStableEd25519KeyPair(), gatewayPort, true)
      try {
        const replacement = new SSHConnection()
        await assert.rejects(
          () => replacement.connect({
            chain: [
              { id: "gateway", name: "gateway", host: "127.0.0.1", port: gatewayPort, knownHostsPath: path, auth: { username: "u", privateKey: userKey.private } },
              { id: "target", name: "target", host: "127.0.0.1", port: target.port, knownHostsPath: path, auth: { username: "u", privateKey: userKey.private } },
            ],
            timeout: 10000,
          }),
          (error: Error) => {
            assert.match(error.message, new RegExp(`127\\.0\\.0\\.1:${gatewayPort}`))
            assert.match(error.message, /Host key verification failed/i)
            return true
          },
        )
      } finally {
        await replacementGateway.cleanup()
      }
    } finally {
      if (initial.isConnected()) await initial.disconnect()
      await target.cleanup()
    }
  })
})
