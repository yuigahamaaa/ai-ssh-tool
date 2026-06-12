const { rmSync, mkdirSync, writeFileSync, readdirSync, existsSync } = require("fs")
const { join } = require("path")
const { tmpdir } = require("os")
const testHome = join(tmpdir(), "etm-dbg")
rmSync(testHome, { recursive: true, force: true })
mkdirSync(testHome, { recursive: true })
process.env.HOME = testHome
console.log("HOME =", process.env.HOME)
console.log("homedir() =", require("os").homedir())

const dir = join(testHome, ".ssh-tool", "exec-tasks")
mkdirSync(dir, { recursive: true })
const task = { id: "d1", hostname: "host-A", startedAt: 1000, finishedAt: 1100, status: "completed", command: "echo a", type: "exec", exitCode: 0, signal: null, stdout: "", stderr: "", pid: null, createdAt: 1000, updatedAt: 1100 }
writeFileSync(join(dir, "d1.json"), JSON.stringify(task))
console.log("files in storage dir:", readdirSync(dir))

const { ExecTaskManager } = require("./dist/exec-task-manager.js")
const mgr = new ExecTaskManager()
console.log("mgr.list():", JSON.stringify(mgr.list(), null, 2))
