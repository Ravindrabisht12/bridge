import { dispatchClientMessage } from './dispatch'
/**
 * Bridge proxy — the process an AI client launches instead of the real MCP
 * server. It speaks stdio to the client, forwards to the real server, and
 * records/polices everything in between.
 *
 *   bridge-proxy --id srv_abc123
 *   bridge-proxy --gateway --client claude-code
 *
 * Request inspection failures never forward or retry a call. Recording failures
 * may reduce local evidence; they do not turn a denied call into an allowed one.
 */
import { randomUUID } from 'node:crypto'
import { LineDecoder, encodeFrame, parseFrame, type JsonRpcMessage } from '@shared/jsonrpc'
import { FileLogger } from '@shared/logger'
import { headersFromEnv } from '@shared/dsh-config'
import type { ManagedServer, SessionRecord, UpstreamTarget } from '@shared/types'
import { openDatabase, type Db } from '../db'
import * as repo from '../db/repo'
import { listServerClients } from '../db/catalog'
import { probeTarget } from '../main/services/probe'
import { ControlClient } from './control-client'
import { Interceptor } from './interceptor'
import { Gateway, type MemberLink } from './gateway'
import { HttpUpstream } from './transports/http'
import { StdioUpstream } from './transports/stdio'
import type { UpstreamTransport } from './transports/types'

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg?.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      out[key] = next
      i++
    } else {
      out[key] = 'true'
    }
  }
  return out
}

function writeToClient(msg: JsonRpcMessage): void {
  process.stdout.write(encodeFrame(msg))
}

/**
 * `--probe '<target json>'` runs the MCP handshake against a target and prints
 * the result as JSON. It is how the connection test is exercised outside the
 * UI, and doubles as a diagnostic when a server will not start.
 */
async function runProbe(raw: string): Promise<never> {
  let target: UpstreamTarget
  try {
    target = JSON.parse(raw) as UpstreamTarget
  } catch (err) {
    process.stderr.write(`Bridge: --probe needs a JSON target (${(err as Error).message})\n`)
    process.exit(2)
  }
  const result = await probeTarget(target)
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  process.exit(result.ok ? 0 : 1)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  if (args.probe) {
    await runProbe(args.probe)
    return
  }
  if (args.gateway) {
    if (!args.client) {
      process.stderr.write('Bridge: --gateway needs --client <id>\n')
      process.exit(2)
    }
    await runGateway(args.client)
    return
  }
  const serverId = args.id ?? process.env.BRIDGE_SERVER_ID
  const log = new FileLogger(`proxy-${serverId ?? 'unknown'}`)

  if (!serverId) {
    log.error('missing --id; nothing to proxy')
    process.stderr.write('Bridge: missing --id argument\n')
    process.exit(2)
  }

  let db: Db | null = null
  try {
    db = openDatabase()
  } catch (err) {
    log.error(`database unavailable; cannot load policy: ${(err as Error).message}`)
    process.stderr.write('Bridge: local policy storage is unavailable; refusing to start the proxy.\n')
    process.exit(5)
  }

  let server: ManagedServer | null = db ? repo.getServer(db, serverId) : null

  // A config file outlives the app's state. If the id it names is gone -- the
  // server was removed and re-added, or the database was reset -- fall back to
  // the name, which is what the user actually recognises. Without this the
  // client only reports "Server disconnected" with no way to tell why.
  if (!server && db && args.name) {
    const byName = repo.listServers(db).filter((s) => s.name === args.name)
    if (byName.length === 1) {
      server = byName[0]!
      log.warn(`id ${serverId} not found; recovered "${args.name}" as ${server.id}`)
    } else if (byName.length > 1) {
      log.error(`id ${serverId} not found and "${args.name}" matches ${byName.length} servers`)
    }
  }

  if (!server && process.env.BRIDGE_TARGET) {
    // Escape hatch so a proxy can run before the app has ever been opened.
    try {
      server = JSON.parse(process.env.BRIDGE_TARGET) as ManagedServer
    } catch {
      /* handled below */
    }
  }

  if (!server) {
    const label = args.name ? `"${args.name}" (id ${serverId})` : `id ${serverId}`
    log.error(`no server registered for ${label}`)
    process.stderr.write(
      `Bridge: ${label} is not registered. Open Bridge, connect this server on ` +
        `the Servers page, then restart this app.\n`
    )
    process.exit(3)
  }

  const link = openSession(server, db, writeToClient, log)

  let shuttingDown = false
  const shutdown = async (reason: string, code = 0): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    log.info(`shutting down: ${reason}`)
    await link.close(reason)
    // Give the socket a beat to flush the final events.
    setTimeout(() => process.exit(code), 100).unref()
  }

  link.upstream.onClose(({ code, reason }) => {
    void shutdown(`upstream exited (code ${code}${reason ? `, ${reason}` : ''})`, code ?? 0)
  })

  try {
    await link.upstream.start()
  } catch (err) {
    const message = (err as Error).message
    log.error(`failed to start upstream: ${message}`)
    process.stderr.write(`Bridge: could not start "${server.name}" — ${message}\n`)
    process.exit(4)
  }

  readClient(log, (msg) => void dispatchClientMessage(msg, (message) => link.interceptor.handleFromClient(message), writeToClient, (message) => log.error(message)))
  process.stdin.on('end', () => void shutdown('client closed stdin'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
  installCrashLogging(log)

  log.info(`proxying ${server.name} (${server.target.kind}) as session ${link.sessionId}`)
}

interface SessionLink {
  sessionId: string
  upstream: UpstreamTransport
  interceptor: Interceptor
  close(reason: string): Promise<void>
}

/**
 * Everything one upstream server needs: a session row, a control connection,
 * the transport and the Interceptor between them. The single-server proxy
 * opens one; the gateway opens one per server it fronts.
 */
function openSession(server: ManagedServer, db: Db | null, toClient: (msg: JsonRpcMessage) => void, log: FileLogger): SessionLink {
  const sessionId = `ses_${randomUUID().replace(/-/g, '').slice(0, 20)}`
  const session: SessionRecord = {
    id: sessionId,
    serverId: server.id,
    serverName: server.name,
    client: server.client,
    pid: process.pid,
    startedAt: Date.now(),
    endedAt: null,
    serverInfo: null,
    clientInfo: null
  }
  if (db) {
    try {
      repo.startSession(db, session)
    } catch (err) {
      log.error(`session insert failed: ${(err as Error).message}`)
    }
  }

  const control = new ControlClient((line) => log.debug(line))
  // Identify before connecting so the very first connection authenticates.
  control.identify(session)
  control.connect()

  // A client that computes header values at launch (dsh's `!!js`) hands them
  // over as BRIDGE_HEADER__* variables; they win over what Bridge recorded.
  const upstream: UpstreamTransport =
    server.target.kind === 'http'
      ? new HttpUpstream({ ...server.target, headers: { ...server.target.headers, ...headersFromEnv(process.env) } })
      : new StdioUpstream(server.target)

  const interceptor = new Interceptor({
    server,
    sessionId,
    upstream,
    control,
    db,
    toClient,
    log: (line) => {
      log.info(line)
      control.send({ t: 'log', level: 'info', msg: line })
    }
  })

  upstream.onMessage((msg) => {
    try {
      interceptor.handleFromServer(msg)
    } catch (err) {
      log.error(`server message handling failed: ${(err as Error).message}`)
      toClient(msg) // fail open
    }
  })
  upstream.onLog((line) => log.debug(`[${server.name}] ${line}`))

  let closed = false
  return {
    sessionId,
    upstream,
    interceptor,
    async close(reason) {
      if (closed) return
      closed = true
      interceptor.failAllPending(`Bridge: connection closed (${reason})`)
      const endedAt = Date.now()
      if (db) {
        try {
          repo.endSession(db, sessionId, endedAt)
          repo.clearSessionGrants(db, sessionId)
        } catch {
          /* best effort */
        }
      }
      control.send({ t: 'session.end', sessionId, endedAt })
      await upstream.close().catch(() => undefined)
    }
  }
}

function readClient(log: FileLogger, handle: (msg: JsonRpcMessage) => void): void {
  const decoder = new LineDecoder()
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    let lines: string[]
    try {
      lines = decoder.push(chunk)
    } catch (err) {
      log.error(`client framing error: ${(err as Error).message}`)
      return
    }
    for (const line of lines) {
      const msg = parseFrame(line)
      if (!msg) {
        log.warn(`unparsable frame from client: ${line.slice(0, 300)}`)
        continue
      }
      handle(msg)
    }
  })
}

function installCrashLogging(log: FileLogger): void {
  process.on('uncaughtException', (err) => {
    log.error(`uncaught: ${err.stack ?? err.message}`)
  })
  process.on('unhandledRejection', (reason) => {
    log.error(`unhandled rejection: ${String(reason)}`)
  })
}

/**
 * `--gateway --client <id>` fronts every server Bridge has installed for that
 * client, as one MCP server (see gateway.ts).
 */
async function runGateway(clientId: string): Promise<void> {
  const log = new FileLogger(`gateway-${clientId}`)
  let db: Db
  try {
    db = openDatabase()
  } catch (err) {
    log.error(`database unavailable; cannot load policy: ${(err as Error).message}`)
    process.stderr.write('Bridge: local policy storage is unavailable; refusing to start the gateway.\n')
    process.exit(5)
  }

  // A link row for this client decides; without one, a server installed with
  // this as its home client counts.
  const wiring = new Map(listServerClients(db).filter((l) => l.client === clientId).map((l) => [l.serverId, l.installed]))
  const servers = repo
    .listServers(db)
    .filter((s) => wiring.get(s.id) ?? (s.installed && s.client === clientId))
    .map((s) => ({ ...s, client: clientId as ManagedServer['client'] }))
  const links = new Map<string, SessionLink>()

  const members: MemberLink[] = servers.map((server) => {
    let deliver: (msg: JsonRpcMessage) => void = () => {}
    const link = openSession(server, db, (msg) => deliver(msg), log)
    links.set(server.name, link)
    link.upstream.onClose(({ code, reason }) => {
      const why = `exited (code ${code}${reason ? `, ${reason}` : ''})`
      log.warn(`${server.name} ${why}`)
      void link.close(why)
      gateway.memberClosed(server.name, why)
    })
    return {
      name: server.name,
      start: () => link.upstream.start(),
      send: (msg) => void dispatchClientMessage(msg, (m) => link.interceptor.handleFromClient(m), deliver, (m) => log.error(m)),
      onMessage: (cb) => { deliver = cb }
    }
  })

  const gateway: Gateway = new Gateway({
    members,
    toClient: writeToClient,
    log: (line) => log.info(line),
    mode: () => repo.readSettings(db).gatewayToolMode,
    version: process.env.npm_package_version ?? '0.1.0'
  })

  let shuttingDown = false
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    log.info(`shutting down: ${reason}`)
    await Promise.all([...links.values()].map((link) => link.close(reason)))
    setTimeout(() => process.exit(0), 100).unref()
  }

  readClient(log, (msg) => void dispatchClientMessage(msg, (m) => gateway.handleFromClient(m), writeToClient, (m) => log.error(m)))
  process.stdin.on('end', () => void shutdown('client closed stdin'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
  installCrashLogging(log)

  log.info(`gateway for ${clientId}: ${servers.length} servers (${servers.map((s) => s.name).join(', ') || 'none'})`)
}

void main()
