import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { bridgeHome } from '@shared/control'
import type { ClientId, ManagedServer, UpstreamTarget } from '@shared/types'
import type { ConfigHealth } from '@shared/ipc'
import { ensurePrivateDir, writeFileAtomic, writePrivateFile } from '@shared/private-fs'
import { dshEntryCurrent, dshServers, restoreDshServer, wrapDshServer } from '@shared/dsh-config'

export interface ClientDefinition {
  id: ClientId
  label: string
  configPath: string
  /**
   * `json` files hold a server map under `key`: Claude/Cursor use `mcpServers`,
   * VS Code `servers`. `dsh` is DeepSeek Harness's YAML patch file, where each
   * server is a Cordis row (see shared/dsh-config).
   */
  format: 'json' | 'dsh'
  key: 'mcpServers' | 'servers'
}

/** DeepSeek Harness home; the patch file there applies to every profile. */
function dshHome(): string {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

const APPDATA = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')

export function knownClients(): ClientDefinition[] {
  const home = homedir()
  const mac = process.platform === 'darwin'
  const win = process.platform === 'win32'

  const claude = mac
    ? join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
    : win
      ? join(APPDATA, 'Claude', 'claude_desktop_config.json')
      : join(home, '.config', 'Claude', 'claude_desktop_config.json')

  const vscode = mac
    ? join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json')
    : win
      ? join(APPDATA, 'Code', 'User', 'mcp.json')
      : join(home, '.config', 'Code', 'User', 'mcp.json')

  return [
    { id: 'claude-desktop', label: 'Claude Desktop', configPath: claude, format: 'json', key: 'mcpServers' },
    { id: 'claude-code', label: 'Claude Code', configPath: join(home, '.claude.json'), format: 'json', key: 'mcpServers' },
    { id: 'cursor', label: 'Cursor', configPath: join(home, '.cursor', 'mcp.json'), format: 'json', key: 'mcpServers' },
    { id: 'windsurf', label: 'Windsurf', configPath: join(home, '.codeium', 'windsurf', 'mcp_config.json'), format: 'json', key: 'mcpServers' },
    { id: 'vscode', label: 'VS Code (Copilot)', configPath: vscode, format: 'json', key: 'servers' },
    { id: 'dsh', label: 'DeepSeek Harness', configPath: join(dshHome(), 'cordis.patch.yml'), format: 'dsh', key: 'mcpServers' }
  ]
}

/**
 * Clients Bridge cannot wire up automatically.
 *
 * ChatGPT's desktop app has no local MCP config file: connectors are added
 * through its own UI and must be reachable over HTTP, so a locally-launched
 * stdio server cannot be registered from outside. Saying so is more useful than
 * offering a button that silently does nothing.
 */
export const MANUAL_ONLY_CLIENTS = [
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    reason:
      'ChatGPT has no local MCP config file. Connectors are added inside the app and must be remote (HTTPS), so a locally-launched server cannot be wired up from here.'
  }
]

export interface DiscoveredServer {
  client: ClientId
  clientLabel: string
  name: string
  target: UpstreamTarget
  /** True when this entry already points at the Bridge proxy. */
  wrapped: boolean
  wrappedServerId: string | null
}

type RawEntry = Record<string, any>

function readConfig(path: string, strict = false): Record<string, any> | null {
  if (!existsSync(path)) return null
  try {
    const text = readFileSync(path, 'utf8')
    const parsed = text.trim() ? JSON.parse(text) : {}
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected a JSON object')
    return parsed
  } catch {
    if (strict) throw new Error(`Cannot read valid client configuration at ${path}; the file was not changed.`)
    return null
  }
}

/**
 * The client's servers as plain entries, whatever the file format. `null`
 * means there is no readable file; `strict` turns an unreadable one into an
 * error instead, for paths that are about to write.
 */
function readEntries(def: ClientDefinition, strict = false): Record<string, RawEntry> | null {
  if (def.format === 'json') {
    const config = readConfig(def.configPath, strict)
    return config ? (config[def.key] ?? {}) : null
  }
  if (!existsSync(def.configPath)) return null
  try {
    return dshServers(readFileSync(def.configPath, 'utf8'))
  } catch (err) {
    if (strict) throw new Error(`Cannot read the dsh patch file at ${def.configPath} (${(err as Error).message}); the file was not changed.`)
    return null
  }
}

function entryToTarget(entry: RawEntry): UpstreamTarget | null {
  if (typeof entry?.url === 'string') {
    return { kind: 'http', url: entry.url, headers: entry.headers ?? undefined }
  }
  if (typeof entry?.command === 'string') {
    return {
      kind: 'stdio',
      command: entry.command,
      args: Array.isArray(entry.args) ? entry.args.map(String) : [],
      env: entry.env ?? undefined,
      cwd: typeof entry.cwd === 'string' ? entry.cwd : undefined
    }
  }
  return null
}

/** Path to the bundled proxy entry, as a real file the client can execute. */
export function proxyScriptPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'app.asar.unpacked', 'out', 'main', 'proxy.js')
  }
  return join(app.getAppPath(), 'out', 'main', 'proxy.js')
}

/** Product names this app has shipped under, for recognising our own configs. */
const PAST_NAMES = ['bridge', 'kendra', 'lantern']

/**
 * Decides whether a config stanza is one we wrote.
 *
 * The reliable signal is the proxy script path. A bare name match is not:
 * "bridge" is an ordinary word in this domain, and `npx home-assistant-bridge`
 * is somebody else's server, not ours. Claiming it would rewrite a config we
 * do not own. So the name fallback — which exists only for entries written by
 * an older build under a different name — additionally requires the `--id`
 * flag that we always write and nobody else has a reason to.
 */
function isBridgeEntry(entry: RawEntry): { wrapped: boolean; serverId: string | null } {
  const args: string[] = Array.isArray(entry?.args) ? entry.args.map(String) : []
  const idx = args.indexOf('--id')

  const byPath = args.some((a) => a.endsWith(join('out', 'main', 'proxy.js')))
  const byName =
    idx >= 0 && args.some((a) => PAST_NAMES.some((n) => a.toLowerCase().includes(n)))

  if (!byPath && !byName) return { wrapped: false, serverId: null }
  return { wrapped: true, serverId: idx >= 0 ? (args[idx + 1] ?? null) : null }
}

/* -------------------------------- gateway -------------------------------- */

/** Config key of the single entry a gateway client gets (see proxy/gateway.ts). */
export const GATEWAY_ENTRY = 'bridge'

/**
 * Clients routed through one gateway entry. Held here, set by the app from
 * settings, so every install path — connect, rename, repair at launch —
 * routes correctly without each caller having to know.
 */
let gatewayClients = new Set<ClientId>()

export function setGatewayClients(clients: readonly ClientId[]): void {
  gatewayClients = new Set(clients)
}

export function isGatewayClient(client: ClientId): boolean {
  return gatewayClients.has(client)
}

const isGatewayEntry = (entry: RawEntry): boolean =>
  Array.isArray(entry?.args) && entry.args.map(String).includes('--gateway') && isBridgeEntry(entry).wrapped

export function gatewayStanza(client: ClientId): RawEntry {
  return {
    command: process.execPath,
    args: [proxyScriptPath(), '--gateway', '--client', client],
    env: { ELECTRON_RUN_AS_NODE: '1', BRIDGE_HOME: bridgeHome() }
  }
}

export function gatewayEntryCurrent(client: ClientId): boolean {
  const def = clientFor(client)
  const existing = readEntries(def)?.[GATEWAY_ENTRY]
  return !!existing && JSON.stringify(existing) === JSON.stringify(gatewayStanza(client))
}

function directEntry(server: ManagedServer): RawEntry {
  return server.target.kind === 'http'
    ? { url: server.target.url, ...(server.target.headers ? { headers: server.target.headers } : {}) }
    : {
        command: server.target.command,
        args: server.target.args,
        ...(server.target.env ? { env: server.target.env } : {}),
        ...(server.target.cwd ? { cwd: server.target.cwd } : {})
      }
}

/**
 * Switches a client to one gateway entry, or back to one entry per server.
 *
 * On: the `bridge` entry is written and every per-server Bridge entry for the
 * client's installed servers is removed, in one write. Off: the reverse. Only
 * JSON clients: a dsh row can carry `!!js` values that would be lost if the
 * row were removed, so dsh keeps per-server rows.
 */
export function setGateway(client: ClientId, enabled: boolean, servers: readonly ManagedServer[]): void {
  const def = clientFor(client)
  if (def.format !== 'json') throw new Error(`${def.label} keeps one entry per server; the single Bridge entry is not available for it yet.`)
  const config = readConfig(def.configPath, true) ?? {}
  const entries: Record<string, RawEntry> = (config[def.key] = config[def.key] ?? {})

  if (enabled) {
    const existing = entries[GATEWAY_ENTRY]
    if (existing && !isBridgeEntry(existing).wrapped) {
      throw new Error(`${def.label} already has a server named "${GATEWAY_ENTRY}" that is not Bridge's. Rename it first.`)
    }
    entries[GATEWAY_ENTRY] = gatewayStanza(client)
    for (const server of servers) {
      const entry = entries[server.name]
      if (entry && isBridgeEntry(entry).wrapped) delete entries[server.name]
    }
  } else {
    if (entries[GATEWAY_ENTRY] && isGatewayEntry(entries[GATEWAY_ENTRY])) delete entries[GATEWAY_ENTRY]
    for (const server of servers) entries[server.name] = desiredEntry({ ...server, client })
  }
  writeConfig(def.configPath, config)
}

/** Reads every known client config and lists the MCP servers it declares. */
export function discoverServers(): DiscoveredServer[] {
  const found: DiscoveredServer[] = []
  for (const client of knownClients()) {
    const entries = readEntries(client)
    if (!entries) continue
    for (const [name, entry] of Object.entries(entries)) {
      // The gateway is not a server; coverage reports the servers behind it.
      if (isGatewayEntry(entry)) continue
      const target = entryToTarget(entry)
      if (!target) continue
      const { wrapped, serverId } = isBridgeEntry(entry)
      found.push({
        client: client.id,
        clientLabel: client.label,
        name,
        target,
        wrapped,
        wrappedServerId: serverId
      })
    }
  }
  return found
}

function backupPath(configPath: string): string {
  const dir = join(bridgeHome(), 'backups')
  ensurePrivateDir(dir)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return join(dir, `${configPath.split(/[\\/]/).pop()}.${stamp}.bak`)
}

function writeText(path: string, text: string): void {
  // The backup holds the same tokens as the config, so it is private too.
  if (existsSync(path)) writePrivateFile(backupPath(path), readFileSync(path))
  // Write-then-rename keeps a crash from leaving a half-written config behind.
  writeFileAtomic(path, text)
}

function writeConfig(path: string, config: Record<string, any>): void {
  writeText(path, JSON.stringify(config, null, 2) + '\n')
}

/**
 * Where the original dsh config node waits while Bridge has the row. Kept as
 * the YAML it was, so `!!js` values come back as expressions, not strings.
 */
function dshOriginalPath(serverId: string): string {
  return join(bridgeHome(), 'dsh-originals', `${serverId.replace(/[^A-Za-z0-9_-]/g, '_')}.yml`)
}

const isOurArgs = (args: string[]): boolean => isBridgeEntry({ args }).wrapped

function clientFor(id: ClientId): ClientDefinition {
  const def = knownClients().find((c) => c.id === id)
  if (!def) throw new Error(`Unknown client: ${id}`)
  return def
}

/**
 * Rewrites the client's config so `server.name` launches the Bridge proxy.
 * The original target stays in Bridge's database and is restored on uninstall.
 */
/** The config stanza Bridge wants for a server, in one place. */
export function desiredEntry(server: ManagedServer): RawEntry {
  return {
    command: process.execPath,
    // --name lets the proxy recover if this config outlives the id it names.
    args: [proxyScriptPath(), '--id', server.id, '--name', server.name],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      BRIDGE_HOME: bridgeHome()
    }
  }
}

/**
 * True when the client's config already says exactly what we would write.
 * Used to upgrade stanzas written by an older build without rewriting (and
 * backing up) a config file on every launch.
 */
export function configEntryCurrent(server: ManagedServer): boolean {
  const def = clientFor(server.client)
  if (isGatewayClient(server.client)) {
    const own = readEntries(def)?.[server.name]
    return gatewayEntryCurrent(server.client) && !(own && isBridgeEntry(own).wrapped)
  }
  const existing = readEntries(def)?.[server.name]
  if (def.format === 'dsh') return dshEntryCurrent(existing as never, desiredEntry(server) as never)
  if (!existing) return false
  return JSON.stringify(existing) === JSON.stringify(desiredEntry(server))
}

export function installServer(server: ManagedServer): void {
  const def = clientFor(server.client)
  if (isGatewayClient(server.client)) {
    // The gateway picks the server up at the client's next start; all the
    // config needs is the gateway entry, and no per-server one beside it.
    const config = readConfig(def.configPath, true) ?? {}
    const entries: Record<string, RawEntry> = (config[def.key] = config[def.key] ?? {})
    const own = entries[server.name]
    if (gatewayEntryCurrent(server.client) && !(own && isBridgeEntry(own).wrapped)) return
    entries[GATEWAY_ENTRY] = gatewayStanza(server.client)
    if (own && isBridgeEntry(own).wrapped) delete entries[server.name]
    writeConfig(def.configPath, config)
    return
  }
  if (def.format === 'dsh') {
    readEntries(def, true)
    const text = existsSync(def.configPath) ? readFileSync(def.configPath, 'utf8') : ''
    const result = wrapDshServer(text, server.name, desiredEntry(server) as never, isOurArgs)
    if (result.original !== null) {
      const stash = dshOriginalPath(server.id)
      ensurePrivateDir(dirname(stash))
      writePrivateFile(stash, result.original)
    }
    writeText(def.configPath, result.text)
    return
  }
  const config = readConfig(def.configPath, true) ?? {}
  config[def.key] = config[def.key] ?? {}
  config[def.key][server.name] = desiredEntry(server)
  writeConfig(def.configPath, config)
}

export function uninstallServer(server: ManagedServer): void {
  const def = clientFor(server.client)
  if (isGatewayClient(server.client)) {
    // Leaving Bridge means the client talks to the server directly again.
    const config = readConfig(def.configPath, true) ?? {}
    config[def.key] = config[def.key] ?? {}
    config[def.key][server.name] = directEntry(server)
    writeConfig(def.configPath, config)
    return
  }
  if (def.format === 'dsh') {
    if (!readEntries(def, true)?.[server.name]) return
    const stash = dshOriginalPath(server.id)
    const original = existsSync(stash) ? readFileSync(stash, 'utf8') : null
    const fallback = server.target.kind === 'http' ? { url: server.target.url, headers: server.target.headers } : server.target
    writeText(def.configPath, restoreDshServer(readFileSync(def.configPath, 'utf8'), server.name, original, fallback))
    rmSync(stash, { force: true })
    return
  }
  const config = readConfig(def.configPath, true)
  if (!config?.[def.key]?.[server.name]) return

  config[def.key][server.name] = directEntry(server)
  writeConfig(def.configPath, config)
}

export function clientStatus(): Array<
  ClientDefinition & { present: boolean; serverCount: number; configModifiedAt: number | null }
> {
  return knownClients().map((def) => {
    const entries = readEntries(def)
    let configModifiedAt: number | null = null
    try {
      configModifiedAt = existsSync(def.configPath) ? statSync(def.configPath).mtimeMs : null
    } catch {
      configModifiedAt = null
    }
    return {
      ...def,
      present: entries !== null,
      serverCount: entries ? Object.keys(entries).length : 0,
      configModifiedAt
    }
  })
}


/**
 * Checks that what we wrote into a client's config still resolves on disk.
 *
 * When Bridge runs unpackaged, the stanza points at `node_modules/electron`
 * and `out/main/proxy.js` -- both gitignored build artifacts. A dependency
 * reinstall, a clean build, or moving the project silently breaks the server,
 * and the client reports only "Server disconnected". Surfacing it here turns a
 * mystery into a sentence.
 */
export function configHealth(servers: readonly ManagedServer[]): ConfigHealth[] {
  const scriptPath = proxyScriptPath()
  const dev = !app.isPackaged

  return servers
    .filter((server) => server.installed)
    .map((server) => {
      const def = knownClients().find((c) => c.id === server.client)
      const gateway = isGatewayClient(server.client)
      const entry = def ? readEntries(def)?.[gateway ? GATEWAY_ENTRY : server.name] : undefined
      const command: string | undefined = entry?.command
      const script: string | undefined = Array.isArray(entry?.args) ? entry.args[0] : undefined

      const problems: string[] = []
      if (!entry) {
        problems.push(gateway ? 'The client config has no Bridge gateway entry.' : 'No entry for this server in the client config.')
      } else {
        if (!command || !existsSync(command)) {
          problems.push(`The command it launches no longer exists: ${command ?? '(none)'}`)
        }
        if (!script || !existsSync(script)) {
          problems.push(`The proxy script no longer exists: ${script ?? '(none)'}`)
        }
        if (script && script !== scriptPath) {
          problems.push('The entry points at a different Bridge build than the one running.')
        }
      }

      return {
        serverId: server.id,
        name: server.name,
        client: server.client,
        configPath: def?.configPath ?? '',
        dev,
        problems
      }
    })
}

/** Distinguish unreadable configs from an empty/missing setup in the coverage report. */
export function unreadableClientConfigs(): string[] {
  return knownClients().filter((client) => existsSync(client.configPath) && readEntries(client) === null).map((client) => client.label)
}
