/**
 * Reads and rewrites MCP server rows in a DeepSeek Harness patch file.
 *
 * dsh has no `mcpServers` map. Each server is a Cordis row naming
 * `@deepseek-ai/dsh-mcp-client`, usually inside an `- insert:` list in
 * `$DSH_HOME/cordis.patch.yml`, and its values may be `!!js` expressions that
 * dsh evaluates at boot (`env: { TOKEN: !!js process.env.GITHUB_TOKEN }`).
 *
 * Bridge cannot evaluate those, so it never copies them out. Wrapping swaps
 * only `transport`, `command` and `args` and leaves `env` and `cwd` where they
 * are: dsh still computes them and hands them to the proxy, and the proxy's
 * child inherits both. Headers on a remote server are the one value the proxy
 * needs by name, so they move into `env` as `BRIDGE_HEADER__<name>` and the
 * proxy reads them back. The original config node is returned as YAML text so
 * an uninstall can put back exactly what was there, tags and all.
 *
 * Everything here is a pure function over file text, using the Document API so
 * the user's comments and unrelated rows survive a rewrite.
 */
import { Document, isMap, isScalar, isSeq, parseDocument, YAMLMap, YAMLSeq, type Node } from 'yaml'

export const DSH_MCP_PACKAGE = '@deepseek-ai/dsh-mcp-client'

/** Prefix for headers carried through the proxy's environment. */
export const HEADER_ENV_PREFIX = 'BRIDGE_HEADER__'

/** dsh rejects any other server name at load time. */
const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/

export interface DshEntry {
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  /** Values dsh computes at boot, which Bridge leaves to dsh. */
  computed: string[]
}

/** The stanza Bridge writes, the same shape every client gets. */
export interface ProxyStanza {
  command: string
  args: string[]
  env: Record<string, string>
}

function parse(text: string): Document {
  const doc = parseDocument(text, { keepSourceTokens: false })
  if (doc.errors.length > 0) throw new Error(`invalid YAML: ${doc.errors[0]?.message ?? 'parse error'}`)
  const root = doc.contents
  if (root !== null && !isSeq(root)) throw new Error('expected a top-level YAML list of patch entries')
  return doc
}

/** A scalar dsh will compute, rather than a literal Bridge can read. */
function isComputed(node: unknown): boolean {
  return isScalar(node) && typeof node.tag === 'string' && node.tag.endsWith(':js')
}

function literal(node: unknown): string | undefined {
  if (!isScalar(node) || isComputed(node)) return undefined
  return node.value === null || node.value === undefined ? undefined : String(node.value)
}

function rows(doc: Document): YAMLMap[] {
  const out: YAMLMap[] = []
  const root = doc.contents
  if (!isSeq(root)) return out
  for (const item of root.items) {
    if (!isMap(item)) continue
    const insert = item.get('insert', true)
    if (isSeq(insert)) {
      for (const row of insert.items) if (isMap(row)) out.push(row)
    } else {
      out.push(item)
    }
  }
  return out
}

function serverRows(doc: Document): Array<{ name: string; row: YAMLMap; config: YAMLMap }> {
  const out: Array<{ name: string; row: YAMLMap; config: YAMLMap }> = []
  for (const row of rows(doc)) {
    if (literal(row.get('name', true)) !== DSH_MCP_PACKAGE) continue
    const config = row.get('config', true)
    if (!isMap(config)) continue
    const name = literal(config.get('serverName', true))
    if (name) out.push({ name, row, config })
  }
  return out
}

function readMap(node: unknown, key: string, computed: string[]): Record<string, string> | undefined {
  if (!isMap(node)) return undefined
  const out: Record<string, string> = {}
  for (const pair of node.items) {
    const name = isScalar(pair.key) ? String(pair.key.value) : null
    if (!name) continue
    const value = literal(pair.value)
    if (value === undefined) {
      if (isComputed(pair.value)) computed.push(`${key}.${name}`)
      continue
    }
    out[name] = value
  }
  return out
}

function toEntry(config: YAMLMap): DshEntry {
  const computed: string[] = []
  const transport = literal(config.get('transport', true))
  const entry: DshEntry = { computed }
  if (transport === 'streamable-http') {
    entry.url = literal(config.get('url', true))
    entry.headers = readMap(config.get('headers', true), 'headers', computed)
    return entry
  }
  entry.command = literal(config.get('command', true))
  const args = config.get('args', true)
  entry.args = isSeq(args) ? args.items.map((a) => literal(a) ?? '').filter(Boolean) : []
  entry.env = readMap(config.get('env', true), 'env', computed)
  const cwd = config.get('cwd', true)
  if (isComputed(cwd)) computed.push('cwd')
  else entry.cwd = literal(cwd)
  return entry
}

/** Every MCP server declared in a dsh patch file, keyed by `serverName`. */
export function dshServers(text: string): Record<string, DshEntry> {
  const out: Record<string, DshEntry> = {}
  for (const { name, config } of serverRows(parse(text))) out[name] = toEntry(config)
  return out
}

function insertList(doc: Document): YAMLSeq {
  let root = doc.contents
  if (!isSeq(root)) {
    root = new YAMLSeq()
    doc.contents = root as never
  }
  for (const item of (root as YAMLSeq).items) {
    if (!isMap(item)) continue
    const insert = item.get('insert', true)
    if (isSeq(insert)) return insert
  }
  const block = new YAMLMap()
  const list = new YAMLSeq()
  block.set('insert', list)
  ;(root as YAMLSeq).items.push(block)
  return list
}

/**
 * Points `name` at the Bridge proxy, creating the row if dsh does not have it.
 * Returns the new text and, when the row was not already ours, the original
 * config node as YAML so an uninstall can restore it verbatim.
 */
export function wrapDshServer(
  text: string,
  name: string,
  stanza: ProxyStanza,
  isOurs: (args: string[]) => boolean
): { text: string; original: string | null } {
  if (!SERVER_NAME.test(name)) {
    throw new Error(
      `dsh server names may only use letters, digits, "-" and "_" (at most 32 characters); "${name}" is not one. Rename the server and try again.`
    )
  }
  const doc = parse(text)
  const found = serverRows(doc).find((r) => r.name === name)

  let config: YAMLMap
  let original: string | null = null
  if (found) {
    config = found.config
    const current = toEntry(config)
    if (!(current.command && isOurs(current.args ?? []))) {
      const snapshot = new Document()
      snapshot.contents = config.clone() as never
      original = snapshot.toString()
    }
  } else {
    config = new YAMLMap()
    config.set('serverName', name)
    const row = new YAMLMap()
    row.set('id', `bridge-${name}`)
    row.set('name', DSH_MCP_PACKAGE)
    row.set('config', config)
    insertList(doc).items.push(row)
  }

  // Headers become environment so computed ones stay computed.
  const existingEnv = config.get('env', true)
  const env: YAMLMap = isMap(existingEnv) ? existingEnv : new YAMLMap()
  if (!isMap(existingEnv)) config.set('env', env)
  const headers = config.get('headers', true)
  if (isMap(headers)) {
    for (const pair of headers.items) {
      if (!isScalar(pair.key)) continue
      env.set(`${HEADER_ENV_PREFIX}${String(pair.key.value)}`, pair.value as Node)
    }
  }
  config.delete('headers')
  config.delete('url')

  config.set('transport', 'stdio')
  config.set('command', stanza.command)
  config.set('args', doc.createNode(stanza.args))
  for (const [key, value] of Object.entries(stanza.env)) env.set(key, value)

  return { text: doc.toString(), original }
}

/**
 * Puts a row back the way it was. `original` is what `wrapDshServer` returned;
 * without it, `fallback` rebuilds a plain row from what Bridge recorded.
 */
export function restoreDshServer(
  text: string,
  name: string,
  original: string | null,
  fallback: { command?: string; args?: string[]; env?: Record<string, string>; cwd?: string; url?: string; headers?: Record<string, string> }
): string {
  const doc = parse(text)
  const found = serverRows(doc).find((r) => r.name === name)
  if (!found) return text

  let restored: Node
  if (original) {
    const parsed = parseDocument(original)
    if (parsed.errors.length > 0 || !isMap(parsed.contents)) throw new Error('saved dsh config is unreadable')
    restored = parsed.contents
  } else {
    restored = doc.createNode(
      fallback.url
        ? { serverName: name, transport: 'streamable-http', url: fallback.url, ...(fallback.headers ? { headers: fallback.headers } : {}) }
        : {
            serverName: name,
            transport: 'stdio',
            command: fallback.command,
            args: fallback.args ?? [],
            ...(fallback.env ? { env: fallback.env } : {}),
            ...(fallback.cwd ? { cwd: fallback.cwd } : {})
          }
    )
  }
  found.row.set('config', restored)
  return doc.toString()
}

/** True when the row already says what Bridge would write. */
export function dshEntryCurrent(entry: DshEntry | undefined, stanza: ProxyStanza): boolean {
  if (!entry || entry.command !== stanza.command) return false
  if (JSON.stringify(entry.args ?? []) !== JSON.stringify(stanza.args)) return false
  return Object.entries(stanza.env).every(([k, v]) => entry.env?.[k] === v)
}

/** Headers handed to the proxy through `BRIDGE_HEADER__*` variables. */
export function headersFromEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith(HEADER_ENV_PREFIX) && typeof value === 'string') out[key.slice(HEADER_ENV_PREFIX.length)] = value
  }
  return out
}
