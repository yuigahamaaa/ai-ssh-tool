#!/usr/bin/env node
// Clean stale compiled test output before recompiling.
//
// Why this exists: tsc never deletes the .js for a .ts source that has been
// removed (e.g. background-exec.test.ts was deleted in commit e7ff38d but
// dist/__tests__/background-exec.test.js stayed around, silently keeping a
// stale test in the suite). Wiping dist/__tests__ before each build:test
// guarantees the dist test layout is a faithful mirror of src/__tests__.
//
// Cross-platform on purpose: this project supports Windows daemons, so we
// use Node's fs.rmSync instead of `rm -rf`. The repo declares
// "type": "module" in package.json, so this script is ESM.

import { rmSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const target = resolve(here, "..", "dist", "__tests__")
rmSync(target, { recursive: true, force: true })
