import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type Server, type Socket } from 'node:net'
import {
  CONTROL_MAX_FRAME_BYTES,
  CONTROL_PROTOCOL_VERSION,
  controlSocketPath,
  controlTokenPath,
  type AppToProxy,
  type ProxyToApp
} from '@shared/control'
import { LineDecoder } from '@shared/jsonrpc'
import type { ApprovalRequest, ApprovalResult, PolicyRule, Settings } from '@shared/types'
import type { FileLogger } from '@shared/logger'

interface Client {
  socket: Socket
  sessionId: string | null
  serverId: string | null
  /** Nothing but `hello` is honoured until this is true. */
  authenticated: boolean
  authTimer: NodeJS.Timeout | null
}

/** How long a connection may stay silent before it is dropped. */
const AUTH_GRACE_MS = 5_000

/** Constant-time compare that tolerates a length mismatch. */
function tokenMatches(expected: string, received: unknown): boolean {
  if (typeof received !== 'string' || received.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(received, 'utf8'), Buffer.from(expected, 'utf8'))
}

export interface ControlServerEvents {
  event: (msg: ProxyToApp) => void
  approval: (request: ApprovalRequest) => void
  approvalResolved: (id: string) => void
}

/**
 * Hosts the socket every proxy process dials into. Carries live trace events
 * up to the UI and approval decisions back down.
 */
export class ControlServer extends EventEmitter {
  private server: Server | null = null
  /** Regenerated on every start, so a leaked token dies with its run. */
  private token = ''
  private readonly clients = new Set<Client>()
  /** Approval id → the proxy waiting on it. */
  private readonly awaiting = new Map<string, Client>()
  private readonly pendingRequests = new Map<string, ApprovalRequest>()

  constructor(
    private readonly log: FileLogger,
    private readonly getConfig: () => { settings: Settings; rules: PolicyRule[] }
  ) {
    super()
  }

  get pending(): ApprovalRequest[] {
    return [...this.pendingRequests.values()].sort((a, b) => a.requestedAt - b.requestedAt)
  }

  get connectionCount(): number {
    return this.clients.size
  }

  /** The still-open request behind an approval id, for deriving a grant from it. */
  pendingRequest(id: string): ApprovalRequest | null {
    return this.pendingRequests.get(id) ?? null
  }

  async start(): Promise<void> {
    // Issued before the socket accepts anything, so no connection can race the
    // token into existence. On Windows the pipe name is derived from it.
    this.token = randomBytes(32).toString('hex')
    const path = controlSocketPath(this.token)
    if (process.platform !== 'win32' && !process.env.BRIDGE_SOCKET) this.prepareSocketDir(dirname(path))
    if (process.platform !== 'win32' && existsSync(path)) {
      // A stale socket from a crashed run would block bind().
      try {
        unlinkSync(path)
      } catch (err) {
        this.log.warn(`could not remove stale socket: ${(err as Error).message}`)
      }
    }

    writeFileSync(controlTokenPath(), this.token, { encoding: 'utf8', mode: 0o600 })

    const server = createServer((socket) => this.accept(socket))
    this.server = server

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, () => {
        server.off('error', reject)
        resolve()
      })
    })

    // Belt and braces alongside the token: on POSIX the socket itself is only
    // reachable by this user.
    if (process.platform !== 'win32') {
      try {
        chmodSync(path, 0o600)
      } catch (err) {
        this.log.warn(`could not restrict socket permissions: ${(err as Error).message}`)
      }
    }

    server.on('error', (err) => this.log.error(`control server error: ${err.message}`))
    this.log.info(`control socket listening at ${path}`)
  }

  /** The socket's directory must be this user's alone, or proxies will refuse it. */
  private prepareSocketDir(dir: string): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const stat = lstatSync(dir)
    if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error(`${dir} is not a directory owned by this user; refusing to listen there`)
    }
    chmodSync(dir, 0o700)
  }

  private accept(socket: Socket): void {
    const client: Client = {
      socket,
      sessionId: null,
      serverId: null,
      authenticated: false,
      authTimer: null
    }
    this.clients.add(client)
    socket.setEncoding('utf8')

    // A connection that never proves itself is dropped rather than left open.
    client.authTimer = setTimeout(() => {
      if (client.authenticated) return
      this.log.warn('control connection closed: no valid hello within the grace period')
      socket.destroy()
    }, AUTH_GRACE_MS)
    client.authTimer.unref?.()

    const decoder = new LineDecoder(CONTROL_MAX_FRAME_BYTES)
    socket.on('data', (chunk: string) => {
      let lines: string[]
      try {
        lines = decoder.push(chunk)
      } catch (err) {
        this.log.error(`control framing error: ${(err as Error).message}`)
        return
      }
      for (const line of lines) {
        try {
          this.handle(client, JSON.parse(line) as ProxyToApp)
        } catch (err) {
          this.log.error(`control message error: ${(err as Error).message}`)
        }
      }
    })

    socket.on('error', () => undefined)
    socket.on('close', () => {
      if (client.authTimer) clearTimeout(client.authTimer)
      this.clients.delete(client)
      // Anything this proxy was waiting on is unresolvable now.
      for (const [id, owner] of this.awaiting) {
        if (owner === client) {
          this.awaiting.delete(id)
          this.pendingRequests.delete(id)
          this.emit('approvalResolved', id)
        }
      }
      if (client.sessionId) {
        this.emit('event', { t: 'session.end', sessionId: client.sessionId, endedAt: Date.now() })
      }
    })
  }

  private handle(client: Client, msg: ProxyToApp): void {
    if (msg.t === 'hello') {
      if (!tokenMatches(this.token, msg.token)) {
        this.log.warn('control connection refused: bad or missing token')
        client.socket.destroy()
        return
      }
      client.authenticated = true
      if (client.authTimer) {
        clearTimeout(client.authTimer)
        client.authTimer = null
      }
      client.sessionId = msg.session.id
      client.serverId = msg.session.serverId
      const { settings, rules } = this.getConfig()
      this.write(client, { t: 'welcome', v: CONTROL_PROTOCOL_VERSION, settings, rules })
      // The rest of the app learns of the session, never the token that opened it.
      this.emit('event', { ...msg, token: '' })
      return
    }

    // Everything else is trace data and approval traffic: honoured only from a
    // connection that has proved it can read the token.
    if (!client.authenticated) {
      this.log.warn(`ignored "${msg.t}" from an unauthenticated control connection`)
      return
    }

    if (msg.t === 'approval.request') {
      this.awaiting.set(msg.request.id, client)
      this.pendingRequests.set(msg.request.id, msg.request)
      this.emit('approval', msg.request)
      // Fall through so the UI also sees it in the live stream.
    }
    this.emit('event', msg)
  }

  resolveApproval(result: ApprovalResult): boolean {
    const client = this.awaiting.get(result.id)
    this.awaiting.delete(result.id)
    this.pendingRequests.delete(result.id)
    this.emit('approvalResolved', result.id)
    if (!client) return false
    this.write(client, { t: 'approval.result', result })
    return true
  }

  broadcastConfig(settings: Settings, rules: PolicyRule[]): void {
    for (const client of this.clients) {
      this.write(client, { t: 'config.update', settings, rules })
    }
  }

  /** Pushes a server's hidden-tool list to the proxies serving it. */
  broadcastToolPrefs(serverId: string, disabled: string[]): void {
    for (const client of this.clients) {
      if (client.serverId && client.serverId !== serverId) continue
      this.write(client, { t: 'tools.prefs', serverId, disabled })
    }
  }

  private write(client: Client, msg: AppToProxy): void {
    if (client.socket.destroyed) return
    // Only `welcome` may precede authentication, and `handle` sends that itself.
    if (!client.authenticated && msg.t !== 'welcome') return
    client.socket.write(JSON.stringify(msg) + '\n')
  }

  async stop(): Promise<void> {
    for (const client of this.clients) {
      if (client.authTimer) clearTimeout(client.authTimer)
      client.socket.destroy()
    }
    this.clients.clear()
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve()
      this.server.close(() => resolve())
    })
    this.server = null
    this.token = ''
    try {
      unlinkSync(controlTokenPath())
    } catch {
      /* already gone */
    }
    if (process.platform !== 'win32') {
      try {
        unlinkSync(controlSocketPath(this.token))
      } catch {
        /* already gone */
      }
    }
  }
}
