export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function splitTopLevelSemicolonCommands(command: string): string[] {
  const commands: string[] = []
  let start = 0
  let quote: `"` | `'` | null = null
  let escaped = false

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === "\\") {
      escaped = true
      continue
    }
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === `"` || ch === `'`) {
      quote = ch
      continue
    }
    if (ch === ";") {
      const part = command.slice(start, i).trim()
      if (part) commands.push(part)
      start = i + 1
    }
  }

  const tail = command.slice(start).trim()
  if (tail) commands.push(tail)
  return commands
}

export function assertOctalMode(mode: string): string {
  if (!/^[0-7]{3,4}$/.test(mode)) {
    throw new Error(`Invalid file mode: ${mode}. Expected 3 or 4 octal digits.`)
  }
  return mode
}

export function assertEnvName(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid environment variable name: ${name}`)
  }
  return name
}
