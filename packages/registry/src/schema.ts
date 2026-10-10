/**
 * The MCP registry: its response types, and the pure transforms over them.
 *
 * This lives in a shared package because the desktop app and the weekly worker
 * both need it, and a second copy would drift. Two bugs in here were expensive
 * to find and would certainly be reintroduced by a clean-room rewrite:
 *
 *   - `MAX_PAGES` is a runaway guard, not a budget. Any cap near the real
 *     catalogue size truncates it *alphabetically*, silently dropping whole
 *     namespaces — `io.github.*`, which is most of the real servers, included.
 *     Hitting it is an error to report, never a normal finish.
 *   - `categorize` reads the local name only. Every `io.github.*` entry
 *     contains the word "github", so including the namespace put 18,528 of
 *     27,213 entries into "developer tools".
 *
 * Nothing here touches a database, a filesystem or Electron. It is pure over
 * `fetch`, which is what makes it testable and shareable.
 */

export const REGISTRY_BASE = 'https://registry.modelcontextprotocol.io'

export type PackageRegistryType = 'npm' | 'pypi' | 'oci' | 'nuget' | 'mcpb' | string
export type RemoteTransportType = 'streamable-http' | 'sse' | string

export interface RegistryEnvVar {
  name: string
  description?: string
  isRequired?: boolean
  isSecret?: boolean
  format?: string
  default?: string
  value?: string
}

export interface RegistryArgument {
  type?: 'positional' | 'named'
  name?: string
  value?: string
  valueHint?: string
  description?: string
  isRequired?: boolean
  isRepeated?: boolean
}

export interface RegistryPackage {
  registryType: PackageRegistryType
  registryBaseUrl?: string
  identifier: string
  version?: string
  runtimeHint?: string
  transport?: { type?: string }
  environmentVariables?: RegistryEnvVar[]
  runtimeArguments?: RegistryArgument[]
  packageArguments?: RegistryArgument[]
}

export interface RegistryRemote {
  type: RemoteTransportType
  url: string
  headers?: RegistryEnvVar[]
}

export interface RegistryIcon {
  src: string
  mimeType?: string
  sizes?: string[]
  theme?: string
}

export interface RegistryServer {
  $schema?: string
  /** Namespaced, e.g. `io.github.owner/name`. Ownership is registry-verified. */
  name: string
  title?: string
  description?: string
  version?: string
  websiteUrl?: string
  repository?: { url?: string; source?: string; id?: string; subfolder?: string }
  packages?: RegistryPackage[]
  remotes?: RegistryRemote[]
  icons?: RegistryIcon[]
}

export interface RegistryOfficialMeta {
  status?: 'active' | 'deprecated' | 'deleted' | string
  statusChangedAt?: string
  publishedAt?: string
  updatedAt?: string
  isLatest?: boolean
}

export interface RegistryEntry {
  server: RegistryServer
  _meta?: {
    'io.modelcontextprotocol.registry/official'?: RegistryOfficialMeta
  }
}

export interface RegistryListResponse {
  servers: RegistryEntry[]
  metadata?: { nextCursor?: string; count?: number }
}

export const officialMeta = (entry: RegistryEntry): RegistryOfficialMeta =>
  entry._meta?.['io.modelcontextprotocol.registry/official'] ?? {}


/**
 * The registry has no category field, so categories are inferred from the name
 * and description. Presented as a filter, never as authoritative metadata.
 */
const CATEGORY_RULES: Array<{ id: string; label: string; re: RegExp }> = [
  { id: 'dev', label: 'Developer tools', re: /\b(git|github|gitlab|ci\/cd|jenkins|docker|kubernetes|k8s|terraform|lint|debug|compiler|npm|package)\b/i },
  { id: 'data', label: 'Databases & data', re: /\b(sql|postgres|mysql|sqlite|mongo|redis|clickhouse|snowflake|bigquery|database|warehouse|duckdb|vector)\b/i },
  { id: 'productivity', label: 'Productivity', re: /\b(notion|trello|asana|jira|linear|todo|task|calendar|note|obsidian|monday|clickup|airtable)\b/i },
  { id: 'comms', label: 'Communication', re: /\b(slack|discord|telegram|whatsapp|email|gmail|outlook|teams|sms|twilio|matrix)\b/i },
  { id: 'files', label: 'Files & storage', re: /\b(file|filesystem|s3|drive|dropbox|box|storage|bucket|pdf|spreadsheet|excel|csv)\b/i },
  { id: 'web', label: 'Web & search', re: /\b(browser|scrape|crawl|puppeteer|playwright|search|fetch|http|web|serp|brave|google)\b/i },
  { id: 'cloud', label: 'Cloud & infra', re: /\b(aws|azure|gcp|cloudflare|vercel|netlify|heroku|digitalocean|monitor|observability|grafana|sentry)\b/i },
  { id: 'ai', label: 'AI & models', re: /\b(llm|embedding|openai|anthropic|hugging ?face|replicate|image gen|stable diffusion|transcri|whisper|vision)\b/i },
  { id: 'business', label: 'Business & CRM', re: /\b(salesforce|hubspot|stripe|shopify|quickbooks|invoice|payment|crm|billing|zendesk|intercom)\b/i },
  { id: 'design', label: 'Design & media', re: /\b(figma|canva|blender|image|video|audio|photo|render|3d|design)\b/i }
]

export const CATEGORIES = CATEGORY_RULES.map(({ id, label }) => ({ id, label }))

/**
 * Categorises on the server's own name plus its description, deliberately
 * excluding the namespace: every `io.github.*` entry contains "github", which
 * would otherwise drop two thirds of the registry into "developer tools".
 */
export function categorize(name: string, description: string): string[] {
  const localName = name.includes('/') ? name.slice(name.indexOf('/') + 1) : name
  const haystack = `${localName} ${description}`
  const hits = CATEGORY_RULES.filter((r) => r.re.test(haystack)).map((r) => r.id)
  return hits.length > 0 ? hits : ['other']
}

/**
 * Prefers a raster icon: SVG is scalable but is also executable markup, and a
 * cache that never has to reason about embedded script is a simpler thing to
 * trust. Falls back to SVG only when nothing else is offered.
 */
export function pickIcon(icons: RegistryIcon[] | undefined): string | null {
  if (!icons || icons.length === 0) return null
  const raster = icons.find((i) => i.mimeType && i.mimeType !== 'image/svg+xml' && i.src)
  return (raster ?? icons.find((i) => i.src))?.src ?? null
}

/**
 * A human-readable name for an entry.
 *
 * Many first-party publishers name the server itself just `mcp` — Notion,
 * Stripe, PayPal, Wix and Cloudflare all publish `<vendor>/mcp` with no title —
 * so falling back to the last path segment renders a front page of rows all
 * called "mcp". The vendor's identity is in the namespace, so read it from
 * there instead.
 */
const GENERIC_TITLES = /^(mcp|mcp[-_]server|server|mcp[-_]?api|api|main|index)$/i
const NAMESPACE_NOISE = /^(mcp|server|api|cloud|app|labs|inc|io)$/i

export function displayTitle(name: string, title?: string): string {
  const given = (title ?? '').trim()
  const segment = name.includes('/') ? name.slice(name.indexOf('/') + 1) : name

  if (given && !GENERIC_TITLES.test(given)) return given
  if (segment && !GENERIC_TITLES.test(segment)) return segment

  // Reverse-DNS namespace: first label is the TLD, trailing noise is padding.
  const namespace = name.includes('/') ? name.slice(0, name.indexOf('/')) : name
  const labels = namespace.split('.').filter(Boolean).slice(1)
  while (labels.length > 1 && NAMESPACE_NOISE.test(labels[labels.length - 1]!)) labels.pop()
  const vendor = labels[labels.length - 1]

  if (!vendor) return given || segment || name
  return vendor.charAt(0).toUpperCase() + vendor.slice(1)
}

export type ServerKind = 'stdio' | 'remote' | 'both' | 'none'

export function kindOf(server: RegistryServer): ServerKind {
  const hasPkg = (server.packages?.length ?? 0) > 0
  const hasRemote = (server.remotes?.length ?? 0) > 0
  if (hasPkg && hasRemote) return 'both'
  if (hasPkg) return 'stdio'
  if (hasRemote) return 'remote'
  return 'none'
}

