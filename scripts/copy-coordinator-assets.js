import { copyFileSync, mkdirSync } from "fs"
import { dirname, join } from "path"
import { fileURLToPath } from "url"

const root = dirname(fileURLToPath(import.meta.url))
const source = join(root, "..", "src", "coordinator", "systemd")
const target = join(root, "..", "dist", "coordinator", "systemd")
mkdirSync(target, { recursive: true })
for (const name of ["ssh-tool-coordinator.service", "ssh-tool-observer.service"]) {
  copyFileSync(join(source, name), join(target, name))
}
