import { closeSync, existsSync, mkdirSync, openSync, readlinkSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "fs"
import { join } from "path"
import { selectArtifact, verifyArtifact, type CoordinatorManifest } from "./artifact-manifest.js"

export interface CoordinatorInstallerOptions {
  rootDir: string
  publicKey: string
  manifest: CoordinatorManifest
  healthCheck: (releaseDir: string) => Promise<boolean>
}

export class CoordinatorInstaller {
  constructor(private readonly options: CoordinatorInstallerOptions) {}

  select(): ReturnType<typeof selectArtifact> {
    return selectArtifact(process.platform, process.arch, this.options.manifest)
  }

  verify(bytes: Uint8Array): void {
    verifyArtifact(this.select(), bytes, this.options.publicKey)
  }

  async install(version: string, bytes: Uint8Array): Promise<{ installed: boolean; rolledBack: boolean; error?: string }> {
    const lockPath = join(this.options.rootDir, "install.lock")
    mkdirSync(this.options.rootDir, { recursive: true })
    let fd: number
    try { fd = openSync(lockPath, "wx", 0o600) }
    catch { return { installed: false, rolledBack: false, error: "INSTALL_BUSY: another installation is active" } }
    try {
      this.verify(bytes)
      const releases = join(this.options.rootDir, "releases")
      mkdirSync(releases, { recursive: true, mode: 0o700 })
      const candidate = join(releases, version)
      mkdirSync(candidate, { recursive: true, mode: 0o700 })
      writeFileSync(join(candidate, this.select().fileName), bytes, { mode: 0o700 })
      const current = join(this.options.rootDir, "current")
      const previous = existsSync(current) ? readlinkSync(current) : undefined
      if (!await this.options.healthCheck(candidate)) {
        return { installed: false, rolledBack: Boolean(previous), error: "INSTALL_HEALTH_CHECK_FAILED: candidate is unhealthy" }
      }
      const next = join(this.options.rootDir, `.current-${version}-${process.pid}`)
      symlinkSync(candidate, next)
      renameSync(next, current)
      return { installed: true, rolledBack: false }
    } catch (error) {
      return { installed: false, rolledBack: false, error: (error as Error).message }
    } finally {
      closeSync(fd)
      try { unlinkSync(lockPath) } catch {}
    }
  }
}
