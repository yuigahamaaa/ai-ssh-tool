#!/usr/bin/env node

import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const dist = resolve(root, "dist")
const version = process.env.npm_package_version ?? "2.0.0"
let commit = "unknown"
try {
  commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim() || commit
} catch {}

mkdirSync(dist, { recursive: true })
const source = `export const buildInfo = ${JSON.stringify({ version, commit, builtAt: new Date().toISOString() })};\n`
writeFileSync(resolve(dist, "build-info.js"), source, "utf8")
