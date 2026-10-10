import { redactPayload } from '../scanners/redaction'
import { createHash, randomUUID } from 'node:crypto'
import type {
  CallQuery,
  CallRecord,
  ClientId,
  ManagedServer,
  PolicyRule,
  SessionRecord,
  Settings,
  StatsSummary,
  ToolRecord,
  UpstreamTarget
} from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import { highestSeverity } from '../scanners'
import type { Db } from './index'

const json = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v))
const parse = <T>(v: string | null | undefined, fallback: T): T => {
  if (v === null || v === undefined) return fallback
  try {
    return JSON.parse(v) as T
  } catch {
    return fallback
  }
}

export const newId = (prefix: string): string => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`

/**
 * A server's id is derived from what actually identifies it — the client it
 * belongs to and its name in that client's config — rather than minted at
 * random.
 *
 * This matters because the id is baked into the AI client's config file. A
 * random id means removing and re-adding a server produces a *different* id,
 * silently invalidating any config the client has already read, which surfaces
 * to the user as an opaque "Server disconnected". A derived id makes
 * remove/re-add idempotent: the same server always resolves to the same id, so
 * a stale config keeps working and tool preferences survive.
 */
export function serverIdFor(client: string, name: string): string {
  const digest = createHash('sha256').update(`${client}\u0000${name}`).digest('hex')
  return `srv_${digest.slice(0, 20)}`
}

/* ------------------------------- settings -------------------------------- */

export function readSettings(db: Db): Settings {
  const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS }
  for (const row of rows) out[row.key] = parse(row.value, undefined as unknown)
  return out as unknown as Settings
}

export function writeSettings(db: Db, patch: Partial<Settings>): Settings {
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
  const tx = db.transaction((entries: Array<[string, unknown]>) => {
    for (const [key, value] of entries) stmt.run(key, JSON.stringify(value))
  })
  tx(Object.entries(patch))
  return readSettings(db)
}

/* -------------------------------- servers -------------------------------- */

interface ServerRow {
  id: string
  name: string
  client: string
  target: string
  enabled: number
  installed: number
  catalogue_key: string | null
  created_at: number
  updated_at: number
}

const toServer = (r: ServerRow): ManagedServer => ({
  id: r.id,
  name: r.name,
  client: r.client as ClientId,
  target: parse<UpstreamTarget>(r.target, { kind: 'stdio', command: '', args: [] }),
  enabled: !!r.enabled,
  installed: !!r.installed,
  catalogueKey: r.catalogue_key ?? null,
  createdAt: r.created_at,
  updatedAt: r.updated_at
})

export function listServers(db: Db): ManagedServer[] {
  return (db.prepare('SELECT * FROM servers ORDER BY name').all() as ServerRow[]).map(toServer)
}

export function getServer(db: Db, id: string): ManagedServer | null {
  const row = db.prepare('SELECT * FROM servers WHERE id = ?').get(id) as ServerRow | undefined
  return row ? toServer(row) : null
}

export function upsertServer(
  db: Db,
  input: Omit<ManagedServer, 'createdAt' | 'updatedAt'> & Partial<Pick<ManagedServer, 'createdAt'>>
): ManagedServer {
  const now = Date.now()
  db.prepare(
    `INSERT INTO servers (id, name, client, target, enabled, installed, catalogue_key, created_at, updated_at)
     VALUES (@id, @name, @client, @target, @enabled, @installed, @catalogue_key, @created_at, @updated_at)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, client = excluded.client, target = excluded.target,
       enabled = excluded.enabled, installed = excluded.installed,
       catalogue_key = COALESCE(excluded.catalogue_key, servers.catalogue_key),
       updated_at = excluded.updated_at`
  ).run({
    id: input.id,
    name: input.name,
    client: input.client,
    target: JSON.stringify(input.target),
    enabled: input.enabled ? 1 : 0,
    installed: input.installed ? 1 : 0,
    catalogue_key: input.catalogueKey ?? null,
    created_at: input.createdAt ?? now,
    updated_at: now
  })
  return getServer(db, input.id)!
}

export function deleteServer(db: Db, id: string): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM tools WHERE server_id = ?').run(id)
    db.prepare('DELETE FROM servers WHERE id = ?').run(id)
  })
  tx()
}

/* -------------------------------- sessions ------------------------------- */

export function startSession(db: Db, session: SessionRecord): void {
  db.prepare(
    `INSERT OR REPLACE INTO sessions (id, server_id, server_name, client, pid, started_at, ended_at, server_info, client_info)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    session.id,
    session.serverId,
    session.serverName,
    session.client,
    session.pid,
    session.startedAt,
    session.endedAt,
    json(session.serverInfo),
    json(session.clientInfo)
  )
}

export function endSession(db: Db, sessionId: string, endedAt: number): void {
  db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(endedAt, sessionId)
}

export function setSessionInfo(db: Db, sessionId: string, info: SessionRecord['serverInfo']): void {
  db.prepare('UPDATE sessions SET server_info = ? WHERE id = ?').run(json(info), sessionId)
}

/** True when a pid names a process this user can see. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means it exists but belongs to another user — alive, not dead.
    return (err as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * Picks the open sessions whose process is gone. Pure, so the rule is testable
 * without a database: liveness is injected.
 */
export function selectDeadSessions<T extends { id: string; pid: number }>(
  open: readonly T[],
  isAlive: (pid: number) => boolean = isProcessAlive,
  selfPid = process.pid
): T[] {
  return open.filter(({ pid }) => {
    if (!pid || pid <= 0) return false
    // Never reap our own row, whatever the pid table says.
    if (pid === selfPid) return false
    return !isAlive(pid)
  })
}

/**
 * Closes sessions whose proxy process is gone. A proxy killed with SIGKILL —
 * force-quitting the AI client, a crash — never runs its shutdown path, so its
 * row would otherwise read as "live" forever.
 *
 * A recycled pid simply leaves the row open another round, which is the same
 * behaviour as before this check existed; it can never close a live session.
 */
export function reapDeadSessions(db: Db): number {
  const open = db.prepare('SELECT id, pid FROM sessions WHERE ended_at IS NULL').all() as Array<{
    id: string
    pid: number
  }>
  const dead = selectDeadSessions(open)
  if (dead.length === 0) return 0
  const now = Date.now()
  const stmt = db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?')
  const tx = db.transaction(() => {
    for (const { id } of dead) stmt.run(now, id)
  })
  tx()
  return dead.length
}

export function listActiveSessions(db: Db): SessionRecord[] {
  const rows = db
    .prepare('SELECT * FROM sessions WHERE ended_at IS NULL ORDER BY started_at DESC')
    .all() as any[]
  return rows.map((r) => ({
    id: r.id,
    serverId: r.server_id,
    serverName: r.server_name,
    client: r.client,
    pid: r.pid,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    serverInfo: parse(r.server_info, null),
    clientInfo: parse(r.client_info, null)
  }))
}

export function setSessionClientInfo(db: Db, sessionId: string, info: SessionRecord['clientInfo']): void {
  db.prepare('UPDATE sessions SET client_info = ? WHERE id = ?').run(json(info), sessionId)
}

/* --------------------------------- calls --------------------------------- */

const toCall = (r: any): CallRecord => ({
  id: r.id,
  sessionId: r.session_id,
  serverId: r.server_id,
  serverName: r.server_name,
  client: r.client,
  method: r.method,
  tool: r.tool,
  args: parse(r.args, null),
  result: parse(r.result, null),
  error: parse(r.error, null),
  status: r.status,
  decision: r.decision,
  decidedBy: r.decided_by,
  ruleId: r.rule_id,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  durationMs: r.duration_ms,
  resultBytes: r.result_bytes,
  tokenEstimate: r.token_estimate,
  findings: parse(r.findings, []),
  redacted: !!r.redacted,
  shaping: parse(r.shaping, null)
})

export function saveCall(db: Db, call: CallRecord, opts: { storePayloads: boolean; maxBytes: number }): void {
  const clip = (value: unknown): string | null => {
    if (!opts.storePayloads || value === null || value === undefined) return null
    const text = JSON.stringify(redactPayload(value))
    if (text === undefined) return null
    return text.length > opts.maxBytes
      ? JSON.stringify({ _bridgeTruncated: true, bytes: text.length, preview: text.slice(0, opts.maxBytes) })
      : text
  }

  db.prepare(
    `INSERT INTO calls (
       id, session_id, server_id, server_name, client, method, tool, args, result, error,
       status, decision, decided_by, rule_id, started_at, ended_at, duration_ms,
       result_bytes, token_estimate, findings, finding_count, max_severity, redacted, hook_key, shaping
     ) VALUES (
       @id, @session_id, @server_id, @server_name, @client, @method, @tool, @args, @result, @error,
       @status, @decision, @decided_by, @rule_id, @started_at, @ended_at, @duration_ms,
       @result_bytes, @token_estimate, @findings, @finding_count, @max_severity, @redacted, @hook_key, @shaping
     )
     ON CONFLICT(id) DO UPDATE SET
       result = excluded.result, error = excluded.error, status = excluded.status,
       decision = excluded.decision, decided_by = excluded.decided_by, rule_id = excluded.rule_id,
       ended_at = excluded.ended_at, duration_ms = excluded.duration_ms,
       result_bytes = excluded.result_bytes, token_estimate = excluded.token_estimate,
       findings = excluded.findings, finding_count = excluded.finding_count,
       max_severity = excluded.max_severity, redacted = excluded.redacted,
       hook_key = excluded.hook_key, shaping = excluded.shaping`
  ).run({
    id: call.id,
    session_id: call.sessionId,
    server_id: call.serverId,
    server_name: call.serverName,
    client: call.client,
    method: call.method,
    tool: call.tool,
    args: clip(call.args),
    result: clip(call.result),
    error: clip(call.error),
    status: call.status,
    decision: call.decision,
    decided_by: call.decidedBy,
    rule_id: call.ruleId,
    started_at: call.startedAt,
    ended_at: call.endedAt,
    duration_ms: call.durationMs,
    result_bytes: call.resultBytes,
    token_estimate: call.tokenEstimate,
    findings: JSON.stringify(redactPayload(call.findings)),
    finding_count: call.findings.length,
    max_severity: highestSeverity(call.findings),
    redacted: call.redacted ? 1 : 0,
    hook_key: call.hookKey ?? null,
    shaping: call.shaping ? JSON.stringify(call.shaping) : null
  })
}

export function queryCalls(db: Db, q: CallQuery): CallRecord[] {
  const where: string[] = []
  const params: Record<string, unknown> = { limit: Math.min(q.limit ?? 200, 1000) }
  if (q.before) {
    where.push('started_at < @before')
    params.before = q.before
  }
  if (q.serverId) {
    where.push('server_id = @serverId')
    params.serverId = q.serverId
  }
  if (q.status) {
    where.push('status = @status')
    params.status = q.status
  }
  if (q.flaggedOnly) where.push('finding_count > 0')
  if (q.search) {
    where.push('(tool LIKE @search OR server_name LIKE @search OR args LIKE @search)')
    params.search = `%${q.search}%`
  }
  const sql = `SELECT * FROM calls ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC LIMIT @limit`
  return (db.prepare(sql).all(params) as any[]).map(toCall)
}

export function getCall(db: Db, id: string): CallRecord | null {
  const row = db.prepare('SELECT * FROM calls WHERE id = ?').get(id)
  return row ? toCall(row) : null
}

export function purgeOlderThan(db: Db, cutoff: number): number {
  const info = db.prepare('DELETE FROM calls WHERE started_at < ?').run(cutoff)
  db.prepare('DELETE FROM sessions WHERE ended_at IS NOT NULL AND ended_at < ?').run(cutoff)
  return info.changes
}

export function stats(db: Db): StatsSummary {
  const dayAgo = Date.now() - 86_400_000
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN started_at > ? THEN 1 ELSE 0 END) AS last24h,
              SUM(CASE WHEN status = 'denied' THEN 1 ELSE 0 END) AS denied,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN finding_count > 0 THEN 1 ELSE 0 END) AS flagged,
              AVG(duration_ms) AS avg_ms,
              SUM(token_estimate) AS tokens
       FROM calls`
    )
    .get(dayAgo) as any

  const byServer = db
    .prepare(
      `SELECT server_id, server_name, COUNT(*) AS calls,
              SUM(CASE WHEN finding_count > 0 THEN 1 ELSE 0 END) AS flagged
       FROM calls GROUP BY server_id ORDER BY calls DESC LIMIT 20`
    )
    .all() as any[]

  const byTool = db
    .prepare(
      `SELECT tool, COUNT(*) AS calls, AVG(duration_ms) AS avg_ms
       FROM calls WHERE tool IS NOT NULL GROUP BY tool ORDER BY calls DESC LIMIT 20`
    )
    .all() as any[]

  return {
    totalCalls: totals.total ?? 0,
    last24h: totals.last24h ?? 0,
    denied: totals.denied ?? 0,
    failed: totals.failed ?? 0,
    flagged: totals.flagged ?? 0,
    avgDurationMs: Math.round(totals.avg_ms ?? 0),
    tokensEstimated: totals.tokens ?? 0,
    byServer: byServer.map((r) => ({
      serverId: r.server_id,
      serverName: r.server_name,
      calls: r.calls,
      flagged: r.flagged
    })),
    byTool: byTool.map((r) => ({ tool: r.tool, calls: r.calls, avgMs: Math.round(r.avg_ms ?? 0) }))
  }
}

/* --------------------------------- tools --------------------------------- */

const TOOLS_SELECT = `
  SELECT t.*, COALESCE(p.enabled, 1) AS enabled
  FROM tools t
  LEFT JOIN tool_prefs p ON p.server_id = t.server_id AND p.name = t.name`

export function listTools(db: Db, serverId?: string): ToolRecord[] {
  const rows = serverId
    ? (db.prepare(`${TOOLS_SELECT} WHERE t.server_id = ? ORDER BY t.name`).all(serverId) as any[])
    : (db.prepare(`${TOOLS_SELECT} ORDER BY t.server_id, t.name`).all() as any[])
  return rows.map((r) => ({
    serverId: r.server_id,
    name: r.name,
    enabled: r.enabled !== 0,
    description: r.description,
    schema: parse(r.schema, null),
    revision: r.revision,
    fingerprint: r.fingerprint,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    changedAt: r.changed_at
  }))
}

/** Records the current inventory and returns the names whose definition moved. */
export function reconcileTools(
  db: Db,
  serverId: string,
  incoming: Array<{ name: string; description: string; schema: unknown; fingerprint: string }>
): { tools: ToolRecord[]; changed: string[] } {
  const now = Date.now()
  const existing = new Map(listTools(db, serverId).map((t) => [t.name, t]))
  const changed: string[] = []

  const tx = db.transaction(() => {
    for (const tool of incoming) {
      const prev = existing.get(tool.name)
      const didChange = !!prev && prev.fingerprint !== tool.fingerprint
      if (didChange) changed.push(tool.name)
      db.prepare(
        `INSERT INTO tools (server_id, name, description, schema, fingerprint, revision, first_seen_at, last_seen_at, changed_at)
         VALUES (@server_id, @name, @description, @schema, @fingerprint, @revision, @first_seen_at, @last_seen_at, @changed_at)
         ON CONFLICT(server_id, name) DO UPDATE SET
           description = excluded.description, schema = excluded.schema,
           fingerprint = excluded.fingerprint, revision = excluded.revision,
           last_seen_at = excluded.last_seen_at, changed_at = excluded.changed_at`
      ).run({
        server_id: serverId,
        name: tool.name,
        description: tool.description,
        schema: json(tool.schema),
        fingerprint: tool.fingerprint,
        revision: prev ? prev.revision + (didChange ? 1 : 0) : 1,
        first_seen_at: prev?.firstSeenAt ?? now,
        last_seen_at: now,
        changed_at: didChange ? now : (prev?.changedAt ?? null)
      })
    }
  })
  tx()

  return { tools: listTools(db, serverId), changed }
}

/* --------------------------------- rules --------------------------------- */

const toRule = (r: any): PolicyRule => ({
  id: r.id,
  enabled: !!r.enabled,
  priority: r.priority,
  name: r.name,
  description: r.description ?? undefined,
  match: parse(r.match, {}),
  effect: r.effect,
  redactResult: parse(r.redact, undefined),
  createdAt: r.created_at,
  updatedAt: r.updated_at
})

/**
 * How often each rule has decided a call. A policy page that cannot show this
 * is guesswork: a rule that never fires and a rule that blocks daily look
 * identical.
 */
export function ruleStats(db: Db): Array<{ ruleId: string; matches: number; lastMatchedAt: number }> {
  return db
    .prepare(
      `SELECT rule_id AS ruleId, COUNT(*) AS matches, MAX(started_at) AS lastMatchedAt
       FROM calls WHERE rule_id IS NOT NULL GROUP BY rule_id`
    )
    .all() as Array<{ ruleId: string; matches: number; lastMatchedAt: number }>
}

export function listRules(db: Db): PolicyRule[] {
  return (db.prepare('SELECT * FROM rules ORDER BY priority, created_at').all() as any[]).map(toRule)
}

export function upsertRule(db: Db, rule: PolicyRule): PolicyRule {
  const now = Date.now()
  db.prepare(
    `INSERT INTO rules (id, enabled, priority, name, description, match, effect, redact, created_at, updated_at)
     VALUES (@id, @enabled, @priority, @name, @description, @match, @effect, @redact, @created_at, @updated_at)
     ON CONFLICT(id) DO UPDATE SET
       enabled = excluded.enabled, priority = excluded.priority, name = excluded.name,
       description = excluded.description, match = excluded.match, effect = excluded.effect,
       redact = excluded.redact, updated_at = excluded.updated_at`
  ).run({
    id: rule.id,
    enabled: rule.enabled ? 1 : 0,
    priority: rule.priority,
    name: rule.name,
    description: rule.description ?? null,
    match: JSON.stringify(rule.match),
    effect: rule.effect,
    redact: json(rule.redactResult),
    created_at: rule.createdAt || now,
    updated_at: now
  })
  return toRule(db.prepare('SELECT * FROM rules WHERE id = ?').get(rule.id))
}

export function deleteRule(db: Db, id: string): void {
  db.prepare('DELETE FROM rules WHERE id = ?').run(id)
}

/* -------------------------------- grants --------------------------------- */

export function saveGrant(
  db: Db,
  grant: { sessionId: string; serverId: string; tool: string; scope: string; effect: string }
): void {
  db.prepare(
    `INSERT OR REPLACE INTO grants (session_id, server_id, tool, scope, effect, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(grant.sessionId, grant.serverId, grant.tool, grant.scope, grant.effect, Date.now())
}

export function clearSessionGrants(db: Db, sessionId: string): void {
  db.prepare('DELETE FROM grants WHERE session_id = ?').run(sessionId)
}

/* ------------------------------ tool prefs ------------------------------- */

/** Tool names the user has switched off for a server. */
export function disabledTools(db: Db, serverId: string): string[] {
  return (
    db.prepare('SELECT name FROM tool_prefs WHERE server_id = ? AND enabled = 0').all(serverId) as Array<{
      name: string
    }>
  ).map((r) => r.name)
}

export function setToolsEnabled(db: Db, serverId: string, names: readonly string[], enabled: boolean): void {
  const stmt = db.prepare(
    `INSERT INTO tool_prefs (server_id, name, enabled, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(server_id, name) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`
  )
  const now = Date.now()
  const tx = db.transaction(() => {
    for (const name of names) stmt.run(serverId, name, enabled ? 1 : 0, now)
  })
  tx()
}
