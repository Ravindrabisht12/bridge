import { createHash, randomUUID } from 'node:crypto'
import { ErrorCodes, isRequest, isResponse, type JsonRpcMessage, type JsonRpcRequest } from '@shared/jsonrpc'
import type {
  ApprovalRequest,
  CallRecord,
  ManagedServer,
  PolicyEffect,
  PolicyRule,
  Settings
} from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import { type PolicyContext } from '../policy/engine'
import { decide } from '../policy/decide'
import { extractText, redactResult, scanResult } from '../scanners'
import { RepeatTracker, repeatNote, REPEAT_THRESHOLD, trimResult } from '@shared/shaping'
import type { Db } from '../db'
import * as repo from '../db/repo'
import type { ControlClient } from './control-client'
import type { UpstreamTransport } from './transports/types'

interface InFlight {
  call: CallRecord
  startedAt: number
  redactPatterns: string[]
}

export interface InterceptorOptions {
  server: ManagedServer
  sessionId: string
  upstream: UpstreamTransport
  control: ControlClient
  db: Db | null
  toClient: (msg: JsonRpcMessage) => void
  log: (line: string) => void
}

const fingerprint = (tool: { name: string; description?: string; inputSchema?: unknown }): string =>
  createHash('sha256')
    .update(JSON.stringify([tool.name, tool.description ?? '', tool.inputSchema ?? null]))
    .digest('hex')
    .slice(0, 32)

const estimateTokens = (text: string): number => Math.ceil(text.length / 4)

/**
 * Sits between the AI client and one MCP server. Every message passes through
 * here: tool calls are policed and recorded, results are scanned before they
 * reach the model, and the server's tool inventory is fingerprinted so a
 * silently-changed tool definition can be caught.
 */
export class Interceptor {
  private settings: Settings = DEFAULT_SETTINGS
  private rules: PolicyRule[] = []

  private readonly awaitingCalls = new Set<string>()
  private readonly cancelledCalls = new Set<string>()
  private readonly inFlight = new Map<string, InFlight>()
  private readonly listRequests = new Set<string>()
  private readonly initRequests = new Set<string>()
  /** Decisions the user chose to remember for this session only. */
  private readonly sessionGrants = new Map<string, 'allow' | 'deny'>()
  /** Tools whose definition changed and have not been re-approved yet. */
  private readonly unacknowledgedChanges = new Set<string>()
  /** Tools the user switched off. They are stripped from tools/list entirely. */
  private disabledTools = new Set<string>()
  /**
   * Ids of client requests actually sent upstream and not yet answered. A
   * response is only delivered if it answers one of these: otherwise a server
   * could answer a call still waiting for approval — or one that will be
   * denied — and the client would take it as the result, unscanned and
   * unrecorded.
   */
  private readonly forwarded = new Set<string>()
  /** Identical calls returning identical results, for the repeat note. */
  private readonly repeats = new RepeatTracker()
  /** How this client named itself in `initialize`, if it did. */
  private clientName: string | null = null

  constructor(private readonly opts: InterceptorOptions) {
    if (opts.db) {
      this.settings = repo.readSettings(opts.db)
      this.rules = repo.listRules(opts.db)
      this.disabledTools = new Set(repo.disabledTools(opts.db, opts.server.id))
    }
    opts.control.onConfig((settings, rules) => {
      this.settings = settings
      this.rules = rules
    })
    opts.control.onToolPrefs((serverId, disabled) => {
      if (serverId !== this.opts.server.id) return
      this.disabledTools = new Set(disabled)
      this.opts.log(`tool visibility updated: ${disabled.length} hidden`)
      // Ask the client to re-read the list so the change lands without a restart.
      this.opts.toClient({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
    })
  }

  /* ----------------------------- client → server ---------------------------- */

  async handleFromClient(msg: JsonRpcMessage): Promise<void> {
    if (isRequest(msg)) {
      const id = String(msg.id)
      if (msg.method === 'tools/list') this.listRequests.add(id)
      else if (msg.method === 'initialize') {
        this.initRequests.add(id)
        this.captureClientInfo(msg.params)
      }
      else if (msg.method === 'tools/call') {
        await this.handleToolCall(structuredClone(msg))
        return
      }
      this.forwarded.add(id)
    } else if (!isResponse(msg) && msg.method === 'notifications/cancelled') {
      const cancelledId = msg.params?.requestId
      if (cancelledId !== undefined) this.finishCancelled(String(cancelledId))
    }
    this.opts.upstream.send(msg)
  }

  /**
   * `clientInfo` is the only standard place a client says who it is, and the
   * only lever available for telling one surface of the same app from another.
   * The whole params blob is logged once so an unfamiliar client can be
   * inspected without guessing at its shape.
   */
  private captureClientInfo(params: unknown): void {
    const info = (params as { clientInfo?: { name?: string; version?: string; title?: string } })?.clientInfo
    this.clientName = info?.name ?? null
    const clientInfo = info ? { name: info.name, version: info.version, title: info.title } : null

    this.opts.log(`client identified as ${JSON.stringify(clientInfo)}`)

    if (this.opts.db) {
      try {
        repo.setSessionClientInfo(this.opts.db, this.opts.sessionId, clientInfo)
      } catch (err) {
        this.opts.log(`client info write failed: ${(err as Error).message}`)
      }
    }
    this.opts.control.send({ t: 'session.client', sessionId: this.opts.sessionId, clientInfo })
  }

  /**
   * A disabled tool should never have been advertised, but a client may be
   * working from a cached list — refuse it rather than trusting that.
   */
  private refuseDisabledTool(msg: JsonRpcRequest, tool: string, args: unknown, now: number): void {
    const call: CallRecord = {
      id: `call_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      sessionId: this.opts.sessionId,
      serverId: this.opts.server.id,
      serverName: this.opts.server.name,
      client: this.opts.server.client,
      method: 'tools/call',
      tool,
      args,
      result: null,
      error: null,
      status: 'denied',
      decision: 'deny',
      decidedBy: 'policy',
      ruleId: null,
      startedAt: now,
      endedAt: now,
      durationMs: 0,
      resultBytes: null,
      tokenEstimate: null,
      findings: [],
      redacted: false
    }
    this.persist(call)
    this.opts.control.send({ t: 'call.end', call })
    this.opts.toClient({
      jsonrpc: '2.0',
      id: msg.id,
      error: {
        code: ErrorCodes.PolicyDenied,
        message: `"${tool}" is switched off in Bridge and is not available.`,
        data: { tool, serverId: this.opts.server.id, reason: 'tool-disabled' }
      }
    })
  }

  private async handleToolCall(msg: JsonRpcRequest): Promise<void> {
    // Read the shared policy on every call, including while the UI socket is disconnected.
    if (this.opts.db) {
      this.settings = repo.readSettings(this.opts.db)
      this.rules = repo.listRules(this.opts.db)
    }
    const id = String(msg.id)
    const tool: string = msg.params?.name ?? 'unknown'
    const args = msg.params?.arguments ?? {}
    const now = Date.now()

    // Refused before any policy work: a switched-off tool must not consume a
    // grant's use on the way to being rejected.
    if (this.disabledTools.has(tool)) {
      this.refuseDisabledTool(msg, tool, args, now)
      return
    }

    const ctx: PolicyContext = {
      serverId: this.opts.server.id,
      method: 'tools/call',
      tool,
      args,
      clientName: this.clientName
    }
    const decision = decide({
      settings: this.settings,
      rules: this.rules,
      ctx,
      sessionId: this.opts.sessionId,
      db: this.opts.db,
      toolChanged: this.unacknowledgedChanges.has(tool),
      log: (line) => this.opts.log(line)
    })
    const { credentialGate, onceOnly, verdict } = decision
    let effect: PolicyEffect = decision.effect

    const call: CallRecord = {
      id: `call_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      sessionId: this.opts.sessionId,
      serverId: this.opts.server.id,
      serverName: this.opts.server.name,
      client: this.opts.server.client,
      method: 'tools/call',
      tool,
      args,
      result: null,
      error: null,
      status: 'pending',
      decision: null,
      decidedBy: decision.grant ? 'user' : null,
      ruleId: decision.ruleId,
      startedAt: now,
      endedAt: null,
      durationMs: null,
      resultBytes: null,
      tokenEstimate: null,
      findings: decision.findings,
      redacted: false
    }

    if (decision.grant) {
      this.opts.log(
        `authorised by grant ${decision.grant.id} (${decision.grant.remaining} uses left): ${decision.grant.label}`
      )
    }

    const grant = this.sessionGrants.get(tool)
    if (grant && effect === 'ask' && !onceOnly && !this.unacknowledgedChanges.has(tool)) {
      effect = grant
      call.decidedBy = 'user'
    }

    if (effect === 'ask') {
      call.status = 'awaiting-approval'
      this.persist(call)
      this.opts.control.send({ t: 'call.start', call })

      this.awaitingCalls.add(id)
      let decided: Awaited<ReturnType<Interceptor['askUser']>>
      try { decided = await this.askUser(call, onceOnly) } finally { this.awaitingCalls.delete(id) }
      if (this.cancelledCalls.delete(id)) {
        call.status = 'cancelled'
        call.endedAt = Date.now()
        call.durationMs = call.endedAt - call.startedAt
        this.persist(call)
        this.opts.control.send({ t: 'call.end', call })
        return
      }
      effect = decided.effect
      call.decidedBy = decided.by
    } else {
      call.decidedBy = call.decidedBy ?? (verdict.ruleId ? 'policy' : 'default')
    }

    // A pause made while an approval was open must win over that approval.
    if (this.opts.db) this.settings = repo.readSettings(this.opts.db)
    if (this.settings.pauseToolCalls) effect = 'deny'
    call.decision = effect

    if (effect === 'deny') {
      call.status = 'denied'
      call.endedAt = Date.now()
      call.durationMs = call.endedAt - call.startedAt
      this.persist(call)
      this.opts.control.send({ t: 'call.end', call })
      this.opts.toClient({
        jsonrpc: '2.0',
        id: msg.id,
        error: {
          code: ErrorCodes.PolicyDenied,
          message: this.settings.pauseToolCalls ? 'Blocked by Bridge: tool calls are paused. Provider credentials have not been revoked.' : credentialGate ? 'Blocked by Bridge: the arguments contain a possible credential and this call was not approved.' : `Blocked by Bridge${verdict.ruleName ? ` (rule: ${verdict.ruleName})` : ''}. The user did not authorise this call.`,
          data: { tool, serverId: this.opts.server.id, ruleId: verdict.ruleId }
        }
      })
      return
    }

    call.status = 'pending'
    this.persist(call)
    this.opts.control.send({ t: 'call.start', call })
    this.inFlight.set(id, { call, startedAt: Date.now(), redactPatterns: verdict.redactResult })
    this.forwarded.add(id)
    this.opts.upstream.send(msg)
  }

  private async askUser(call: CallRecord, onceOnly = false): Promise<{ effect: PolicyEffect; by: CallRecord['decidedBy'] }> {
    const request: ApprovalRequest = {
      onceOnly,
      id: `apr_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      sessionId: this.opts.sessionId,
      serverId: this.opts.server.id,
      serverName: this.opts.server.name,
      tool: call.tool ?? 'unknown',
      args: call.args,
      findings: call.findings,
      ruleId: call.ruleId,
      requestedAt: Date.now(),
      timeoutMs: this.settings.approvalTimeoutMs
    }

    const result = await this.opts.control.requestApproval(request)

    if (!result) {
      const fallback = onceOnly ? 'deny' : this.settings.offlineAskFallback
      this.opts.log(`no approval available for ${call.tool}; applying fallback "${fallback}"`)
      return { effect: fallback, by: 'offline' }
    }

    if (!onceOnly && result.scope === 'session') {
      this.sessionGrants.set(call.tool ?? '', result.effect)
    } else if (!onceOnly && result.scope === 'always' && this.opts.db) {
      this.persistGrantRule(call.tool ?? '', result.effect)
    }
    if (call.tool) this.unacknowledgedChanges.delete(call.tool)

    return { effect: result.effect === 'allow' ? 'allow' : 'deny', by: 'user' }
  }

  private persistGrantRule(tool: string, effect: 'allow' | 'deny'): void {
    if (!this.opts.db || !tool) return
    const now = Date.now()
    const rule: PolicyRule = {
      id: `grant_${this.opts.server.id}_${tool}`.slice(0, 80),
      enabled: true,
      priority: 5,
      name: `${effect === 'allow' ? 'Always allow' : 'Always block'} ${tool}`,
      description: `Created from an approval prompt on ${new Date(now).toLocaleString()}.`,
      match: { serverId: this.opts.server.id, tool, method: 'tools/call' },
      effect,
      createdAt: now,
      updatedAt: now
    }
    try {
      repo.upsertRule(this.opts.db, rule)
      this.rules = repo.listRules(this.opts.db)
    } catch (err) {
      this.opts.log(`failed to persist grant: ${(err as Error).message}`)
    }
  }

  /* ----------------------------- server → client ---------------------------- */

  handleFromServer(msg: JsonRpcMessage): void {
    if (!isResponse(msg)) {
      this.opts.toClient(msg)
      return
    }

    const id = String(msg.id)
    if (!this.forwarded.delete(id)) {
      this.opts.log(`dropped a response for request ${id}, which was never sent to this server`)
      return
    }

    if (this.initRequests.delete(id) && msg.result) {
      const info = {
        name: msg.result.serverInfo?.name,
        version: msg.result.serverInfo?.version,
        protocolVersion: msg.result.protocolVersion
      }
      if (this.opts.db) repo.setSessionInfo(this.opts.db, this.opts.sessionId, info)
      this.opts.control.send({ t: 'session.info', sessionId: this.opts.sessionId, serverInfo: info })

      // Bridge can change the visible tool list at any time, so the connection
      // supports listChanged even when the upstream server does not.
      const patched = {
        ...msg,
        result: {
          ...msg.result,
          capabilities: {
            ...msg.result.capabilities,
            tools: { ...(msg.result.capabilities?.tools ?? {}), listChanged: true }
          }
        }
      }
      this.opts.toClient(patched as JsonRpcMessage)
      return
    }

    if (this.listRequests.delete(id) && Array.isArray(msg.result?.tools)) {
      const all = msg.result.tools as Array<{ name: string }>
      // Record everything the server offers, then show the client only what the
      // user left switched on. Hidden tools cost no context and cannot be called.
      this.recordToolInventory(all as never)
      const visible = all.filter((t) => !this.disabledTools.has(t.name))
      if (visible.length !== all.length) {
        this.opts.log(`hiding ${all.length - visible.length} of ${all.length} tools from the client`)
      }
      this.opts.toClient({ ...msg, result: { ...msg.result, tools: visible } } as JsonRpcMessage)
      return
    }

    const pending = this.inFlight.get(id)
    if (!pending) {
      this.opts.toClient(msg)
      return
    }
    this.inFlight.delete(id)
    this.completeCall(pending, msg)
  }

  private completeCall(pending: InFlight, msg: JsonRpcMessage & { result?: any; error?: any }): void {
    const { call } = pending
    const endedAt = Date.now()
    call.endedAt = endedAt
    call.durationMs = endedAt - pending.startedAt

    if (msg.error) {
      call.status = 'failed'
      call.error = msg.error
      this.persist(call)
      this.opts.control.send({ t: 'call.end', call })
      this.opts.toClient(msg)
      return
    }

    let result = msg.result
    const text = extractText(result)
    call.resultBytes = Buffer.byteLength(JSON.stringify(result ?? null), 'utf8')
    call.tokenEstimate = estimateTokens(text)

    const resultFindings = scanResult(result, this.settings)
    call.findings = [...call.findings, ...resultFindings]

    // MCP signals tool-level failure with isError rather than a JSON-RPC error.
    call.status = result?.isError ? 'failed' : 'completed'

    const shouldRedact =
      pending.redactPatterns.length > 0 ||
      (this.settings.redactOnFinding && resultFindings.some((f) => f.severity !== 'low'))

    if (shouldRedact) {
      const { value, changed } = redactResult(result, pending.redactPatterns)
      result = value
      call.redacted = changed
    }

    // The trace keeps what the server sent (after redaction); the model gets
    // the shaped version, and `shaping` records the difference.
    call.result = result
    const delivered = this.shapeForModel(call, result, text)
    this.persist(call)
    this.opts.control.send({ t: 'call.end', call })

    const high = resultFindings.filter((f) => f.severity === 'high')
    if (high.length > 0) {
      this.opts.log(`flagged ${call.tool}: ${high.map((f) => f.label).join(', ')}`)
    }

    this.opts.toClient({ ...msg, result: delivered } as JsonRpcMessage)
  }

  /**
   * Trims an oversized result and notes a repeated one. Errors pass untouched:
   * a failure is short and the model needs all of it.
   */
  private shapeForModel(call: CallRecord, result: any, text: string): unknown {
    if (result?.isError) return result
    let delivered: any = result
    const shaping: NonNullable<CallRecord['shaping']> = {}

    const trimmed = trimResult(result, this.settings.maxResultTokens)
    if (trimmed.changed) {
      delivered = trimmed.value
      shaping.trimmedFromTokens = trimmed.fromTokens
      shaping.deliveredTokens = trimmed.toTokens
      this.opts.log(`trimmed ${call.tool} result from ~${trimmed.fromTokens} to ~${trimmed.toTokens} tokens`)
    }

    if (this.settings.annotateRepeats && call.tool) {
      const count = this.repeats.observe(call.tool, call.args, text)
      if (count >= REPEAT_THRESHOLD && Array.isArray(delivered?.content)) {
        delivered = { ...delivered, content: [...delivered.content, repeatNote(call.tool, count)] }
        shaping.repeatCount = count
      }
    }

    call.shaping = Object.keys(shaping).length > 0 ? shaping : null
    return delivered
  }

  private recordToolInventory(tools: Array<{ name: string; description?: string; inputSchema?: unknown }>): void {
    const incoming = tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      schema: t.inputSchema ?? null,
      fingerprint: fingerprint(t)
    }))

    if (!this.opts.db) return
    try {
      const { tools: stored, changed } = repo.reconcileTools(this.opts.db, this.opts.server.id, incoming)
      for (const name of changed) this.unacknowledgedChanges.add(name)
      if (changed.length > 0) {
        this.opts.log(`tool definitions changed: ${changed.join(', ')}`)
      }
      this.opts.control.send({ t: 'tools.updated', serverId: this.opts.server.id, tools: stored, changed })
    } catch (err) {
      this.opts.log(`tool inventory write failed: ${(err as Error).message}`)
    }
  }

  /* -------------------------------- lifecycle ------------------------------- */

  private finishCancelled(requestId: string): void {
    // A late answer to a cancelled request is not wanted by anyone.
    this.forwarded.delete(requestId)
    if (this.awaitingCalls.has(requestId)) this.cancelledCalls.add(requestId)
    const pending = this.inFlight.get(requestId)
    if (!pending) return
    this.inFlight.delete(requestId)
    pending.call.status = 'cancelled'
    pending.call.endedAt = Date.now()
    pending.call.durationMs = pending.call.endedAt - pending.startedAt
    this.persist(pending.call)
    this.opts.control.send({ t: 'call.end', call: pending.call })
  }

  /** Called when the upstream server dies with calls still outstanding. */
  failAllPending(reason: string): void {
    for (const id of this.awaitingCalls) this.cancelledCalls.add(id)
    for (const [id, pending] of this.inFlight) {
      pending.call.status = 'failed'
      pending.call.error = { code: ErrorCodes.InternalError, message: reason }
      pending.call.endedAt = Date.now()
      pending.call.durationMs = pending.call.endedAt - pending.startedAt
      this.persist(pending.call)
      this.opts.control.send({ t: 'call.end', call: pending.call })
      this.opts.toClient({
        jsonrpc: '2.0',
        id: Number.isNaN(Number(id)) ? id : Number(id),
        error: { code: ErrorCodes.InternalError, message: reason }
      })
    }
    this.inFlight.clear()
    this.forwarded.clear()
  }

  private persist(call: CallRecord): void {
    if (!this.opts.db) return
    try {
      repo.saveCall(this.opts.db, call, {
        storePayloads: this.settings.storePayloads,
        maxBytes: this.settings.maxPayloadBytes
      })
    } catch (err) {
      this.opts.log(`db write failed: ${(err as Error).message}`)
    }
  }
}

export const __test = { fingerprint, estimateTokens }
