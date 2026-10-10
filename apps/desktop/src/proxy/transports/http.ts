import type { HttpTarget } from '@shared/types'
import { isRequest, type JsonRpcMessage } from '@shared/jsonrpc'
import type { UpstreamTransport } from './types'

const SESSION_HEADER = 'mcp-session-id'

/**
 * Speaks Streamable HTTP to a remote MCP server: each client message is POSTed,
 * and the reply arrives either as JSON or as an SSE stream. A background GET
 * stream carries server-initiated messages when the server offers one.
 */
export class HttpUpstream implements UpstreamTransport {
  private sessionId: string | null = null
  private abort = new AbortController()
  private messageCb: (msg: JsonRpcMessage) => void = () => {}
  private logCb: (line: string) => void = () => {}
  private closeCb: (info: { code: number | null; reason?: string }) => void = () => {}
  private closed = false
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly target: HttpTarget) {}

  async start(): Promise<void> {
    // The listening stream is optional; servers that reject GET are still fine.
    // The session is established by initialize before opening GET.
  }

  send(msg: JsonRpcMessage): void {
    // Serialised so the session id from the first response is applied to the rest.
    const operation = this.queue.then(() => this.post(msg))
    if (isRequest(msg) && msg.method === 'initialize') this.queue = operation.catch(() => undefined)
    void operation.catch((err) => {
      this.logCb(`post failed: ${(err as Error).message}`)
      if (isRequest(msg)) {
        this.messageCb({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32603, message: `Bridge: upstream request failed — ${(err as Error).message}` }
        })
      }
    })
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...this.target.headers,
      ...extra
    }
    if (this.sessionId) h[SESSION_HEADER] = this.sessionId
    return h
  }

  private async post(msg: JsonRpcMessage): Promise<void> {
    const res = await fetch(this.target.url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(msg),
      signal: this.abort.signal
    })

    const returned = res.headers.get(SESSION_HEADER)
    if (returned && !this.sessionId) {
      this.sessionId = returned
      void this.openEventStream()
    }

    if (res.status === 202 || res.status === 204) return
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status} ${res.statusText} ${body.slice(0, 200)}`)
    }

    const contentType = res.headers.get('content-type') ?? ''
    if (contentType.includes('text/event-stream')) {
      await this.consumeEventStream(res)
      return
    }
    const text = await res.text()
    if (!text.trim()) return
    this.dispatchJson(text)
  }

  private dispatchJson(text: string): void {
    try {
      const parsed = JSON.parse(text)
      const items = Array.isArray(parsed) ? parsed : [parsed]
      for (const item of items) {
        if (item && item.jsonrpc === '2.0') this.messageCb(item as JsonRpcMessage)
      }
    } catch {
      this.logCb(`unparsable HTTP body: ${text.slice(0, 300)}`)
    }
  }

  private async openEventStream(): Promise<void> {
    try {
      const res = await fetch(this.target.url, {
        method: 'GET',
        headers: this.headers({ accept: 'text/event-stream' }),
        signal: this.abort.signal
      })
      if (!res.ok || !res.body) return
      await this.consumeEventStream(res)
    } catch (err) {
      if (!this.closed) this.logCb(`event stream ended: ${(err as Error).message}`)
    }
  }

  /** Minimal SSE reader — enough for `data:` frames carrying JSON-RPC. */
  private async consumeEventStream(res: Response): Promise<void> {
    if (!res.body) return
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let sep: number
      while ((sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const raw = buffer.slice(0, sep)
        buffer = buffer.slice(sep).replace(/^\r?\n\r?\n/, '')
        const data = raw
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n')
        if (data) this.dispatchJson(data)
      }
    }
  }

  onMessage(cb: (msg: JsonRpcMessage) => void): void {
    this.messageCb = cb
  }
  onLog(cb: (line: string) => void): void {
    this.logCb = cb
  }
  onClose(cb: (info: { code: number | null; reason?: string }) => void): void {
    this.closeCb = cb
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.abort.abort()
    if (this.sessionId) {
      await fetch(this.target.url, { method: 'DELETE', headers: this.headers(), signal: AbortSignal.timeout(5000) }).catch(() => undefined)
    }
    this.closeCb({ code: 0 })
  }
}
