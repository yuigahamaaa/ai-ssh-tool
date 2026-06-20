export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
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
