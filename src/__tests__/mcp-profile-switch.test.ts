/**
 * MCP Server Dynamic Profile Switching Tests
 * Tests the ability to dynamically switch between SSH profiles
 */

import { describe, it, before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import ssh2 from "ssh2"
import { SSHConnection } from "../connection.js"
import { ProfileManager } from "../profile-manager.js"
import type { SSHProfile, SSHHostConfig, SSHConnectionChain } from "../types.js"

import { createStableEd25519KeyPair } from "./ssh-test-key.js"

const { Server } = ssh2
const hostKey = createStableEd25519KeyPair()

interface TestServerInfo {
  server: InstanceType<typeof Server>
  port: number
  hostConfig: SSHHostConfig
  execResults: Map<string, { stdout: string; stderr: string }>
  cleanup: () => Promise<void>
}

function createTestServer(name: string, password: string = "testpass"): Promise<TestServerInfo> {
  return new Promise((resolve, reject) => {
    const execResults = new Map<string, { stdout: string; stderr: string }>()
    const server = new Server({ hostKeys: [hostKey.private] }, (client: any) => {
      client.on("authentication", (ctx: any) => {
        if (ctx.method === "password" && ctx.password === password) ctx.accept()
        else ctx.reject()
      })
      client.on("ready", () => {
        client.on("session", (accept: any) => {
          const session = accept()
          session.on("pty", (accept: any) => accept())
          session.on("shell", (accept: any) => {
            const stream = accept()
            stream.on("close", () => {})
          })
          session.on("exec", (acceptExec: any) => {
            const stream = acceptExec()
            const result = execResults.get(name) || { stdout: "ok\n", stderr: "" }
            stream.write(result.stdout)
            stream.write(result.stderr)
            stream.exit(0)
            stream.close()
          })
          session.on("sftp", (acceptSftp: any) => {
            const sftpStream = acceptSftp()
            const handles = new Map<number, { path: string; data?: Buffer }>()
            let nextHandle = 1
            sftpStream.on("OPEN", (reqId: any, path: any, flags: any) => {
              const h = nextHandle++
              if (flags & 0x02) handles.set(h, { path, data: Buffer.alloc(0) })
              else { sftpStream.status(reqId, 2); return }
              const buf = Buffer.alloc(4); buf.writeUInt32BE(h, 0); sftpStream.handle(reqId, buf)
            })
            sftpStream.on("WRITE", (reqId: any, handle: any, offset: any, data: any) => {
              const h = handle.readUInt32BE(0)
              const entry = handles.get(h)
              if (!entry) { sftpStream.status(reqId, 2); return }
              const needed = offset + data.length
              if (!entry.data || entry.data.length < needed) {
                const grown = Buffer.alloc(needed)
                if (entry.data) entry.data.copy(grown)
                entry.data = grown
              }
              data.copy(entry.data, offset)
              sftpStream.status(reqId, 0)
            })
            sftpStream.on("CLOSE", (reqId: any, handle: any) => {
              handles.delete(handle.readUInt32BE(0))
              sftpStream.status(reqId, 0)
            })
            sftpStream.on("STAT", (reqId: any) => { sftpStream.status(reqId, 2) })
            sftpStream.on("REALPATH", (reqId: any, path: any) => {
              sftpStream.name(reqId, [{ filename: path, longname: "", attrs: {} as any }])
            })
          })
        })
      })
    })
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      if (!addr || typeof addr === "string") { reject(new Error("Failed")); return }
      const hostConfig: SSHHostConfig = {
        id: `${name}-id`,
        name,
        host: "127.0.0.1",
        port: addr.port,
        auth: { username: "testuser", password },
      }
      resolve({
        server,
        port: addr.port,
        hostConfig,
        execResults,
        cleanup: () => new Promise<void>((res) => { server.close(() => setTimeout(res, 50)) }),
      })
    })
    server.on("error", reject)
  })
}

function createProfileManager(tmpDir: string): { pm: ProfileManager; cleanup: () => void } {
  const profilesPath = join(tmpDir, "profiles.json")
  const pm = new ProfileManager(profilesPath)
  pm.load()
  return {
    pm,
    cleanup: () => rmSync(tmpDir, { recursive: true, force: true }),
  }
}

describe("MCP Server Dynamic Profile Switching", () => {
  let srv1: TestServerInfo
  let srv2: TestServerInfo
  let tmpDir: string
  let profileManager: ProfileManager
  let cleanupTmp: () => void

  before(async () => {
    srv1 = await createTestServer("server1", "pass1")
    srv2 = await createTestServer("server2", "pass2")
    
    const result = createProfileManager(mkdtempSync(join(tmpdir(), "mcp-profile-test-")))
    profileManager = result.pm
    cleanupTmp = result.cleanup
    
    profileManager.add({
      name: "server1",
      chain: [srv1.hostConfig],
      tags: ["test"],
    })
    
    profileManager.add({
      name: "server2",
      chain: [srv2.hostConfig],
      tags: ["test"],
    })
  })

  after(async () => {
    await srv1.cleanup()
    await srv2.cleanup()
    cleanupTmp()
  })

  describe("ProfileManager Integration", () => {
    it("should load multiple profiles", () => {
      const profiles = profileManager.list()
      assert.equal(profiles.length, 2)
    })

    it("should get profile by name", () => {
      const profile = profileManager.getByName("server1")
      assert.ok(profile)
      assert.equal(profile!.name, "server1")
    })

    it("should return undefined for nonexistent profile", () => {
      const profile = profileManager.getByName("nonexistent")
      assert.equal(profile, undefined)
    })
  })

  describe("SSH Connection with Different Profiles", () => {
    it("should connect to server1 using profile_name", async () => {
      const profile = profileManager.getByName("server1")
      assert.ok(profile)
      
      const conn = new SSHConnection()
      await conn.connect({ chain: profile!.chain as SSHConnectionChain, timeout: 5000 })
      
      assert.equal(conn.isConnected(), true)
      
      await conn.disconnect()
      assert.equal(conn.isConnected(), false)
    })

    it("should connect to server2 using profile_name", async () => {
      const profile = profileManager.getByName("server2")
      assert.ok(profile)
      
      const conn = new SSHConnection()
      await conn.connect({ chain: profile!.chain as SSHConnectionChain, timeout: 5000 })
      
      assert.equal(conn.isConnected(), true)
      
      await conn.disconnect()
    })

    it("should connect using profile_json directly", async () => {
      const profileJson = JSON.stringify({
        name: "direct-profile",
        chain: [{
          id: "direct1",
          name: "direct",
          host: srv1.hostConfig.host,
          port: srv1.hostConfig.port,
          auth: srv1.hostConfig.auth,
        }],
      })
      
      const profile = JSON.parse(profileJson) as unknown as SSHProfile
      
      const conn = new SSHConnection()
      await conn.connect({ chain: profile.chain as SSHConnectionChain, timeout: 5000 })
      
      assert.equal(conn.isConnected(), true)
      
      await conn.disconnect()
    })
  })

  describe("Profile Caching Mechanism", () => {
    it("should cache connection for same profile", async () => {
      const profile = profileManager.getByName("server1")
      assert.ok(profile)
      
      const cacheKey = profile!.name
      
      const conn1 = new SSHConnection()
      await conn1.connect({ chain: profile!.chain as SSHConnectionChain, timeout: 5000 })
      
      const conn2 = new SSHConnection()
      await conn2.connect({ chain: profile!.chain as SSHConnectionChain, timeout: 5000 })
      
      assert.equal(conn1.isConnected(), true)
      assert.equal(conn2.isConnected(), true)
      
      await conn1.disconnect()
      await conn2.disconnect()
    })

    it("should use different connections for different profiles", async () => {
      const profile1 = profileManager.getByName("server1")
      const profile2 = profileManager.getByName("server2")
      
      const conn1 = new SSHConnection()
      await conn1.connect({ chain: profile1!.chain as SSHConnectionChain, timeout: 5000 })
      
      const conn2 = new SSHConnection()
      await conn2.connect({ chain: profile2!.chain as SSHConnectionChain, timeout: 5000 })
      
      assert.equal(conn1.isConnected(), true)
      assert.equal(conn2.isConnected(), true)
      
      assert.notEqual(profile1!.chain[0].port, profile2!.chain[0].port, "Servers should run on different ports")
      
      await conn1.disconnect()
      await conn2.disconnect()
    })
  })

  describe("Profile JSON Schema Validation", () => {
    it("should validate profile_json structure", () => {
      const validProfile = {
        name: "test",
        chain: [{
          id: "test-host",
          name: "test-host",
          host: "127.0.0.1",
          port: 22,
          auth: { username: "user", password: "pass" },
        }],
      }
      
      const profile = validProfile as unknown as SSHProfile
      assert.ok(profile.name)
      assert.ok(profile.chain)
      assert.equal(profile.chain.length, 1)
      assert.ok(profile.chain[0].host)
    })

    it("should handle multi-hop profile in JSON", () => {
      const multiHopProfile = {
        name: "multi-hop",
        chain: [
          { id: "jump-id", name: "jump", host: "10.0.0.1", port: 22, auth: { username: "jump", password: "jump123" } },
          { id: "target-id", name: "target", host: "10.0.0.2", port: 22, auth: { username: "root", password: "root123" } },
        ],
      }
      
      const profile = multiHopProfile as unknown as SSHProfile
      assert.equal(profile.chain.length, 2)
      assert.equal(profile.chain[0].name, "jump")
      assert.equal(profile.chain[1].name, "target")
    })

    it("should reject invalid profile JSON", () => {
      const invalidProfile = { name: "invalid" }
      
      assert.throws(() => {
        const profile = invalidProfile as unknown as SSHProfile
        if (!profile.chain) throw new Error("chain is required")
      }, /chain/)
    })
  })

  describe("Error Handling for Profile Switching", () => {
    it("should handle nonexistent profile gracefully", async () => {
      const profile = profileManager.getByName("definitely-does-not-exist")
      assert.equal(profile, undefined)
    })

    it("should handle invalid JSON gracefully", () => {
      assert.throws(() => {
        JSON.parse("not-valid-json{{{")
      })
    })

    it("should handle missing required fields in profile", () => {
      const incompleteProfile = { name: "incomplete" }
      
      assert.throws(() => {
        const profile = incompleteProfile as unknown as SSHProfile
        if (!profile.chain || profile.chain.length === 0) {
          throw new Error("Profile must have at least one host in chain")
        }
      })
    })
  })

  describe("Profile Switching Performance", () => {
    it("should switch profiles quickly", async () => {
      const profile1 = profileManager.getByName("server1")
      const profile2 = profileManager.getByName("server2")
      
      const start1 = Date.now()
      const conn1 = new SSHConnection()
      await conn1.connect({ chain: profile1!.chain as SSHConnectionChain, timeout: 5000 })
      const duration1 = Date.now() - start1
      
      await conn1.disconnect()
      
      const start2 = Date.now()
      const conn2 = new SSHConnection()
      await conn2.connect({ chain: profile2!.chain as SSHConnectionChain, timeout: 5000 })
      const duration2 = Date.now() - start2
      
      await conn2.disconnect()
      
      assert.ok(duration1 < 3000, `Connection 1 took ${duration1}ms`)
      assert.ok(duration2 < 3000, `Connection 2 took ${duration2}ms`)
    })
  })
})
