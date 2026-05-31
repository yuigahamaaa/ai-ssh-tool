/**
 * Dependency checker - verifies required packages are installed
 * Run at CLI entry point, exits with helpful message if deps missing
 */

import { createRequire } from "module"
import { dirname, join } from "path"
import { fileURLToPath } from "url"
import { existsSync } from "fs"

const REQUIRED_DEPS = ["ssh2", "uuid"] as const

export function checkDeps(): void {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const projectRoot = join(__dirname, "..")
  const nodeModules = join(projectRoot, "node_modules")

  // Check if node_modules exists
  if (!existsSync(nodeModules)) {
    console.error(`[ssh-tool] 缺少依赖，请先安装:`)
    console.error(`  cd ${projectRoot} && npm install`)
    process.exit(1)
  }

  // Check each required dependency
  const missing: string[] = []
  for (const dep of REQUIRED_DEPS) {
    if (!existsSync(join(nodeModules, dep))) {
      missing.push(dep)
    }
  }

  if (missing.length > 0) {
    console.error(`[ssh-tool] 缺少依赖: ${missing.join(", ")}`)
    console.error(`  cd ${projectRoot} && npm install`)
    process.exit(1)
  }
}

/**
 * Get the skill project root directory
 */
export function getSkillRoot(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  return join(__dirname, "..")
}
