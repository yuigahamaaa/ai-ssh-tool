#!/usr/bin/env node

import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const root = resolve(new URL("..", import.meta.url).pathname)
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"))
const npm = process.platform === "win32" ? "npm.cmd" : "npm"
const raw = execFileSync(npm, ["pack", "--dry-run", "--ignore-scripts", "--json"], { cwd: root, encoding: "utf8" })
const files = new Set(JSON.parse(raw)[0]?.files?.map((entry) => entry.path) ?? [])
const required = [
  packageJson.main.replace(/^\.\//, ""),
  ...Object.values(packageJson.bin).map((entry) => entry.replace(/^\.\//, "")),
  "dist/build-info.js",
  "dist/remote-dialect/index.js",
  "dist/remote-dialect/posix.js",
  "dist/remote-dialect/powershell.js",
  "dist/remote-dialect/cmd.js",
]
const missing = required.filter((entry) => !files.has(entry))
if (missing.length > 0) {
  console.error(`[package-check] missing files: ${missing.join(", ")}`)
  process.exit(1)
}
console.log(`[package-check] ${packageJson.name}@${packageJson.version}: ${files.size} files verified`)
