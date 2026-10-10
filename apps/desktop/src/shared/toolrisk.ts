/**
 * Classifies what a tool can *do* from its name and description, so the tool
 * inventory can be read at a glance before any call has ever been made.
 *
 * This is a heuristic over a naming convention, not a capability proof — MCP
 * gives no machine-readable "this tool writes" signal, so a server is free to
 * name a destructive tool `get_things`. Treat it as triage, not a guarantee.
 */
export type ToolCapability = 'execute' | 'destructive' | 'write' | 'read' | 'unknown'

export interface CapabilityInfo {
  capability: ToolCapability
  label: string
  /** Ranked for sorting and for colouring: higher is more dangerous. */
  weight: number
}

const RULES: Array<{ capability: ToolCapability; re: RegExp }> = [
  { capability: 'execute', re: /\b(exec|execute|shell|bash|terminal|command|run_code|eval|spawn|script|sql|query_raw)\b/i },
  { capability: 'destructive', re: /\b(delete|remove|destroy|drop|purge|truncate|wipe|erase|revoke|close|archive|cancel)\b/i },
  { capability: 'write', re: /\b(create|write|update|insert|add|set|put|patch|upload|send|post|publish|move|rename|assign|invite|comment|reply|merge|apply)\b/i },
  { capability: 'read', re: /\b(get|read|list|search|find|fetch|query|view|show|describe|lookup|check|count|export|download)\b/i }
]

const LABELS: Record<ToolCapability, string> = {
  execute: 'Executes code',
  destructive: 'Destructive',
  write: 'Writes data',
  read: 'Read-only',
  unknown: 'Unclassified'
}

const WEIGHTS: Record<ToolCapability, number> = {
  execute: 4,
  destructive: 3,
  write: 2,
  read: 1,
  unknown: 0
}

/**
 * Splits an identifier into space-separated words so word-boundary matching
 * works. `\b` treats `_` as a word character, so `\bshell\b` would never match
 * `run_shell_command` without this step; camelCase needs the same treatment.
 */
export function tokenizeName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.:/]+/g, ' ')
    .toLowerCase()
    .trim()
}

/**
 * The tool *name* decides. A description is only consulted when the name says
 * nothing, because descriptions routinely mention verbs they do not perform
 * ("list the cards you created").
 */
export function classifyTool(name: string, description = ''): CapabilityInfo {
  const words = tokenizeName(name)
  const match = RULES.find((r) => r.re.test(words)) ?? RULES.find((r) => r.re.test(description))
  const capability = match?.capability ?? 'unknown'
  return { capability, label: LABELS[capability], weight: WEIGHTS[capability] }
}

/**
 * Rough context cost of one tool definition. Every tool a server exposes is
 * serialised into the model's context on every request, whether or not it is
 * ever called — this is the number that makes tool sprawl visible.
 */
export function estimateToolTokens(tool: { name: string; description?: string; schema?: unknown }): number {
  const schema = tool.schema === null || tool.schema === undefined ? '' : JSON.stringify(tool.schema)
  return Math.ceil((tool.name.length + (tool.description ?? '').length + schema.length) / 4)
}

export function summarizeInventory(
  tools: Array<{ name: string; description?: string; schema?: unknown }>
): {
  total: number
  tokens: number
  byCapability: Record<ToolCapability, number>
  riskyCount: number
} {
  const byCapability: Record<ToolCapability, number> = {
    execute: 0,
    destructive: 0,
    write: 0,
    read: 0,
    unknown: 0
  }
  let tokens = 0
  for (const tool of tools) {
    byCapability[classifyTool(tool.name, tool.description).capability]++
    tokens += estimateToolTokens(tool)
  }
  return {
    total: tools.length,
    tokens,
    byCapability,
    riskyCount: byCapability.execute + byCapability.destructive + byCapability.write
  }
}
