/**
 * One MCP server, as the AI client sees it, standing in front of all of them.
 *
 * In gateway mode a client's config holds a single `bridge` entry instead of
 * one per server. This process starts every server that client has in Bridge,
 * each behind its own Interceptor — so policy, approvals, tracing and result
 * shaping are exactly what they are for a directly-wrapped server — and
 * presents them to the client as one.
 *
 * It presents them one of two ways:
 *
 * - **all**: every tool, renamed `<server>__<tool>`. Same as wiring each server
 *   separately, minus the config sprawl.
 * - **search**: two tools, `search_tools` and `call_tool`. The model looks up
 *   what it needs and gets full schemas for just those, so forty servers cost
 *   the context of two tools instead of six hundred.
 *
 * `auto` picks search once the combined list passes `AUTO_SEARCH_ABOVE`.
 *
 * Only tools are offered. Resources and prompts are answered with empty lists,
 * and server-initiated requests (sampling, elicitation, roots) are refused, so
 * a server that depends on those should stay wired directly.
 */
import { ErrorCodes, isRequest, isResponse, type JsonRpcId, type JsonRpcMessage, type JsonRpcRequest } from '@shared/jsonrpc'
import { rankTools } from '@shared/tool-search'

export type GatewayToolMode = 'auto' | 'all' | 'search'

/** Above this many tools in total, `auto` switches from listing them to search. */
export const AUTO_SEARCH_ABOVE = 40

const STARTUP_TIMEOUT_MS = 30_000
const SEARCH_DEFAULT = 8
const SEARCH_MAX = 20
const SEPARATOR = '__'

interface Tool {
  name: string
  description?: string
  inputSchema?: unknown
  [key: string]: unknown
}

/**
 * One upstream server as the gateway sees it: messages in through `send`, which
 * lands on the server's Interceptor, and out through `onMessage`.
 */
export interface MemberLink {
  name: string
  start(): Promise<void>
  send(msg: JsonRpcMessage): void
  onMessage(cb: (msg: JsonRpcMessage) => void): void
}

interface Member {
  link: MemberLink
  /** Name the model uses for this server; unique and safe for tool names. */
  alias: string
  status: 'starting' | 'ready' | 'failed'
  error: string | null
  tools: Tool[]
  ready: Promise<void>
  pending: Map<string, (msg: JsonRpcMessage) => void>
}

export interface GatewayOptions {
  members: MemberLink[]
  toClient: (msg: JsonRpcMessage) => void
  log: (line: string) => void
  /** Read on every `tools/list`, so a settings change applies at the next one. */
  mode: () => GatewayToolMode
  version: string
}

/** Server names become part of tool names, which clients limit to [A-Za-z0-9_-]. */
export function aliasFor(name: string, taken: Set<string>): string {
  const base = name.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'server'
  let alias = base
  for (let n = 2; taken.has(alias); n++) alias = `${base}-${n}`
  taken.add(alias)
  return alias
}

const text = (value: string) => ({ type: 'text', text: value })
const toolError = (message: string) => ({ content: [text(message)], isError: true })

export class Gateway {
  private readonly members: Member[]
  private clientInit: { protocolVersion?: string; clientInfo?: unknown } = {}
  private started: Promise<void> | null = null
  private nextId = 0
  /** Client request id -> where it went, so a cancellation can follow it. */
  private readonly routed = new Map<string, { member: Member; id: string }>()
  /** The mode the client was last shown, to know whether a list change matters to it. */
  private shownMode: 'all' | 'search' | null = null

  constructor(private readonly opts: GatewayOptions) {
    const taken = new Set<string>()
    this.members = opts.members.map((link) => {
      const member: Member = {
        link,
        alias: aliasFor(link.name, taken),
        status: 'starting',
        error: null,
        tools: [],
        ready: Promise.resolve(),
        pending: new Map()
      }
      link.onMessage((msg) => this.fromMember(member, msg))
      return member
    })
  }

  /* ----------------------------- client → gateway ---------------------------- */

  async handleFromClient(msg: JsonRpcMessage): Promise<void> {
    if (isResponse(msg)) return // the gateway never sends the client a request
    if (!isRequest(msg)) {
      if (msg.method === 'notifications/cancelled') this.cancel(msg.params?.requestId, msg.params?.reason)
      return
    }
    switch (msg.method) {
      case 'initialize':
        return this.initialize(msg)
      case 'ping':
        return this.reply(msg.id, {})
      case 'tools/list':
        return this.listTools(msg)
      case 'tools/call':
        return this.callTool(msg)
      case 'resources/list':
        return this.reply(msg.id, { resources: [] })
      case 'resources/templates/list':
        return this.reply(msg.id, { resourceTemplates: [] })
      case 'prompts/list':
        return this.reply(msg.id, { prompts: [] })
      default:
        return this.fail(msg.id, ErrorCodes.MethodNotFound, `Bridge gateway does not support ${msg.method}.`)
    }
  }

  private initialize(msg: JsonRpcRequest): void {
    this.clientInit = { protocolVersion: msg.params?.protocolVersion, clientInfo: msg.params?.clientInfo }
    // Answer at once and start the servers behind it in the background: a slow
    // server must not hold up the client's handshake.
    this.reply(msg.id, {
      protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: 'bridge', version: this.opts.version },
      instructions:
        'Bridge connects you to several MCP servers through this one. If you see search_tools, ' +
        'use it to find a tool by describing the task, then run it with call_tool.'
    })
    this.startAll()
  }

  private startAll(): Promise<void> {
    if (!this.started) this.started = Promise.all(this.members.map((m) => (m.ready = this.startMember(m)))).then(() => undefined)
    return this.started
  }

  private async startMember(member: Member): Promise<void> {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`did not start within ${STARTUP_TIMEOUT_MS / 1000}s`)), STARTUP_TIMEOUT_MS).unref?.()
    )
    try {
      await Promise.race([
        (async () => {
          await member.link.start()
          const init = await this.request(member, 'initialize', {
            protocolVersion: this.clientInit.protocolVersion ?? '2025-06-18',
            capabilities: {},
            clientInfo: this.clientInit.clientInfo ?? { name: 'bridge-gateway', version: this.opts.version }
          })
          if ('error' in init && init.error) throw new Error(init.error.message)
          member.link.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
          member.tools = await this.fetchTools(member)
        })(),
        timeout
      ])
      member.status = 'ready'
      this.opts.log(`${member.link.name}: ready with ${member.tools.length} tools`)
    } catch (err) {
      member.status = 'failed'
      member.error = (err as Error).message
      this.opts.log(`${member.link.name}: unavailable (${member.error})`)
    }
  }

  private async fetchTools(member: Member): Promise<Tool[]> {
    const tools: Tool[] = []
    let cursor: string | undefined
    // A server paging forever is a bug; stop rather than spin.
    for (let page = 0; page < 50; page++) {
      const res = await this.request(member, 'tools/list', cursor ? { cursor } : {})
      if ('error' in res && res.error) throw new Error(res.error.message)
      const result = (res as { result?: { tools?: Tool[]; nextCursor?: string } }).result
      tools.push(...(result?.tools ?? []))
      cursor = result?.nextCursor
      if (!cursor) break
    }
    return tools
  }

  /* ------------------------------- tools/list ------------------------------- */

  private effectiveMode(): 'all' | 'search' {
    const mode = this.opts.mode()
    if (mode !== 'auto') return mode
    const total = this.members.reduce((n, m) => n + m.tools.length, 0)
    return total > AUTO_SEARCH_ABOVE ? 'search' : 'all'
  }

  private async listTools(msg: JsonRpcRequest): Promise<void> {
    await this.startAll()
    const mode = (this.shownMode = this.effectiveMode())
    this.reply(msg.id, { tools: mode === 'all' ? this.namespacedTools() : this.searchTools() })
  }

  private namespacedTools(): Tool[] {
    return this.ready().flatMap((m) =>
      m.tools.map((tool) => ({ ...tool, name: `${m.alias}${SEPARATOR}${tool.name}`.slice(0, 64) }))
    )
  }

  private searchTools(): Tool[] {
    const ready = this.ready()
    const servers = ready.map((m) => `${m.alias} (${m.tools.length})`).join(', ') || 'none ready'
    const total = ready.reduce((n, m) => n + m.tools.length, 0)
    return [
      {
        name: 'search_tools',
        description:
          `Find tools across ${ready.length} connected MCP servers with ${total} tools in all: ${servers}. ` +
          'Describe what you want to do; matching tools come back with their full input schemas. Run one with call_tool.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'What you want to do, in a few words, e.g. "create a GitHub issue".' },
            server: { type: 'string', description: 'Only search this server.' },
            limit: { type: 'integer', minimum: 1, maximum: SEARCH_MAX, description: `How many tools to return (default ${SEARCH_DEFAULT}).` }
          },
          required: ['query']
        }
      },
      {
        name: 'call_tool',
        description: 'Run a tool found with search_tools. Pass its server and tool name exactly as search_tools returned them.',
        inputSchema: {
          type: 'object',
          properties: {
            server: { type: 'string' },
            tool: { type: 'string' },
            arguments: { type: 'object', description: "The tool's arguments, matching its input schema." }
          },
          required: ['server', 'tool']
        }
      }
    ]
  }

  private ready(): Member[] {
    return this.members.filter((m) => m.status === 'ready')
  }

  /* ------------------------------- tools/call ------------------------------- */

  private async callTool(msg: JsonRpcRequest): Promise<void> {
    await this.startAll()
    const name: string = msg.params?.name ?? ''

    if (name === 'search_tools') return this.reply(msg.id, this.search(msg.params?.arguments ?? {}))

    if (name === 'call_tool') {
      const args = msg.params?.arguments ?? {}
      const member = this.memberNamed(String(args.server ?? ''))
      const tool = String(args.tool ?? '')
      if (!member) return this.reply(msg.id, toolError(`No server named "${args.server}". Servers: ${this.members.map((m) => m.alias).join(', ')}.`))
      if (member.status !== 'ready') return this.reply(msg.id, toolError(`"${member.alias}" is unavailable: ${member.error ?? 'still starting'}.`))
      if (!member.tools.some((t) => t.name === tool)) {
        return this.reply(msg.id, toolError(`"${member.alias}" has no tool named "${tool}". Use search_tools to find the right name.`))
      }
      const res = await this.forwardCall(msg, member, tool, args.arguments ?? {})
      // Through call_tool, a refusal or failure is the tool's answer, not a protocol error.
      if (res.error) return this.reply(msg.id, toolError(res.error.message))
      return this.reply(msg.id, res.result)
    }

    const cut = name.indexOf(SEPARATOR)
    const member = cut > 0 ? this.memberNamed(name.slice(0, cut)) : undefined
    const tool = member?.tools.find((t) => `${member.alias}${SEPARATOR}${t.name}`.slice(0, 64) === name)
    if (!member || !tool || member.status !== 'ready') {
      return this.fail(msg.id, ErrorCodes.InvalidParams, `Unknown tool "${name}".`)
    }
    const res = await this.forwardCall(msg, member, tool.name, msg.params?.arguments ?? {})
    this.opts.toClient({ jsonrpc: '2.0', id: msg.id, ...(res.error ? { error: res.error } : { result: res.result }) })
  }

  private search(args: { query?: unknown; server?: unknown; limit?: unknown }): unknown {
    const query = String(args.query ?? '').trim()
    if (!query) return toolError('Give search_tools a query describing what you want to do.')
    const limit = Math.min(Math.max(Number(args.limit) || SEARCH_DEFAULT, 1), SEARCH_MAX)
    const scope = args.server ? [this.memberNamed(String(args.server))].filter((m): m is Member => !!m) : this.members

    const candidates = scope
      .filter((m) => m.status === 'ready')
      .flatMap((m) => m.tools.map((tool) => ({ server: m.alias, name: tool.name, description: tool.description, tool })))
    const hits = rankTools(candidates, query, limit)
    const unavailable = scope.filter((m) => m.status !== 'ready').map((m) => `${m.alias} (${m.error ?? 'starting'})`)

    if (hits.length === 0) {
      const servers = this.ready().map((m) => `${m.alias}: ${m.tools.length} tools`).join('; ')
      return {
        content: [text(`No tools matched "${query}". Try other words. Available: ${servers || 'none'}.${unavailable.length ? ` Unavailable: ${unavailable.join(', ')}.` : ''}`)]
      }
    }
    const found = hits.map(({ tool }) => ({
      server: tool.server,
      tool: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.tool.inputSchema ?? { type: 'object' }
    }))
    const note = unavailable.length ? `\nNot searched, unavailable: ${unavailable.join(', ')}.` : ''
    return { content: [text(`${JSON.stringify(found, null, 1)}\nRun one with call_tool({ server, tool, arguments }).${note}`)] }
  }

  private memberNamed(name: string): Member | undefined {
    return this.members.find((m) => m.alias === name) ?? this.members.find((m) => m.alias.toLowerCase() === name.toLowerCase())
  }

  private async forwardCall(msg: JsonRpcRequest, member: Member, tool: string, args: unknown): Promise<{ result?: unknown; error?: { code: number; message: string; data?: unknown } }> {
    const meta = msg.params?._meta
    const res = await this.request(member, 'tools/call', { name: tool, arguments: args, ...(meta ? { _meta: meta } : {}) }, String(msg.id))
    return res as never
  }

  /* --------------------------- gateway ↔ members ---------------------------- */

  private request(member: Member, method: string, params: unknown, clientId?: string): Promise<JsonRpcMessage & { result?: unknown; error?: { code: number; message: string } }> {
    const id = `g${++this.nextId}`
    if (clientId !== undefined) this.routed.set(clientId, { member, id })
    return new Promise((resolve) => {
      member.pending.set(id, (msg) => {
        if (clientId !== undefined) this.routed.delete(clientId)
        resolve(msg as never)
      })
      member.link.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  private fromMember(member: Member, msg: JsonRpcMessage): void {
    if (isResponse(msg)) {
      const resolve = member.pending.get(String(msg.id))
      if (resolve) {
        member.pending.delete(String(msg.id))
        resolve(msg)
      }
      return
    }
    if (isRequest(msg)) {
      // Sampling, elicitation and roots need the real client; say so instead of hanging the server.
      member.link.send({ jsonrpc: '2.0', id: msg.id, error: { code: ErrorCodes.MethodNotFound, message: `Bridge gateway does not relay ${msg.method}.` } })
      return
    }
    if (msg.method === 'notifications/tools/list_changed') {
      void this.refresh(member)
      return
    }
    if (msg.method === 'notifications/progress' || msg.method === 'notifications/message') this.opts.toClient(msg)
  }

  private async refresh(member: Member): Promise<void> {
    if (member.status !== 'ready') return
    try {
      member.tools = await this.fetchTools(member)
    } catch (err) {
      this.opts.log(`${member.link.name}: tool refresh failed (${(err as Error).message})`)
      return
    }
    // In search mode the client's list is two fixed tools; only the index changed.
    if (this.shownMode !== 'search' || this.effectiveMode() !== 'search') {
      this.opts.toClient({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
    }
  }

  private cancel(requestId: JsonRpcId | undefined, reason: unknown): void {
    if (requestId === undefined) return
    const route = this.routed.get(String(requestId))
    if (!route) return
    this.routed.delete(String(requestId))
    // The server will not answer a cancelled request, so stop waiting for it.
    route.member.pending.delete(route.id)
    route.member.link.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: route.id, ...(reason ? { reason } : {}) } })
  }

  /** A member's process died: answer everything still waiting on it. */
  memberClosed(name: string, reason: string): void {
    const member = this.members.find((m) => m.link.name === name)
    if (!member) return
    const wasReady = member.status === 'ready'
    member.status = 'failed'
    member.error = reason
    for (const [id, resolve] of member.pending) {
      resolve({ jsonrpc: '2.0', id, error: { code: ErrorCodes.InternalError, message: `${member.alias} stopped: ${reason}` } })
    }
    member.pending.clear()
    if (wasReady && this.shownMode === 'all') this.opts.toClient({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
  }

  private reply(id: JsonRpcId, result: unknown): void {
    this.opts.toClient({ jsonrpc: '2.0', id, result })
  }

  private fail(id: JsonRpcId, code: number, message: string): void {
    this.opts.toClient({ jsonrpc: '2.0', id, error: { code, message } })
  }
}
