import type { PolicyEffect, PolicyRule } from '@shared/types'
import { globMatch, readPath, safeRegExp, stringify } from './matcher'

export interface PolicyContext {
  serverId: string
  method: string
  tool: string | null
  args: unknown
  /** `clientInfo.name` from initialize, when the client supplied one. */
  clientName?: string | null
}

export interface PolicyDecision {
  effect: PolicyEffect
  ruleId: string | null
  ruleName: string | null
  /** Result-side redaction patterns contributed by the winning rule. */
  redactResult: string[]
}

/** A `re:` pattern (or an `argMatches` regex) that does not compile. */
const brokenPattern = (pattern: string | undefined, isRegex = false): boolean =>
  !!pattern && (isRegex || pattern.startsWith('re:')) && safeRegExp(isRegex ? pattern : pattern.slice(3)) === null

/**
 * Whether a rule applies. A pattern that does not compile fails closed: it
 * counts as matching for a block or ask rule — a broken "block .env" rule
 * must not silently block nothing — and as not matching for an allow rule.
 */
export function ruleMatches(rule: PolicyRule, ctx: PolicyContext): boolean {
  if (!rule.enabled) return false
  const m = rule.match
  const failClosed = rule.effect !== 'allow'
  const glob = (pattern: string | undefined, value: string | null): boolean =>
    brokenPattern(pattern) ? failClosed : globMatch(pattern, value)

  if (m.serverId && m.serverId !== '*' && m.serverId !== ctx.serverId) return false
  if (m.clientName && m.clientName !== '*' && !glob(m.clientName, ctx.clientName ?? null)) return false
  if (!glob(m.method ?? 'tools/call', ctx.method)) return false
  if (!glob(m.tool, ctx.tool)) return false

  if (m.argMatches) {
    const re = safeRegExp(m.argMatches)
    if (!re) return failClosed
    const target = m.argPath ? readPath(ctx.args, m.argPath) : ctx.args
    if (target === undefined) return false
    if (!re.test(stringify(target))) return false
  } else if (m.argPath) {
    // A path with no regex means "this argument is present at all".
    if (readPath(ctx.args, m.argPath) === undefined) return false
  }

  return true
}

/**
 * First match wins, ordered by ascending priority then creation time.
 * A rule list that matches nothing falls through to `defaultEffect`.
 */
export function evaluate(
  rules: readonly PolicyRule[],
  ctx: PolicyContext,
  defaultEffect: PolicyEffect
): PolicyDecision {
  const ordered = [...rules].sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt)
  for (const rule of ordered) {
    if (ruleMatches(rule, ctx)) {
      return {
        effect: rule.effect,
        ruleId: rule.id,
        ruleName: rule.name,
        redactResult: rule.redactResult ?? []
      }
    }
  }
  return { effect: defaultEffect, ruleId: null, ruleName: null, redactResult: [] }
}

/** The strictest of two effects, used when several signals want a say. */
export function strictest(a: PolicyEffect, b: PolicyEffect): PolicyEffect {
  const rank: Record<PolicyEffect, number> = { allow: 0, ask: 1, deny: 2 }
  return rank[a] >= rank[b] ? a : b
}
