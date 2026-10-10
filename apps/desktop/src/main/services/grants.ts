/**
 * The one place a grant is created.
 *
 * Both entry points — approving a pending call, and pinning a scope from a
 * recorded one — land here, so the bounds cannot be enforced in one path and
 * forgotten in the other. The renderer proposes; this decides.
 */
import {
  type ActionGrant,
  type GrantSpec,
  describeGrant,
  validateGrantSpec
} from '@shared/action-grant'
import { looksLikeSecret } from '../../scanners/secrets'
import { createActionGrant } from '../../db/action-grants'
import type { Db } from '../../db'
import * as repo from '../../db/repo'

export interface GrantOrigin {
  serverId: string
  sessionId: string
  /** Tool the decision was made about; it must be inside the grant. */
  tool: string
}

/**
 * Validates a spec against its origin and stores it.
 *
 * Throws a message written for the user, because every caller surfaces it
 * directly in the UI.
 */
export function createGrantFromSpec(db: Db, origin: GrantOrigin, spec: GrantSpec): ActionGrant {
  const invalid = validateGrantSpec(spec, looksLikeSecret)
  if (invalid) throw new Error(invalid.message)

  // A grant is authorised by a decision about one tool. Letting it cover tools
  // the user was never asked about would turn one approval into a broader
  // permission than the prompt described.
  if (!spec.tools.includes(origin.tool)) {
    throw new Error(`A permission created from "${origin.tool}" must include that tool.`)
  }

  // Every other tool in the grant must at least exist on this server, so a
  // typo cannot silently create a permission that matches nothing — or a
  // guessed name that matches something later.
  const known = new Set(repo.listTools(db, origin.serverId).map((tool) => tool.name))
  if (known.size > 0) {
    const unknown = spec.tools.filter((tool) => !known.has(tool))
    if (unknown.length > 0) {
      throw new Error(`This server does not offer: ${unknown.join(', ')}.`)
    }
  }

  const now = Date.now()
  return createActionGrant(db, {
    sessionId: spec.bindSession ? origin.sessionId : null,
    serverId: origin.serverId,
    tools: spec.tools,
    constraints: spec.constraints,
    label: describeGrant(spec),
    expiresAt: now + spec.minutes * 60_000,
    remaining: spec.maxCalls
  })
}

/** Creates a grant from a stored call record, for the Trace and Security views. */
export function createGrantFromCall(db: Db, callId: string, spec: GrantSpec): ActionGrant {
  if (typeof callId !== 'string' || !callId || callId.length > 100) {
    throw new Error('Choose a recorded call.')
  }
  const call = repo.getCall(db, callId)
  if (!call?.tool) throw new Error('That record has no tool call to scope.')
  if (call.args === null || call.args === undefined) {
    throw new Error('That record has no stored arguments, so a scope cannot be checked against it.')
  }
  if (call.findings.some((finding) => finding.type === 'secret' || finding.type === 'pii')) {
    throw new Error('That call carried a credential or personal data. Approve it individually instead.')
  }
  // A session-bound grant is only meaningful while that session is alive.
  if (spec.bindSession && !repo.listActiveSessions(db).some((session) => session.id === call.sessionId)) {
    throw new Error('That proxy session has ended, so a session-bound permission would authorise nothing.')
  }
  return createGrantFromSpec(db, { serverId: call.serverId, sessionId: call.sessionId, tool: call.tool }, spec)
}
