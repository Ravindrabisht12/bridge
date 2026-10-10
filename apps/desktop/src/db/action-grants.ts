import { randomUUID } from 'node:crypto'
import { type ActionGrant, type GrantMatchContext, grantMatches } from '../shared/action-grant'
import type { Db } from './index'

interface Row {
  id: string
  session_id: string | null
  server_id: string
  tools: string
  constraints: string
  label: string
  expires_at: number
  remaining: number
  revoked_at: number | null
  created_at: number
}

const decode = (row: Row): ActionGrant => ({
  id: row.id,
  sessionId: row.session_id,
  serverId: row.server_id,
  tools: JSON.parse(row.tools) as string[],
  constraints: JSON.parse(row.constraints) as ActionGrant['constraints'],
  label: row.label,
  expiresAt: row.expires_at,
  remaining: row.remaining,
  revokedAt: row.revoked_at,
  createdAt: row.created_at
})

export function listActionGrants(db: Db): ActionGrant[] {
  const rows = db
    .prepare('SELECT * FROM action_grants ORDER BY created_at DESC LIMIT 200')
    .all() as Row[]
  return rows.map(decode)
}

export function getActionGrant(db: Db, id: string): ActionGrant | null {
  const row = db.prepare('SELECT * FROM action_grants WHERE id=?').get(id) as Row | undefined
  return row ? decode(row) : null
}

export function createActionGrant(
  db: Db,
  input: Omit<ActionGrant, 'id' | 'createdAt' | 'revokedAt'>
): ActionGrant {
  const grant: ActionGrant = {
    ...input,
    id: `permit_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    createdAt: Date.now(),
    revokedAt: null
  }
  db.prepare(
    `INSERT INTO action_grants
       (id, session_id, server_id, tools, constraints, label, expires_at, remaining, revoked_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`
  ).run(
    grant.id,
    grant.sessionId,
    grant.serverId,
    JSON.stringify(grant.tools),
    JSON.stringify(grant.constraints),
    grant.label,
    grant.expiresAt,
    grant.remaining,
    grant.createdAt
  )
  return grant
}

export function revokeActionGrant(db: Db, id: string, now = Date.now()): boolean {
  return (
    db.prepare('UPDATE action_grants SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(now, id)
      .changes === 1
  )
}

/**
 * Finds a live grant covering this call and claims one use of it.
 *
 * Constraint evaluation cannot be expressed in the SQL predicate, so live
 * candidates are narrowed in SQL and matched in JS. The claim is then a
 * conditional decrement inside an immediate transaction, keyed on the row's id:
 * several proxy processes share this database, so two concurrent calls must not
 * both consume the last remaining use. Losing that race falls through to the
 * next candidate rather than failing the call outright.
 *
 * Counts dispatch attempts, not successful business operations — an upstream
 * error still spends a use, because the request left the boundary.
 */
export function consumeActionGrant(
  db: Db,
  ctx: GrantMatchContext,
  now = Date.now()
): ActionGrant | null {
  const rows = db
    .prepare(
      `SELECT * FROM action_grants
        WHERE server_id=? AND revoked_at IS NULL AND expires_at>? AND remaining>0
          AND (session_id IS NULL OR session_id=?)
        ORDER BY expires_at ASC, id ASC`
    )
    .all(ctx.serverId, now, ctx.sessionId) as Row[]

  const claim = db.prepare(
    'UPDATE action_grants SET remaining=remaining-1 WHERE id=? AND remaining>0 AND revoked_at IS NULL AND expires_at>?'
  )

  for (const row of rows) {
    const grant = decode(row)
    if (!grantMatches(grant, ctx, now)) continue
    const won = db.transaction(() => claim.run(grant.id, now).changes === 1).immediate()
    if (won) return { ...grant, remaining: grant.remaining - 1 }
  }
  return null
}

/** Grants that could still authorise a call, for display and for triage. */
export function activeActionGrants(db: Db, now = Date.now()): ActionGrant[] {
  const rows = db
    .prepare(
      'SELECT * FROM action_grants WHERE revoked_at IS NULL AND expires_at>? AND remaining>0 ORDER BY expires_at ASC'
    )
    .all(now) as Row[]
  return rows.map(decode)
}

/** Removes grants that can no longer authorise anything and are a day stale. */
export function pruneActionGrants(db: Db, now = Date.now()): number {
  return db
    .prepare('DELETE FROM action_grants WHERE expires_at < ? AND created_at < ?')
    .run(now, now - 86_400_000).changes
}
