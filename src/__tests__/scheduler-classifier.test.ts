import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { classifyCommand } from "../scheduler/command-classifier.js"

describe("Command Classifier", () => {
  describe("high-confidence commands", () => {
    it("classifies ls as inspect/tiny", () => {
      const c = classifyCommand("ls -la")
      assert.equal(c.intent, "inspect")
      assert.equal(c.cost, "tiny")
      assert.equal(c.risky, false)
      assert.equal(c.source, "auto")
    })

    it("classifies pwd as inspect/tiny", () => {
      const c = classifyCommand("pwd")
      assert.equal(c.intent, "inspect")
      assert.equal(c.cost, "tiny")
    })

    it("classifies cat as inspect/tiny", () => {
      const c = classifyCommand("cat package.json")
      assert.equal(c.intent, "inspect")
      assert.equal(c.cost, "tiny")
    })

    it("classifies rg as search/tiny", () => {
      const c = classifyCommand('rg "TODO" src')
      assert.equal(c.intent, "search")
      assert.equal(c.cost, "tiny")
    })

    it("classifies grep as search/tiny", () => {
      const c = classifyCommand("grep -rn foo src")
      assert.equal(c.intent, "search")
      assert.equal(c.cost, "tiny")
    })

    it("classifies npm test as test/large/blocking", () => {
      const c = classifyCommand("npm test")
      assert.equal(c.intent, "test")
      assert.equal(c.cost, "large")
      assert.equal(c.blocking, true)
    })

    it("classifies pnpm test as test/large", () => {
      const c = classifyCommand("pnpm test")
      assert.equal(c.intent, "test")
      assert.equal(c.cost, "large")
    })

    it("classifies pytest as test/large", () => {
      const c = classifyCommand("pytest")
      assert.equal(c.intent, "test")
      assert.equal(c.cost, "large")
    })

    it("classifies npm run build as build/large", () => {
      const c = classifyCommand("npm run build")
      assert.equal(c.intent, "build")
      assert.equal(c.cost, "large")
    })

    it("classifies npm install as install/large/mutates", () => {
      const c = classifyCommand("npm install")
      assert.equal(c.intent, "install")
      assert.equal(c.cost, "large")
      assert.equal(c.mutates, true)
    })

    it("classifies npm run dev as server/large", () => {
      const c = classifyCommand("npm run dev")
      assert.equal(c.intent, "server")
      assert.equal(c.cost, "large")
    })

    it("classifies docker compose up as server/large", () => {
      const c = classifyCommand("docker compose up")
      assert.equal(c.intent, "server")
      assert.equal(c.cost, "large")
    })

    it("classifies kubectl apply as deploy/exclusive/risky", () => {
      const c = classifyCommand("kubectl apply -f deploy.yaml")
      assert.equal(c.intent, "deploy")
      assert.equal(c.cost, "exclusive")
      assert.equal(c.risky, true)
    })

    it("classifies prisma migrate as migration/exclusive/risky", () => {
      const c = classifyCommand("prisma migrate deploy")
      assert.equal(c.intent, "migration")
      assert.equal(c.cost, "exclusive")
      assert.equal(c.risky, true)
    })

    it("classifies rm -rf as cleanup/exclusive/risky", () => {
      const c = classifyCommand("rm -rf /tmp/foo")
      assert.equal(c.intent, "cleanup")
      assert.equal(c.cost, "exclusive")
      assert.equal(c.risky, true)
    })
  })

  describe("script execution classification", () => {
    it("classifies python script as custom/large/mutates", () => {
      const c = classifyCommand("python script.py")
      assert.equal(c.intent, "custom")
      assert.equal(c.cost, "large")
      assert.equal(c.mutates, true)
      assert.equal(c.blocking, true)
    })

    it("classifies python3 script as custom/large", () => {
      const c = classifyCommand("python3 main.py --arg=value")
      assert.equal(c.intent, "custom")
      assert.equal(c.cost, "large")
      assert.equal(c.mutates, true)
    })

    it("classifies bash script as custom/large", () => {
      const c = classifyCommand("bash setup.sh")
      assert.equal(c.intent, "custom")
      assert.equal(c.cost, "large")
      assert.equal(c.mutates, true)
    })

    it("classifies sh script as custom/large", () => {
      const c = classifyCommand("sh deploy.sh prod")
      assert.equal(c.intent, "custom")
      assert.equal(c.cost, "large")
    })

    it("classifies zsh script as custom/large", () => {
      const c = classifyCommand("zsh install.zsh")
      assert.equal(c.intent, "custom")
      assert.equal(c.cost, "large")
    })

    it("classifies node script as custom/large", () => {
      const c = classifyCommand("node index.js")
      assert.equal(c.intent, "custom")
      assert.equal(c.cost, "large")
      assert.equal(c.mutates, true)
    })

    it("classifies ./script.sh as custom/large", () => {
      const c = classifyCommand("./scripts/deploy.sh")
      assert.equal(c.intent, "custom")
      assert.equal(c.cost, "large")
    })

    it("classifies ./script.py as custom/large", () => {
      const c = classifyCommand("./main.py")
      assert.equal(c.intent, "custom")
      assert.equal(c.cost, "large")
    })

    it("classifies ruby script as custom/large", () => {
      const c = classifyCommand("ruby script.rb")
      assert.equal(c.intent, "custom")
      assert.equal(c.cost, "large")
    })

    it("classifies perl script as custom/large", () => {
      const c = classifyCommand("perl script.pl")
      assert.equal(c.intent, "custom")
      assert.equal(c.cost, "large")
    })
  })

  describe("default classification", () => {
    it("classifies unknown command (not script) as custom/medium/default", () => {
      const c = classifyCommand("some-unknown-command")
      assert.equal(c.intent, "custom")
      assert.equal(c.cost, "medium")
      assert.equal(c.blocking, true)
      assert.equal(c.source, "default")
      assert.equal(c.risky, false)
    })
  })

  describe("agent override", () => {
    it("respects agent intent/cost when allowed", () => {
      const c = classifyCommand("echo ok", { intent: "inspect", cost: "tiny" })
      assert.equal(c.cost, "tiny")
      assert.equal(c.source, "agent")
    })

    it("upgrades cost when agent underestimates", () => {
      const c = classifyCommand("npm test", { intent: "test", cost: "tiny" })
      assert.equal(c.cost, "large")
      assert.equal(c.source, "agent_overridden_by_policy")
      assert.ok(c.reason.includes("policy"))
    })

    it("upgrades cost for python scripts when agent underestimates", () => {
      const c = classifyCommand("python script.py", { intent: "inspect", cost: "tiny" })
      assert.equal(c.cost, "large")
      assert.equal(c.source, "agent_overridden_by_policy")
    })
  })

  describe("risky classification", () => {
    it("risky=true regardless of force flag", () => {
      const c = classifyCommand("rm -rf /tmp/foo", { force: true })
      assert.equal(c.risky, true)
    })
  })
})
