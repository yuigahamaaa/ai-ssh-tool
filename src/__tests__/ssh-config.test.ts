import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { writeFileSync, mkdirSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { parseSSHConfigContent, parseSSHConfig } from "../ssh-config.js"

describe("parseSSHConfigContent", () => {
  it("parses basic Host with HostName, User, Port", () => {
    const config = parseSSHConfigContent(`
Host myserver
  HostName 192.168.1.100
  User admin
  Port 2222
`)
    assert.equal(config.hosts.length, 1)
    assert.equal(config.hosts[0].hostPattern, "myserver")
    assert.equal(config.hosts[0].hostName, "192.168.1.100")
    assert.equal(config.hosts[0].user, "admin")
    assert.equal(config.hosts[0].port, 2222)
  })

  it("parses multiple Host entries", () => {
    const config = parseSSHConfigContent(`
Host server1
  HostName 10.0.0.1

Host server2
  HostName 10.0.0.2
  User deploy
`)
    assert.equal(config.hosts.length, 2)
    assert.equal(config.hosts[0].hostPattern, "server1")
    assert.equal(config.hosts[1].hostPattern, "server2")
    assert.equal(config.hosts[1].user, "deploy")
  })

  it("parses multi-host patterns (Host web1 web2)", () => {
    const config = parseSSHConfigContent(`
Host web1 web2 web3
  HostName 10.0.0.1
  User www
  Port 8022
`)
    assert.equal(config.hosts.length, 3)
    assert.equal(config.hosts[0].hostPattern, "web1")
    assert.equal(config.hosts[1].hostPattern, "web2")
    assert.equal(config.hosts[2].hostPattern, "web3")
    for (const entry of config.hosts) {
      assert.equal(entry.hostName, "10.0.0.1")
      assert.equal(entry.user, "www")
      assert.equal(entry.port, 8022)
    }
  })

  it("ignores comments and empty lines", () => {
    const config = parseSSHConfigContent(`
# This is a comment

Host myserver
  # Another comment
  HostName 10.0.0.1
  User root

# Trailing comment
`)
    assert.equal(config.hosts.length, 1)
    assert.equal(config.hosts[0].hostPattern, "myserver")
    assert.equal(config.hosts[0].hostName, "10.0.0.1")
  })

  it("returns empty hosts list for empty config", () => {
    const config = parseSSHConfigContent("")
    assert.equal(config.hosts.length, 0)
    assert.deepEqual(config.hosts, [])
  })

  it("returns empty hosts list for whitespace-only config", () => {
    const config = parseSSHConfigContent("   \n\n  \n  ")
    assert.equal(config.hosts.length, 0)
  })

  it("parses ProxyJump chain", () => {
    const config = parseSSHConfigContent(`
Host gateway
  HostName gw.corp.com
  User admin

Host target
  HostName 10.0.0.50
  User deploy
  ProxyJump gateway
`)
    const chain = config.resolve("target")
    assert.equal(chain.length, 2)
    assert.equal(chain[0].name, "gateway")
    assert.equal(chain[0].host, "gw.corp.com")
    assert.equal(chain[0].auth.username, "admin")
    assert.equal(chain[1].name, "target")
    assert.equal(chain[1].host, "10.0.0.50")
    assert.equal(chain[1].auth.username, "deploy")
  })

  it("handles ProxyJump none (should be ignored)", () => {
    const config = parseSSHConfigContent(`
Host direct
  HostName 10.0.0.1
  User admin
  ProxyJump none
`)
    const chain = config.resolve("direct")
    assert.equal(chain.length, 1)
    assert.equal(chain[0].name, "direct")
    assert.equal(chain[0].host, "10.0.0.1")
  })

  it("parses IdentityFile", () => {
    const config = parseSSHConfigContent(`
Host myhost
  HostName 10.0.0.1
  IdentityFile ~/.ssh/my_key
  IdentityFile ~/.ssh/my_key2
`)
    assert.equal(config.hosts[0].identityFile?.length, 2)
    assert.equal(config.hosts[0].identityFile?.[0], "~/.ssh/my_key")
    assert.equal(config.hosts[0].identityFile?.[1], "~/.ssh/my_key2")
  })

  it("parses ForwardAgent and IdentityAgent", () => {
    const config = parseSSHConfigContent(`
Host myhost
  HostName 10.0.0.1
  ForwardAgent yes
  IdentityAgent /tmp/agent.sock
`)
    assert.equal(config.hosts[0].forwardAgent, true)
    assert.equal(config.hosts[0].identityAgent, "/tmp/agent.sock")
  })

  it("ForwardAgent no is parsed as false", () => {
    const config = parseSSHConfigContent(`
Host myhost
  HostName 10.0.0.1
  ForwardAgent no
`)
    assert.equal(config.hosts[0].forwardAgent, false)
  })

  it("wildcard Host pattern matches correctly", () => {
    const config = parseSSHConfigContent(`
Host *.corp.com
  User corpuser
  Port 2222

Host bastion-*
  User bastionuser
`)
    assert.equal(config.hosts.length, 2)

    const matched = config.getHost("server.corp.com")
    assert.equal(matched.user, "corpuser")
    assert.equal(matched.port, 2222)

    const bastionMatched = config.getHost("bastion-prod")
    assert.equal(bastionMatched.user, "bastionuser")

    const noMatch = config.getHost("other.com")
    assert.equal(noMatch.user, undefined)
  })

  it("getHost merges matching entries (later overrides earlier)", () => {
    const config = parseSSHConfigContent(`
Host *
  User defaultuser
  Port 22

Host special
  HostName special.example.com
  User specialuser
  Port 2222
`)
    const host = config.getHost("special")
    assert.equal(host.hostName, "special.example.com")
    assert.equal(host.user, "specialuser")
    assert.equal(host.port, 2222)
  })

  it("getHost merges wildcard and specific entries", () => {
    const config = parseSSHConfigContent(`
Host *
  User fallback
  ForwardAgent yes

Host myserver
  HostName 10.0.0.1
  User admin
`)
    const host = config.getHost("myserver")
    assert.equal(host.hostName, "10.0.0.1")
    assert.equal(host.user, "admin")
    assert.equal(host.forwardAgent, true)
  })

  it("resolve() returns correct SSHConnectionChain for direct connection", () => {
    const config = parseSSHConfigContent(`
Host target
  HostName 10.0.0.1
  User admin
  Port 2222
`)
    const chain = config.resolve("target")
    assert.equal(chain.length, 1)

    const target = chain[0]
    assert.ok(target.id.startsWith("ssh-cfg-"))
    assert.equal(target.name, "target")
    assert.equal(target.host, "10.0.0.1")
    assert.equal(target.port, 2222)
    assert.equal(target.auth.username, "admin")
    assert.equal(target.auth.privateKey, undefined)
    assert.equal(target.auth.agent, undefined)
    assert.equal(target.auth.agentForward, undefined)
  })

  it("resolve() uses defaults when fields are missing", () => {
    const config = parseSSHConfigContent(`
Host minimal
  HostName 10.0.0.1
`)
    const chain = config.resolve("minimal")
    assert.equal(chain.length, 1)
    assert.equal(chain[0].port, 22)
    assert.equal(chain[0].auth.username, "root")
  })

  it("resolve() passes through IdentityAgent and ForwardAgent", () => {
    const config = parseSSHConfigContent(`
Host myhost
  HostName 10.0.0.1
  User admin
  ForwardAgent yes
  IdentityAgent /tmp/agent.sock
`)
    const chain = config.resolve("myhost")
    assert.equal(chain[0].auth.agent, "/tmp/agent.sock")
    assert.equal(chain[0].auth.agentForward, true)
  })

  it("circular ProxyJump does not infinite loop", () => {
    const config = parseSSHConfigContent(`
Host hostA
  HostName 10.0.0.1
  ProxyJump hostB

Host hostB
  HostName 10.0.0.2
  ProxyJump hostA
`)
    const chain = config.resolve("hostA")
    assert.ok(chain.length > 0, "chain should not be empty")
    assert.ok(chain.length <= 3, `chain length ${chain.length} should be bounded`)
  })

  it("self-referencing ProxyJump does not infinite loop", () => {
    const config = parseSSHConfigContent(`
Host loop
  HostName 10.0.0.1
  ProxyJump loop
`)
    const chain = config.resolve("loop")
    assert.equal(chain.length, 1)
    assert.equal(chain[0].name, "loop")
  })

  it("resolve() resolves unconfigured host as direct connection", () => {
    const config = parseSSHConfigContent(`
Host known
  HostName 10.0.0.1
`)
    const chain = config.resolve("unknown-host")
    assert.equal(chain.length, 1)
    assert.equal(chain[0].host, "unknown-host")
    assert.equal(chain[0].port, 22)
    assert.equal(chain[0].auth.username, "root")
  })
})

describe("parseSSHConfig (file-based)", () => {
  let testDir: string

  beforeEach(() => {
    testDir = join(tmpdir(), `ssh-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    try { rmSync(testDir, { recursive: true }) } catch {}
  })

  it("parses a config file from disk", () => {
    const configPath = join(testDir, "config")
    writeFileSync(configPath, `
Host fromfile
  HostName 192.168.1.1
  User fileuser
  Port 2222
`)
    const config = parseSSHConfig(configPath)
    assert.equal(config.hosts.length, 1)
    assert.equal(config.hosts[0].hostPattern, "fromfile")
    assert.equal(config.hosts[0].hostName, "192.168.1.1")
    assert.equal(config.hosts[0].user, "fileuser")
  })

  it("returns empty config when file does not exist", () => {
    const config = parseSSHConfig(join(testDir, "nonexistent"))
    assert.equal(config.hosts.length, 0)
    assert.equal(config.resolve("anything").length, 1)
  })

  it("resolves Include directive with relative path", () => {
    const configPath = join(testDir, "config")
    const includePath = join(testDir, "extra_hosts")
    writeFileSync(includePath, `
Host included-host
  HostName 10.99.0.1
  User included-user
`)
    writeFileSync(configPath, `
Include extra_hosts

Host main-host
  HostName 10.0.0.1
  User main-user
`)
    const config = parseSSHConfig(configPath)
    assert.ok(config.hosts.length >= 2, `expected at least 2 hosts, got ${config.hosts.length}`)
    const included = config.hosts.find(h => h.hostPattern === "included-host")
    assert.ok(included, "included host should exist")
    assert.equal(included!.hostName, "10.99.0.1")
    assert.equal(included!.user, "included-user")

    const main = config.hosts.find(h => h.hostPattern === "main-host")
    assert.ok(main, "main host should exist")
  })

  it("resolves Include directive with absolute path", () => {
    const includePath = join(testDir, "abs_extra")
    writeFileSync(includePath, `
Host abs-included
  HostName 10.88.0.1
  User abs-user
`)
    const configPath = join(testDir, "config")
    writeFileSync(configPath, `
Include ${includePath}

Host local-host
  HostName 10.0.0.1
`)
    const config = parseSSHConfig(configPath)
    const included = config.hosts.find(h => h.hostPattern === "abs-included")
    assert.ok(included, "abs-included host should exist")
    assert.equal(included!.hostName, "10.88.0.1")
  })

  it("silently ignores non-existent Include", () => {
    const configPath = join(testDir, "config")
    writeFileSync(configPath, `
Include nonexistent_file

Host existing
  HostName 10.0.0.1
`)
    const config = parseSSHConfig(configPath)
    assert.equal(config.hosts.length, 1)
    assert.equal(config.hosts[0].hostPattern, "existing")
  })

  it("resolve() with ProxyJump works across included files", () => {
    const jumpConfig = join(testDir, "jumps")
    writeFileSync(jumpConfig, `
Host jump-box
  HostName jump.corp.com
  User jumpuser
`)
    const configPath = join(testDir, "config")
    writeFileSync(configPath, `
Include jumps

Host final-target
  HostName 10.0.0.100
  User targetuser
  ProxyJump jump-box
`)
    const config = parseSSHConfig(configPath)
    const chain = config.resolve("final-target")
    assert.equal(chain.length, 2)
    assert.equal(chain[0].name, "jump-box")
    assert.equal(chain[0].host, "jump.corp.com")
    assert.equal(chain[1].name, "final-target")
    assert.equal(chain[1].host, "10.0.0.100")
  })
})
