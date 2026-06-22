import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { TaskCost, TaskIntent } from "./scheduler/types.js"

export const COMMAND_REGISTRY_SCHEMA_VERSION = 1
const COMMAND_REGISTRY_LOCK_TIMEOUT_MS = 5000
const COMMAND_REGISTRY_STALE_LOCK_MS = 30000
const COMMAND_REGISTRY_LOCK_RETRY_MS = 25

export type CommandExecutionMode = "exec" | "schedule" | "background"

export interface CommandExecution {
  mode: CommandExecutionMode
  intent?: TaskIntent
  cost?: TaskCost
}

export interface CommandLogConfig {
  mode: "managed"
}

export interface RegisteredCommand {
  schemaVersion: 1
  project: string
  name: string
  description?: string
  command: string
  cwd?: string
  execution: CommandExecution
  log: CommandLogConfig
  createdAt: number
  updatedAt: number
}

export interface CommandRegistryEntryInput {
  project: string
  name: string
  description?: string
  command: string
  cwd?: string
  execution?: Partial<CommandExecution>
}

export interface CommandRegistryUpdateInput {
  description?: string
  command?: string
  cwd?: string
  execution?: Partial<CommandExecution>
}

interface CommandRegistryEnvelope {
  schemaVersion: 1
  commands: RegisteredCommand[]
}

function getUserDataDir(): string {
  if (process.platform === "win32") {
    const userProfile = process.env.USERPROFILE || process.env.HOMEPATH
    if (userProfile) return userProfile
  }
  return homedir()
}

function atomicWrite(filePath: string, data: string): void {
  const tempPath = `${filePath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  try {
    writeFileSync(tempPath, data, { mode: 0o600 })
    renameSync(tempPath, filePath)
  } catch (err) {
    try { unlinkSync(tempPath) } catch {}
    throw err
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function defaultBaseDir(): string {
  return join(getUserDataDir(), ".ssh-tool", "scheduler")
}

function key(project: string, name: string): string {
  return `${project}\0${name}`
}

function inferIntent(mode: CommandExecutionMode, command: string): TaskIntent | undefined {
  if (mode === "background") return "server"
  if (/\b(test|pytest|go test|cargo test)\b/.test(command)) return "test"
  if (/\b(build|make|cargo build)\b/.test(command)) return "build"
  if (/\b(install|apt|pip|npm install|pnpm install|yarn install)\b/.test(command)) return "install"
  return undefined
}

function defaultCost(mode: CommandExecutionMode): TaskCost {
  return mode === "exec" ? "medium" : "large"
}

function normalizeMode(value: unknown): CommandExecutionMode {
  return value === "exec" || value === "background" || value === "schedule" ? value : "background"
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

export class CommandRegistryStore {
  private readonly stateDir: string
  private readonly filePath: string
  private readonly lockDir: string
  private readonly commands = new Map<string, RegisteredCommand>()

  constructor(baseDir?: string) {
    const root = baseDir ?? defaultBaseDir()
    this.stateDir = join(root, "state")
    this.filePath = join(this.stateDir, "commands.json")
    this.lockDir = join(this.stateDir, "commands.lock")
    if (!existsSync(this.stateDir)) mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
    this.load()
  }

  register(input: CommandRegistryEntryInput): RegisteredCommand {
    return this.withFileLock(() => {
      const latest = this.readCommandsFromDisk()
      const existing = latest.get(key(input.project, input.name))
      const now = Date.now()
      const saved = this.normalizeEntry({
        ...existing,
        ...input,
        execution: { ...existing?.execution, ...input.execution },
        createdAt: existing?.createdAt ?? now,
        updatedAt: existing ? now : now,
      })
      latest.set(key(saved.project, saved.name), saved)
      this.writeCommands(latest)
      this.replaceCommands(latest)
      return saved
    })
  }

  update(project: string, name: string, updates: CommandRegistryUpdateInput): RegisteredCommand | undefined {
    return this.withFileLock(() => {
      const latest = this.readCommandsFromDisk()
      const existing = latest.get(key(project, name))
      if (!existing) return undefined
      const patch: Record<string, unknown> = {}
      if (updates.description !== undefined) patch.description = updates.description
      if (updates.command !== undefined) patch.command = updates.command
      if (updates.cwd !== undefined) patch.cwd = updates.cwd
      const updated = this.normalizeEntry({
        ...existing,
        ...patch,
        project,
        name,
        execution: updates.execution ? { ...existing.execution, ...updates.execution } : existing.execution,
        updatedAt: Date.now(),
      })
      latest.set(key(project, name), updated)
      this.writeCommands(latest)
      this.replaceCommands(latest)
      return updated
    })
  }

  delete(project: string, name: string): boolean {
    return this.withFileLock(() => {
      const latest = this.readCommandsFromDisk()
      const deleted = latest.delete(key(project, name))
      if (deleted) this.writeCommands(latest)
      this.replaceCommands(latest)
      return deleted
    })
  }

  get(project: string, name: string): RegisteredCommand | undefined {
    this.load()
    return this.commands.get(key(project, name))
  }

  list(project?: string): RegisteredCommand[] {
    this.load()
    return this.sortedCommands(this.commands, project)
  }

  private sortedCommands(commands: Map<string, RegisteredCommand>, project?: string): RegisteredCommand[] {
    return Array.from(commands.values())
      .filter(command => project ? command.project === project : true)
      .sort((a, b) => a.project.localeCompare(b.project) || a.name.localeCompare(b.name))
  }

  private load(): void {
    this.replaceCommands(this.readCommandsFromDisk())
  }

  private readCommandsFromDisk(): Map<string, RegisteredCommand> {
    const commands = new Map<string, RegisteredCommand>()
    if (!existsSync(this.filePath)) return commands
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf8"))
      const entries = Array.isArray(raw) ? raw : Array.isArray(raw?.commands) ? raw.commands : []
      for (const entry of entries) {
        const normalized = this.normalizeEntry(entry)
        commands.set(key(normalized.project, normalized.name), normalized)
      }
    } catch {
      return new Map()
    }
    return commands
  }

  private writeCommands(commands: Map<string, RegisteredCommand>): void {
    const envelope: CommandRegistryEnvelope = {
      schemaVersion: COMMAND_REGISTRY_SCHEMA_VERSION,
      commands: this.sortedCommands(commands),
    }
    atomicWrite(this.filePath, JSON.stringify(envelope))
  }

  private replaceCommands(commands: Map<string, RegisteredCommand>): void {
    this.commands.clear()
    for (const command of commands.values()) {
      this.commands.set(key(command.project, command.name), command)
    }
  }

  private withFileLock<T>(fn: () => T): T {
    const deadline = Date.now() + COMMAND_REGISTRY_LOCK_TIMEOUT_MS
    const ownerToken = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    while (true) {
      try {
        mkdirSync(this.lockDir, { mode: 0o700 })
        try {
          writeFileSync(join(this.lockDir, "owner"), ownerToken, { mode: 0o600 })
        } catch (err) {
          rmSync(this.lockDir, { recursive: true, force: true })
          throw err
        }
        break
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== "EEXIST") throw err

        if (this.isStaleLock()) {
          try {
            rmSync(this.lockDir, { recursive: true, force: true })
            continue
          } catch {}
        }

        if (Date.now() >= deadline) {
          throw new Error("Timed out waiting for command registry lock")
        }
        sleepSync(COMMAND_REGISTRY_LOCK_RETRY_MS)
      }
    }

    try {
      return fn()
    } finally {
      if (this.ownsLock(ownerToken)) {
        rmSync(this.lockDir, { recursive: true, force: true })
      }
    }
  }

  private isStaleLock(): boolean {
    try {
      return Date.now() - statSync(this.lockDir).mtimeMs > COMMAND_REGISTRY_STALE_LOCK_MS
    } catch {
      return false
    }
  }

  private ownsLock(ownerToken: string): boolean {
    try {
      return readFileSync(join(this.lockDir, "owner"), "utf8") === ownerToken
    } catch {
      return false
    }
  }

  private normalizeEntry(raw: Record<string, unknown>): RegisteredCommand {
    const project = normalizeString(raw.project)
    const name = normalizeString(raw.name)
    const command = normalizeString(raw.command)
    if (!project) throw new Error("Command project is required")
    if (!name) throw new Error("Command name is required")
    if (!command) throw new Error("Command command is required")

    const rawExecution = (raw.execution && typeof raw.execution === "object") ? raw.execution as Record<string, unknown> : {}
    const mode = normalizeMode(rawExecution.mode ?? raw.mode)
    const intent = normalizeString(rawExecution.intent) as TaskIntent | undefined
    const cost = normalizeString(rawExecution.cost) as TaskCost | undefined
    const now = Date.now()

    return {
      schemaVersion: COMMAND_REGISTRY_SCHEMA_VERSION,
      project,
      name,
      description: normalizeString(raw.description),
      command,
      cwd: normalizeString(raw.cwd),
      execution: {
        mode,
        intent: intent ?? inferIntent(mode, command),
        cost: cost ?? defaultCost(mode),
      },
      log: { mode: "managed" },
      createdAt: typeof raw.createdAt === "number" ? raw.createdAt : now,
      updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : now,
    }
  }
}
