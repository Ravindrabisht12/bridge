import { redactPayload } from '../scanners/redaction'
import { readFileSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import {
  CONTROL_MAX_FRAME_BYTES,
  CONTROL_PROTOCOL_VERSION,
  controlSocketPath,
  verifyControlSocket,
  controlTokenPath,
  type AppToProxy,
  type ProxyToApp
} from '@shared/control'
import type { ApprovalRequest, ApprovalResult, PolicyRule, SessionRecord, Settings } from '@shared/types'
import { LineDecoder } from '@shared/jsonrpc'

type ConfigListener = (settings: Settings, rules: PolicyRule[]) => void
type ToolPrefsListener = (serverId: string, disabled: string[]) => void

/**
 * Link from a proxy process to the Bridge app. The app is optional: when the
 * socket is unavailable the proxy keeps running, keeps recording to the
 * database, and resolves approvals with the configured offline fallback.
 */
export class ControlClient {
  private socket: Socket | null = null
  private readonly decoder = new LineDecoder(CONTROL_MAX_FRAME_BYTES)
  private readonly pending = new Map<string, (result: ApprovalResult) => void>()
  private configListener: ConfigListener | null = null
  private toolPrefsListener: ToolPrefsListener | null = null
  private connected = false
  private stopped = false
  private retryDelay = 500
  private outbox: string[] = []
  /** Kept so every reconnection can re-introduce itself. */
  private session: SessionRecord | null = null

  constructor(private readonly onLog: (line: string) => void) {}

  get online(): boolean {
    return this.connected
  }

  onConfig(cb: ConfigListener): void {
    this.configListener = cb
  }

  onToolPrefs(cb: ToolPrefsListener): void {
    this.toolPrefsListener = cb
  }

  /**
   * Names this session to the app. Held rather than sent once: the app can
   * restart under a running proxy, and the connection that comes back has to
   * authenticate again with whatever token the new run issued.
   */
  identify(session: SessionRecord): void {
    this.session = session
    if (this.connected && this.socket) this.writeHello(this.socket, this.readToken())
  }

  /**
   * The token is a 0600 file in the app's directory, re-read on every attempt.
   * It is absent whenever Bridge is not running, which is a normal state — the
   * proxy keeps recording and falls back offline.
   */
  private writeHello(socket: Socket, token: string): void {
    if (!this.session || !token) return
    socket.write(
      JSON.stringify({ t: 'hello', v: CONTROL_PROTOCOL_VERSION, session: this.session, token }) + '\n'
    )
  }

  private readToken(): string {
    try {
      return readFileSync(controlTokenPath(), 'utf8').trim()
    } catch {
      // No token means no app, or an app that has not finished starting.
      return ''
    }
  }

  connect(): void {
    if (this.stopped) return
    const token = this.readToken()
    const path = controlSocketPath(token)
    const socket = connect(path)
    this.socket = socket

    socket.on('connect', () => {
      // Whoever is listening gets the token, so make sure it is this user.
      const refused = verifyControlSocket(path)
      if (refused) {
        this.onLog(`refusing control socket: ${refused}`)
        socket.destroy()
        return
      }
      this.connected = true
      this.retryDelay = 500
      // Authenticate before anything queued: the app drops every other message
      // from a connection that has not said hello.
      this.writeHello(socket, token)
      for (const line of this.outbox.splice(0)) socket.write(line)
    })

    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      for (const line of this.decoder.push(chunk)) {
        try {
          this.handle(JSON.parse(line) as AppToProxy)
        } catch (err) {
          this.onLog(`control parse error: ${(err as Error).message}`)
        }
      }
    })

    const drop = (): void => {
      this.connected = false
      this.socket = null
      // Every pending approval fails closed to its caller's fallback.
      for (const [id, resolve] of this.pending) {
        resolve({ id, effect: 'deny', scope: 'once' })
      }
      this.pending.clear()
      if (this.stopped) return
      this.retryDelay = Math.min(this.retryDelay * 2, 30_000)
      setTimeout(() => this.connect(), this.retryDelay).unref?.()
    }

    socket.on('error', (err) => {
      if (this.connected) this.onLog(`control socket error: ${err.message}`)
    })
    socket.on('close', drop)
  }

  private handle(msg: AppToProxy): void {
    switch (msg.t) {
      case 'welcome':
      case 'config.update':
        this.configListener?.(msg.settings, msg.rules)
        break
      case 'tools.prefs':
        this.toolPrefsListener?.(msg.serverId, msg.disabled)
        break
      case 'approval.result': {
        const resolve = this.pending.get(msg.result.id)
        if (resolve) {
          this.pending.delete(msg.result.id)
          resolve(msg.result)
        }
        break
      }
      case 'shutdown':
        this.onLog('app requested shutdown')
        process.emit('SIGTERM' as never)
        break
    }
  }

  send(msg: ProxyToApp): void {
    // `hello` is bound to a connection and its token, so it is never queued.
    if (msg.t === 'hello') {
      this.identify(msg.session)
      return
    }
    const safe = msg.t === 'call.start' || msg.t === 'call.end'
      ? { ...msg, call: { ...msg.call, args: redactPayload(msg.call.args), result: redactPayload(msg.call.result), error: redactPayload(msg.call.error), findings: redactPayload(msg.call.findings) } }
      : msg.t === 'approval.request'
        ? { ...msg, request: { ...msg.request, args: redactPayload(msg.request.args), findings: redactPayload(msg.request.findings) } }
        : msg.t === 'log' ? { ...msg, msg: redactPayload(msg.msg) } : msg
    const line = JSON.stringify(safe) + '\n'
    if (this.socket && this.connected) {
      this.socket.write(line)
    } else if (this.outbox.length < 500) {
      this.outbox.push(line)
    }
  }

  /**
   * Asks the user. Resolves to null when the app is unreachable or silent so
   * the caller can apply `offlineAskFallback`.
   */
  async requestApproval(request: ApprovalRequest): Promise<ApprovalResult | null> {
    if (!this.connected) return null
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id)
        resolve(null)
      }, request.timeoutMs)
      timer.unref?.()

      this.pending.set(request.id, (result) => {
        clearTimeout(timer)
        resolve(result)
      })
      this.send({ t: 'approval.request', request })
    })
  }

  close(): void {
    this.stopped = true
    this.socket?.end()
    this.socket = null
  }
}
