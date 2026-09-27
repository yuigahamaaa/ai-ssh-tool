import type { TaskIntent, TaskCost, CommandClassification } from "./types.js"

interface ClassifierOptions {
  intent?: TaskIntent
  cost?: TaskCost
  force?: boolean
}

interface Rule {
  pattern: RegExp
  intent: TaskIntent
  cost: TaskCost
  blocking: boolean
  mutates: boolean
  risky: boolean
}

const rules: Rule[] = [
  { pattern: /^(sudo\s+)?(ls|pwd|cat|head|tail|file|stat|uname|whoami|id|date|wc|diff|sed\s+-n|echo)\b/, intent: "inspect", cost: "tiny", blocking: false, mutates: false, risky: false },
  { pattern: /^(sudo\s+)?(rg|grep|find|which|whereis|locate)\b/, intent: "search", cost: "tiny", blocking: false, mutates: false, risky: false },
  { pattern: /^(python|python3|py|python2)\s+.*\.py(?:\s|$)/, intent: "custom", cost: "large", blocking: true, mutates: true, risky: false },
  { pattern: /^(bash|sh|zsh|dash)\s+.*\.(sh|bash|zsh)(?:\s|$)/, intent: "custom", cost: "large", blocking: true, mutates: true, risky: false },
  { pattern: /^node\s+.*\.(js|mjs|cjs|ts)(?:\s|$)/, intent: "custom", cost: "large", blocking: true, mutates: true, risky: false },
  { pattern: /^\.\/.*\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl)(?:\s|$)/, intent: "custom", cost: "large", blocking: true, mutates: true, risky: false },
  { pattern: /^(ruby|rb)\s+.*\.rb(?:\s|$)/, intent: "custom", cost: "large", blocking: true, mutates: true, risky: false },
  { pattern: /^(perl|pl)\s+.*\.pl(?:\s|$)/, intent: "custom", cost: "large", blocking: true, mutates: true, risky: false },
  { pattern: /^(go|rustc|javac|gradle|maven)\s+(?!test)/, intent: "build", cost: "large", blocking: true, mutates: false, risky: false },
  { pattern: /^(npm|pnpm|yarn)\s+test\b/, intent: "test", cost: "large", blocking: true, mutates: false, risky: false },
  { pattern: /^(pytest|go\s+test|cargo\s+test|make\s+test|jest|vitest)\b/, intent: "test", cost: "large", blocking: true, mutates: false, risky: false },
  { pattern: /^(npm|pnpm|yarn)\s+run\s+(build|compile)\b/, intent: "build", cost: "large", blocking: true, mutates: false, risky: false },
  { pattern: /^(cargo\s+build|make\s+build|go\s+build|tsc|cmake\s+--build)\b/, intent: "build", cost: "large", blocking: true, mutates: false, risky: false },
  { pattern: /^(npm|pnpm|yarn)\s+install\b/, intent: "install", cost: "large", blocking: true, mutates: true, risky: false },
  { pattern: /^(pip\s+install|pip3\s+install|cargo\s+install|apt\s+install|apt-get\s+install|brew\s+install)\b/, intent: "install", cost: "large", blocking: true, mutates: true, risky: false },
  { pattern: /^(npm|pnpm|yarn)\s+run\s+dev\b/, intent: "server", cost: "large", blocking: true, mutates: false, risky: false },
  { pattern: /^(npm\s+start|docker\s+compose\s+up|docker\s+run)\b/, intent: "server", cost: "large", blocking: true, mutates: false, risky: false },
  { pattern: /^(kubectl\s+apply|terraform\s+apply|ansible-playbook)\b/, intent: "deploy", cost: "exclusive", blocking: true, mutates: true, risky: true },
  { pattern: /^(prisma\s+migrate|flyway\s+migrate|knex\s+migrate|sequelize\s+db:migrate)\b/, intent: "migration", cost: "exclusive", blocking: true, mutates: true, risky: true },
  { pattern: /^(rm\s+-rf|dropdb|truncate|systemctl\s+(restart|stop)|kill\s+-9)\b/, intent: "cleanup", cost: "exclusive", blocking: true, mutates: true, risky: true },
]

const intentToDefaultCost: Record<string, TaskCost> = {
  inspect: "tiny",
  search: "tiny",
  test: "large",
  build: "large",
  install: "large",
  server: "large",
  deploy: "exclusive",
  migration: "exclusive",
  cleanup: "exclusive",
  custom: "medium",
}

export function classifyCommand(command: string, opts?: ClassifierOptions): CommandClassification {
  const trimmed = command.trim()

  // A compound command must be classified from every top-level segment. The
  // old first-match walk let a harmless prefix such as `echo ok;` hide a
  // destructive suffix. Keep the strongest policy requirement for the whole
  // shell invocation so scheduler confirmation and locks cannot be bypassed
  // with `;`, `&&`, `||`, pipelines, or newlines.
  const segments = splitTopLevelCommands(trimmed).map((part) => part.trim()).filter(Boolean)
  if (segments.length > 1) {
    const segmentRules = segments.map(findRule)
    if (segmentRules.some((rule, index) => rule === undefined && !isNeutralShellSegment(segments[index]!))) {
      return buildCompoundFallback(opts)
    }
    const matchedRules = segmentRules.filter((rule): rule is Rule => rule !== undefined)
    const strongest = matchedRules.sort(compareRules).at(-1)
    if (strongest) return buildResult(strongest, opts)

    // A compound command that the parser cannot identify is deliberately
    // conservative: it may contain redirection, command substitution, or a
    // shell construct outside our small rule table.
    return buildCompoundFallback(opts)
  }

  const rule = findRule(trimmed)
  if (rule) return buildResult(rule, opts)

  return {
    intent: opts?.intent ?? "custom",
    cost: opts?.cost ?? "medium",
    blocking: true,
    mutates: false,
    risky: false,
    source: opts?.intent || opts?.cost ? "agent" : "default",
    reason: opts?.intent || opts?.cost
      ? "Agent-provided classification for unrecognized command."
      : "Command not recognized; defaulting to medium/custom.",
  }
}

function isNeutralShellSegment(command: string): boolean {
  const trimmed = command.trim()
  return /^(?:cd|export|unset|true|:)\b/.test(trimmed) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(trimmed)
}

function findRule(command: string): Rule | undefined {
  for (const candidate of commandCandidates(command)) {
    for (const rule of rules) {
      if (rule.pattern.test(candidate)) return rule
    }
  }
  return undefined
}

function buildCompoundFallback(opts?: ClassifierOptions): CommandClassification {
  const requestedCost = opts?.cost
  const finalCost = requestedCost && costRank(requestedCost) >= costRank("large") ? requestedCost : "large"
  return {
    intent: opts?.intent ?? "custom",
    cost: finalCost,
    blocking: true,
    mutates: true,
    risky: true,
    source: opts?.intent || opts?.cost ? "agent_overridden_by_policy" : "default",
    reason: "Compound command could not be classified safely; policy requires confirmation before execution.",
  }
}

function compareRules(left: Rule, right: Rule): number {
  const leftScore = Number(left.risky) * 100 + costRank(left.cost) * 10 + Number(left.mutates) * 2 + Number(left.blocking)
  const rightScore = Number(right.risky) * 100 + costRank(right.cost) * 10 + Number(right.mutates) * 2 + Number(right.blocking)
  return leftScore - rightScore
}

function commandCandidates(command: string): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  const queue = [command]

  while (queue.length > 0 && result.length < 64) {
    const current = normalizeCandidate(queue.shift() ?? "")
    if (!current || seen.has(current)) continue

    seen.add(current)
    result.push(current)

    for (const part of splitTopLevelCommands(current)) {
      const normalized = normalizeCandidate(part)
      if (normalized && !seen.has(normalized)) queue.push(normalized)
    }

    const unwrapped = unwrapOnce(current)
    if (unwrapped && !seen.has(unwrapped)) queue.push(unwrapped)
  }

  return result
}

function normalizeCandidate(command: string): string {
  return stripOuterQuotes(command.trim())
}

function unwrapOnce(command: string): string | undefined {
  const patterns: RegExp[] = [
    /^cd\s+(?:"[^"]+"|'[^']+'|\S+)\s*(?:&&|;)\s*(.+)$/s,
    /^sudo\s+(?:-\S+\s+)*(?:--\s+)?(.+)$/s,
    /^env\s+(?:-\S+\s+)*(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)+(.+)$/s,
    /^timeout\s+(?:-\S+\s+)*(?:\d+[smhd]?|[0-9.]+)\s+(.+)$/s,
    /^time\s+(?:-\S+\s+)*(.+)$/s,
    /^nice\s+(?:-\S+\s+)*(.+)$/s,
    /^nohup\s+(.+)$/s,
    /^stdbuf\s+(?:-\S+\s+)+(.+)$/s,
    /^(?:bash|sh|zsh|dash)\s+-[A-Za-z]*c\s+(.+)$/s,
    /^(?:bash|sh|zsh|dash)\s+-[A-Za-z]*e\s+(.+)$/s,
    /^npx\s+(?:--yes\s+|-y\s+)?(.+)$/s,
    /^(?:npm|pnpm|yarn)\s+exec\s+(.+)$/s,
    /^(?:uv|poetry)\s+run\s+(.+)$/s,
  ]

  for (const pattern of patterns) {
    const match = command.match(pattern)
    if (match?.[1]) return normalizeCandidate(match[1])
  }

  return undefined
}

function stripOuterQuotes(value: string): string {
  if (value.length < 2) return value
  const first = value[0]
  const last = value[value.length - 1]
  if ((first === `"` && last === `"`) || (first === `'` && last === `'`)) {
    return value.slice(1, -1).trim()
  }
  return value
}

function splitTopLevelCommands(command: string): string[] {
  const parts: string[] = []
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
    if (ch === "\n" || ch === ";" || ch === "|") {
      parts.push(command.slice(start, i))
      if (ch === "|") {
        if (command[i + 1] === ch) i++
      }
      start = i + 1
    } else if (ch === "&" && command[i + 1] === "&") {
      parts.push(command.slice(start, i))
      i++
      start = i + 1
    }
  }

  if (start > 0) parts.push(command.slice(start))
  return parts
}

function buildResult(rule: Rule, opts?: ClassifierOptions): CommandClassification {
  let finalCost = opts?.cost ?? rule.cost
  let source: CommandClassification["source"] = opts?.intent || opts?.cost ? "agent" : "auto"

  const minCost = rule.cost
  if (costRank(finalCost) < costRank(minCost)) {
    finalCost = minCost
    source = "agent_overridden_by_policy"
  }

  return {
    intent: opts?.intent ?? rule.intent,
    cost: finalCost,
    blocking: rule.blocking,
    mutates: rule.mutates,
    risky: rule.risky,
    source,
    reason: source === "agent_overridden_by_policy"
      ? "Agent requested cost=" + opts?.cost + " but policy requires at least " + minCost + " for this command."
      : "Classified as " + rule.intent + "/" + rule.cost + " by " + source + ".",
  }
}

function costRank(cost: TaskCost): number {
  switch (cost) {
    case "tiny": return 0
    case "small": return 1
    case "medium": return 2
    case "large": return 3
    case "exclusive": return 4
  }
}
