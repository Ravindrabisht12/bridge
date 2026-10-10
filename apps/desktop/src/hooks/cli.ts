/**
 * Bridge hook — the `PreToolUse` command Claude Code runs before a native tool.
 *
 *   bridge-hook          # reads the hook payload on stdin, prints a decision
 *
 * It is a proxy with no upstream: it evaluates the same rules, honours the same
 * grants, records into the same trace, and prints Claude Code's decision shape
 * instead of forwarding a JSON-RPC message.
 *
 * It fails closed on purpose. A hook that cannot reach the policy database, or
 * whose evaluation throws, denies rather than allowing an unsupervised action —
 * the same trade the proxy makes. The one exception is a payload that is not a
 * tool decision at all, which is passed back as `ask` so Claude Code applies
 * its own settings rather than being blocked by a malformed event.
 */
import { randomUUID } from 'node:crypto'
import {
  HOOK_SERVER_ID,
  HOOK_SERVER_NAME,
  type HookInput,
  hookKey,
  hookOutput,
  hookToolName
} from '@shared/hook'
import { FileLogger } from '@shared/logger'
import type { ApprovalRequest, CallRecord, Settings } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import { openDatabase, type Db } from '../db'
import { completeHookCall, findPermittedHookCall } from '../db/hook-calls'
import { highestSeverity, scanResult } from '../scanners'
import { redactPayload } from '../scanners/redaction'
import * as repo from '../db/repo'
import { decide } from '../policy/decide'
import { ControlClient } from '../proxy/control-client'

/** Claude Code kills a hook that overruns, so leave room under its timeout. */
const APPROVAL_CEILING_MS = 110_000

/**
 * Writes the decision and waits for it to actually leave the process.
 *
 * stdout is a pipe here, so the write is asynchronous and `process.exit` would
 * truncate it — Claude Code would see an empty response and fall back to its
 * own settings, silently, on exactly the calls that needed a decision.
 */
async function emit(decision: 'allow' | 'deny' | 'ask', reason: string): Promise<void> {
  const line = JSON.stringify(hookOutput(decision, reason)) + '\n'
  await new Promise<void>((resolve) => {
    if (process.stdout.write(line)) resolve()
    else process.stdout.once('drain', () => resolve())
  })
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of process.stdin) {
    const buf = chunk as Buffer
    total += buf.length
    // A hook payload is small. A huge one is a bug or an attempt to exhaust us.
    if (total > 2 * 1024 * 1024) throw new Error('hook payload too large')
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Whether a tool's own response reports a failure.
 *
 * Deliberately conservative: only a positive signal counts. `PostToolUse`
 * firing at all means the tool ran, so the absence of an error marker means
 * "ran, and nothing said otherwise" — not "verified successful". The raw
 * response is stored either way, which is what a post-mortem actually reads.
 */
/**
 * The hook is one process per tool call, so there is no long-lived session to
 * join. Claude Code's own session id is the honest grouping key, and it is a
 * client assertion rather than a verified identity — the same status as
 * `clientInfo` on the MCP path.
 */
function hookSessionId(raw: string | undefined): string {
  return `hook_${(raw ?? 'unknown').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)}`
}

function looksFailed(response: unknown): boolean {
  if (!response || typeof response !== 'object') return false
  const record = response as Record<string, unknown>
  if (record.is_error === true || record.isError === true) return true
  if (record.interrupted === true) return true
  for (const key of ['exit_code', 'exitCode', 'returncode', 'status']) {
    const value = record[key]
    if (typeof value === 'number' && value !== 0) return true
  }
  if (typeof record.error === 'string' && record.error.trim()) return true
  return false
}

/**
 * Attaches the outcome to the record `PreToolUse` opened.
 *
 * Nothing is created here. A `PostToolUse` with no matching open record — the
 * hook was installed mid-session, or enforcement was switched on between the
 * two halves — is logged and dropped, because inventing a record for a call
 * Bridge never decided would put activity in the trace it cannot vouch for.
 */
function recordOutcome(db: Db, log: FileLogger, settings: Settings, input: HookInput): void {
  const tool = hookToolName(input.tool_name ?? '', input.tool_input)
  const sessionId = hookSessionId(input.session_id)
  const key = hookKey(sessionId, tool, input.tool_input)

  const open = findPermittedHookCall(db, key)
  if (!open) {
    log.debug(`no permitted record for ${tool}; outcome dropped`)
    return
  }

  const response = input.tool_response ?? null
  const findings = scanResult(response, settings)
  const stored = settings.storePayloads ? JSON.stringify(redactPayload(response)) ?? null : null
  const clipped =
    stored && stored.length > settings.maxPayloadBytes
      ? JSON.stringify({ _bridgeTruncated: true, bytes: stored.length, preview: stored.slice(0, settings.maxPayloadBytes) })
      : stored

  const ok = completeHookCall(db, open.id, {
    status: looksFailed(response) ? 'failed' : 'completed',
    result: clipped,
    resultBytes: stored ? Buffer.byteLength(stored, 'utf8') : null,
    endedAt: Date.now(),
    findings: JSON.stringify(redactPayload(findings)),
    findingCount: findings.length,
    maxSeverity: highestSeverity(findings)
  })
  if (!ok) log.debug(`record ${open.id} was already finished; outcome dropped`)
}

async function main(): Promise<void> {
  const log = new FileLogger('hook')

  let input: HookInput
  try {
    const raw = await readStdin()
    input = raw.trim() ? (JSON.parse(raw) as HookInput) : {}
  } catch (err) {
    log.error(`unreadable hook payload: ${(err as Error).message}`)
    // Not a decision Bridge can make; let the client's own settings decide.
    await emit('ask', 'Bridge could not read the hook payload and made no decision.')
    return
  }

  const event = input.hook_event_name ?? 'PreToolUse'
  if (event !== 'PreToolUse' && event !== 'PostToolUse') {
    await emit('ask', `Bridge only handles PreToolUse and PostToolUse; "${event}" was passed through.`)
    return
  }
  if (!input.tool_name) {
    await emit('ask', 'Bridge received no tool name and made no decision.')
    return
  }

  let db: Db
  try {
    db = openDatabase()
  } catch (err) {
    log.error(`policy storage unavailable: ${(err as Error).message}`)
    await emit('deny', 'Bridge cannot reach its policy database, so this action was not authorised.')
    return
  }

  const tool = hookToolName(input.tool_name, input.tool_input)
  const args = input.tool_input ?? {}
  const now = Date.now()

  let settings: Settings = DEFAULT_SETTINGS
  try {
    settings = repo.readSettings(db)
  } catch (err) {
    log.error(`settings unreadable: ${(err as Error).message}`)
    await emit('deny', 'Bridge could not read its settings, so this action was not authorised.')
    return
  }

  if (!settings.claudeCodeHook) {
    await emit('ask', 'Bridge hook enforcement is switched off; the client decided this itself.')
    return
  }

  /*
   * `PostToolUse` is not a decision. It is the only moment Bridge can learn
   * what a call it permitted actually did, so it finishes the record and says
   * nothing back to the client.
   */
  if (event === 'PostToolUse') {
    recordOutcome(db, log, settings, input)
    return
  }

  const sessionId = hookSessionId(input.session_id)

  const call: CallRecord = {
    id: `call_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    sessionId,
    serverId: HOOK_SERVER_ID,
    serverName: HOOK_SERVER_NAME,
    client: 'claude-code',
    method: 'hook/PreToolUse',
    tool,
    args,
    result: null,
    error: null,
    status: 'pending',
    decision: null,
    decidedBy: null,
    ruleId: null,
    startedAt: now,
    endedAt: null,
    durationMs: null,
    resultBytes: null,
    tokenEstimate: null,
    findings: [],
    redacted: false,
    hookKey: hookKey(sessionId, tool, input.tool_input)
  }

  const persist = (): void => {
    try {
      repo.saveCall(db, call, {
        storePayloads: settings.storePayloads,
        maxBytes: settings.maxPayloadBytes
      })
    } catch (err) {
      log.error(`hook record write failed: ${(err as Error).message}`)
    }
  }

  const finish = async (
    decision: 'allow' | 'deny',
    reason: string,
    by: CallRecord['decidedBy']
  ): Promise<void> => {
    call.decision = decision
    call.decidedBy = by
    /*
     * Permitted, not completed.
     *
     * This runs before the tool does, so a success claim here would be
     * invented. `PostToolUse` moves the record on; if it never arrives — the
     * hook is only half-registered, or Claude Code was killed mid-command —
     * the record honestly stays "permitted" rather than reading as a success.
     */
    call.status = decision === 'deny' ? 'denied' : 'permitted'
    call.endedAt = Date.now()
    call.durationMs = call.endedAt - now
    persist()
    await emit(decision, reason)
  }

  let outcome: ReturnType<typeof decide>
  try {
    outcome = decide({
      settings,
      rules: repo.listRules(db),
      ctx: {
        serverId: HOOK_SERVER_ID,
        method: 'hook/PreToolUse',
        tool,
        args,
        clientName: 'claude-code'
      },
      sessionId,
      db,
      toolChanged: false,
      log: (line) => log.debug(line)
    })
  } catch (err) {
    log.error(`hook evaluation failed: ${(err as Error).message}`)
    call.findings = []
    await finish('deny', 'Bridge could not evaluate this action, so it was not authorised.', 'policy')
    return
  }

  call.findings = outcome.findings
  call.ruleId = outcome.ruleId

  if (outcome.effect === 'deny') {
    await finish(
      'deny',
      settings.pauseToolCalls
        ? 'Blocked by Bridge: tool calls are paused.'
        : `Blocked by Bridge${outcome.verdict.ruleName ? ` (rule: ${outcome.verdict.ruleName})` : ''}.`,
      'policy'
    )
    return
  }

  if (outcome.effect === 'allow') {
    await finish(
      'allow',
      outcome.grant
        ? `Allowed by a scoped permission: ${outcome.grant.label}. ${outcome.grant.remaining} uses left.`
        : 'Allowed by Bridge policy.',
      outcome.grant ? 'user' : outcome.verdict.ruleId ? 'policy' : 'default'
    )
    return
  }

  // Needs a person. Show the request in the Bridge UI and wait.
  call.status = 'awaiting-approval'
  persist()

  const control = new ControlClient((line) => log.debug(line))
  control.identify({
    id: sessionId,
    serverId: HOOK_SERVER_ID,
    serverName: HOOK_SERVER_NAME,
    client: 'claude-code',
    pid: process.pid,
    startedAt: now,
    endedAt: null,
    serverInfo: null,
    clientInfo: { name: 'claude-code', title: HOOK_SERVER_NAME }
  })
  control.connect()
  control.send({ t: 'call.start', call })

  const request: ApprovalRequest = {
    onceOnly: outcome.onceOnly,
    id: `apr_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
    sessionId,
    serverId: HOOK_SERVER_ID,
    serverName: HOOK_SERVER_NAME,
    tool,
    args,
    findings: call.findings,
    ruleId: call.ruleId,
    requestedAt: Date.now(),
    timeoutMs: Math.min(settings.approvalTimeoutMs, APPROVAL_CEILING_MS)
  }

  /*
   * Hold the event loop open while waiting.
   *
   * stdin has been consumed and every timer inside the control client is
   * unref'd — correct for the proxy, whose stdin keeps it alive, and fatal
   * here. Without a referenced handle Node finds nothing left to do and exits
   * 0 mid-wait, so Claude Code receives an empty response and quietly applies
   * its own settings to a call Bridge was meant to decide.
   */
  const keepAlive = setInterval(() => undefined, 500)
  let result: Awaited<ReturnType<ControlClient['requestApproval']>> = null
  try {
    // The socket connects asynchronously; give it a moment before deciding the
    // app is unreachable, or a freshly-started hook always falls back.
    const connected = await waitForConnection(control, 1_500)
    result = connected ? await control.requestApproval(request) : null
  } finally {
    clearInterval(keepAlive)
  }

  // A pause set while the prompt was open must win over the answer to it.
  try {
    settings = repo.readSettings(db)
  } catch {
    /* keep the settings already read */
  }

  let decision: 'allow' | 'deny'
  let by: CallRecord['decidedBy']
  if (settings.pauseToolCalls) {
    decision = 'deny'
    by = 'policy'
  } else if (!result) {
    // Strict mode and credential gates never auto-allow when nobody answered.
    decision = outcome.onceOnly ? 'deny' : settings.offlineAskFallback
    by = 'offline'
  } else {
    decision = result.effect
    by = 'user'
  }

  control.send({ t: 'call.end', call })
  control.close()

  await finish(
    decision,
    decision === 'allow'
      ? by === 'user'
        ? 'Approved in Bridge.'
        : 'Allowed by the configured fallback.'
      : settings.pauseToolCalls
        ? 'Blocked by Bridge: tool calls are paused.'
        : by === 'offline'
          ? 'Blocked by Bridge: no approval was available.'
          : 'Blocked in Bridge.',
    by
  )
}

function waitForConnection(control: ControlClient, timeoutMs: number): Promise<boolean> {
  if (control.online) return Promise.resolve(true)
  return new Promise((resolve) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (control.online) {
        clearInterval(timer)
        resolve(true)
      } else if (Date.now() - started >= timeoutMs) {
        clearInterval(timer)
        resolve(false)
      }
    }, 50)
  })
}

void main().then(
  () => process.exit(0),
  (err) => {
    // Nothing above should throw, but an unauthorised action must never be the
    // result of a crash in the thing that authorises it.
    try {
      new FileLogger('hook').error(`hook failed: ${(err as Error).stack ?? String(err)}`)
    } catch {
      /* logging is best effort */
    }
    void emit('deny', 'Bridge failed while checking this action, so it was not authorised.').then(
      () => process.exit(0),
      () => process.exit(0)
    )
  }
)
