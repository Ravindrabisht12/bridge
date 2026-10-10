/**
 * A grant is a bounded permission: these tools, on this server, with arguments
 * satisfying these constraints, for this long, this many times.
 *
 * The previous design matched a SHA-256 digest of every argument, which only
 * ever matched a literal retry — real work never repeats identical arguments,
 * so it reduced approval fatigue by zero. Constraints let a grant cover the
 * work the user actually authorised ("this site, these operations") while still
 * blocking the work they did not.
 */

import { globMatch, readPath, stringify } from '../policy/matcher'

export type ConstraintOp = 'eq' | 'in' | 'glob' | 'absent' | 'any'

export interface GrantConstraint {
  /** Dot path into the arguments object, e.g. `site` or `target.url`. */
  path: string
  op: ConstraintOp
  /** Comparison values. Unused by `absent` and `any`. */
  values: string[]
}

export interface ActionGrant {
  id: string
  /**
   * Proxy session this is pinned to, or null to survive a client restart
   * within the expiry. A task outlives the process running it, so binding to
   * a session used to kill the grant at the worst possible moment.
   */
  sessionId: string | null
  serverId: string
  /** Exact tool names, not globs: the user approves a readable list. */
  tools: string[]
  constraints: GrantConstraint[]
  /** Plain-language scope, rendered once at creation and kept as evidence. */
  label: string
  expiresAt: number
  remaining: number
  revokedAt: number | null
  createdAt: number
}

export interface GrantSpec {
  minutes: number
  maxCalls: number
  tools: string[]
  constraints: GrantConstraint[]
  /** Pin to the originating proxy session. Off by default. */
  bindSession?: boolean
}

export interface CreateActionGrant extends GrantSpec {
  /** Recorded call to derive server, tool and session from. */
  callId: string
}

/** Bounds enforced wherever a grant is created. A grant is never unbounded. */
export const GRANT_LIMITS = {
  minMinutes: 1,
  maxMinutes: 1440,
  minCalls: 1,
  maxCalls: 500,
  maxTools: 10,
  maxConstraints: 12,
  maxValues: 20,
  maxPathLength: 100,
  maxValueLength: 200
} as const

export const CONSTRAINT_OPS: ConstraintOp[] = ['eq', 'in', 'glob', 'absent', 'any']

/** Longest a proposed value may be and still read as a display value. */
const DISPLAY_VALUE = 60

/**
 * Whether a value looks like something that *identifies* what a call targets —
 * a host, an id, a status, a path — rather than the payload it carries.
 *
 * This is the line the whole design rests on. Pin a payload and the grant only
 * ever matches a byte-identical repeat, which is the exact-digest failure the
 * predicate model replaced. So the test is deliberately strict: identifiers are
 * short, single-line, and usually unspaced. Anything prose-shaped arrives
 * unpinned, and the user can always narrow it by hand.
 */
export function looksLikeIdentifier(value: string): boolean {
  if (!value || value.length > 80) return false
  if (/[\r\n\t]/.test(value)) return false
  // Spaces are the tell for prose. A little is fine; a sentence is not.
  if (/\s/.test(value) && value.length > 40) return false
  return true
}

/**
 * Whether one constraint holds for a call's arguments.
 *
 * Comparison is on the stringified value, so an object or array at the path is
 * compared as its JSON text. That is honest rather than clever: what you see in
 * the grant is what is compared.
 *
 * `eq`, `in` and `glob` all require the value to be *present*. An argument the
 * agent omits therefore fails a pinned constraint and falls back to a prompt,
 * which is the safe direction.
 */
export function constraintSatisfied(constraint: GrantConstraint, args: unknown): boolean {
  const value = readPath(args, constraint.path)
  const missing = value === undefined || value === null

  switch (constraint.op) {
    case 'any':
      return true
    case 'absent':
      return missing
    case 'eq':
      return !missing && stringify(value) === constraint.values[0]
    case 'in':
      return !missing && constraint.values.includes(stringify(value))
    case 'glob':
      // Anchored, case-insensitive; `*` spans separators, so a path scope must
      // be written out (`/srv/site/*`) rather than assumed.
      return !missing && constraint.values.some((pattern) => globMatch(pattern, stringify(value)))
    default:
      // An op this build does not understand must never authorise a call.
      return false
  }
}

export interface GrantMatchContext {
  serverId: string
  sessionId: string
  tool: string
  args: unknown
}

/** Every dimension must hold. A grant with no constraints covers any arguments. */
export function grantMatches(grant: ActionGrant, ctx: GrantMatchContext, now: number): boolean {
  if (grant.revokedAt !== null) return false
  if (grant.expiresAt <= now) return false
  if (grant.remaining <= 0) return false
  if (grant.serverId !== ctx.serverId) return false
  if (grant.sessionId !== null && grant.sessionId !== ctx.sessionId) return false
  if (!grant.tools.includes(ctx.tool)) return false
  return grant.constraints.every((constraint) => constraintSatisfied(constraint, ctx.args))
}

/** The first constraint that fails, so a block can say which bound was crossed. */
export function failedConstraint(grant: ActionGrant, args: unknown): GrantConstraint | null {
  return grant.constraints.find((constraint) => !constraintSatisfied(constraint, args)) ?? null
}

/** Keeps one long value from swallowing the whole scope summary. */
function short(value: string): string {
  return value.length > DISPLAY_VALUE ? `${value.slice(0, DISPLAY_VALUE - 1)}…` : value
}

export function describeConstraint(constraint: GrantConstraint): string {
  const list = constraint.values.slice(0, 4).map(short).join(', ')
  const more = constraint.values.length > 4 ? ` +${constraint.values.length - 4} more` : ''
  switch (constraint.op) {
    case 'any':
      return `${constraint.path}: any value`
    case 'absent':
      return `${constraint.path}: not set`
    case 'eq':
      return `${constraint.path} = ${short(constraint.values[0] ?? '')}`
    case 'in':
      return `${constraint.path} is one of ${list}${more}`
    case 'glob':
      return `${constraint.path} matches ${list}${more}`
    default:
      return `${constraint.path}: unrecognised condition`
  }
}

/** One line a user can read back and recognise as what they authorised. */
export function describeGrant(spec: {
  tools: string[]
  constraints: GrantConstraint[]
  minutes: number
  maxCalls: number
}): string {
  const pinned = spec.constraints.filter((constraint) => constraint.op !== 'any')
  const where = pinned.length ? pinned.map(describeConstraint).join(' · ') : 'any arguments'
  return `${spec.tools.join(', ')} — ${where} — ${spec.maxCalls} ${spec.maxCalls === 1 ? 'call' : 'calls'} within ${spec.minutes} min`
}

export interface GrantValidationError {
  message: string
}

/**
 * Rejects anything that would make a grant broader than a user can read, or
 * that would write a credential into the permission record. Applied in the main
 * process, so a compromised renderer cannot widen a grant past these bounds.
 */
export function validateGrantSpec(
  spec: GrantSpec,
  isSecretValue: (value: string) => boolean
): GrantValidationError | null {
  const L = GRANT_LIMITS

  if (!Number.isInteger(spec.minutes) || spec.minutes < L.minMinutes || spec.minutes > L.maxMinutes) {
    return { message: `Choose between ${L.minMinutes} and ${L.maxMinutes} minutes.` }
  }
  if (!Number.isInteger(spec.maxCalls) || spec.maxCalls < L.minCalls || spec.maxCalls > L.maxCalls) {
    return { message: `Choose between ${L.minCalls} and ${L.maxCalls} calls.` }
  }
  if (!Array.isArray(spec.tools) || spec.tools.length < 1 || spec.tools.length > L.maxTools) {
    return { message: `A grant covers between 1 and ${L.maxTools} named tools.` }
  }
  for (const tool of spec.tools) {
    if (typeof tool !== 'string' || !tool || tool.length > L.maxPathLength) {
      return { message: 'Every tool must be a name this server actually offers.' }
    }
  }
  if (new Set(spec.tools).size !== spec.tools.length) {
    return { message: 'The same tool is listed twice.' }
  }
  if (!Array.isArray(spec.constraints) || spec.constraints.length > L.maxConstraints) {
    return { message: `A grant carries at most ${L.maxConstraints} conditions.` }
  }

  const seen = new Set<string>()
  for (const constraint of spec.constraints) {
    if (!constraint || typeof constraint.path !== 'string' || !constraint.path || constraint.path.length > L.maxPathLength) {
      return { message: 'Every condition needs an argument path.' }
    }
    if (seen.has(constraint.path)) {
      return { message: `"${constraint.path}" carries two conditions; keep one.` }
    }
    seen.add(constraint.path)

    if (!CONSTRAINT_OPS.includes(constraint.op)) {
      return { message: `"${constraint.op}" is not a condition this build understands.` }
    }
    if (!Array.isArray(constraint.values)) {
      return { message: 'A condition needs a list of values.' }
    }

    const needsValues = constraint.op === 'eq' || constraint.op === 'in' || constraint.op === 'glob'
    if (needsValues && constraint.values.length < 1) {
      return { message: `"${constraint.path}" needs at least one value to compare.` }
    }
    if (constraint.op === 'eq' && constraint.values.length !== 1) {
      return { message: `"${constraint.path}" is an exact match, so it takes one value.` }
    }
    if (constraint.values.length > L.maxValues) {
      return { message: `"${constraint.path}" lists more than ${L.maxValues} values.` }
    }
    for (const value of constraint.values) {
      if (typeof value !== 'string' || value.length > L.maxValueLength) {
        return { message: `A value on "${constraint.path}" is not short text.` }
      }
      // A permission record is long-lived and shown in the UI. A credential
      // must never be pinned into one, even by a user who pastes it in.
      if (isSecretValue(value)) {
        return { message: `The value on "${constraint.path}" looks like a credential. Scope on an identifier instead.` }
      }
    }
  }

  return null
}

/**
 * Constraints to offer for a call the user is approving.
 *
 * Short scalars are pinned by default — they are the identifiers that decide
 * *what* the call touches (a site, a recipient, an id). Long text and
 * structures are offered unpinned, because they are the payload rather than the
 * target, and pinning them would recreate the exact-match grant that never
 * fired. Credential-shaped values are not offered at all.
 */
export function proposeConstraints(args: unknown, isSecretValue: (value: string) => boolean): GrantConstraint[] {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return []
  const out: GrantConstraint[] = []

  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (out.length >= GRANT_LIMITS.maxConstraints) break
    if (value === undefined) continue

    if (value === null) {
      out.push({ path: key, op: 'absent', values: [] })
      continue
    }
    if (typeof value === 'object') {
      out.push({ path: key, op: 'any', values: [] })
      continue
    }

    const text = stringify(value)
    if (!looksLikeIdentifier(text) || isSecretValue(text)) {
      out.push({ path: key, op: 'any', values: [] })
      continue
    }
    out.push({ path: key, op: 'eq', values: [text] })
  }

  return out
}
