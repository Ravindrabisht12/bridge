/**
 * Turning a policy rule into a sentence.
 *
 * The rules list showed its raw matcher — `re:(exec|shell|bash|terminal|command
 * |run_code|python|eval)` — as the most prominent thing on every row. That is
 * the least readable and least scannable part of a rule, and it pushed the
 * thing a person actually wants (what does this do, and does it fire?) into the
 * margins. The pattern is still available; it just stops being the headline.
 */
import type { PolicyEffect, PolicyMatch } from './types'

/** Beyond this, a pattern is referred to rather than quoted. */
const MAX_INLINE_PATTERN = 44

export const EFFECT_VERB: Record<PolicyEffect, string> = {
  allow: 'Runs silently',
  ask: 'Asks first',
  deny: 'Is blocked'
}

/** Words out of a `re:(a|b|c)` alternation, for a readable list. */
export function alternatives(pattern: string): string[] {
  const body = pattern.startsWith('re:') ? pattern.slice(3) : pattern
  const group = /^\^?\(?([A-Za-z0-9_|-]+)\)?\$?$/.exec(body)
  if (!group) return []
  const parts = group[1]!.split('|').filter(Boolean)
  return parts.length > 1 ? parts : []
}

/** A readable phrase for a tool pattern. */
export function describeToolPattern(pattern: string | undefined): string {
  if (!pattern || pattern === '*' || pattern === '') return 'Any tool'

  const words = alternatives(pattern)
  if (words.length > 0) {
    const anchored = pattern.startsWith('re:^')
    const lead = anchored ? 'Tools starting with' : 'Tools mentioning'
    const shown = words.slice(0, 4).join(', ')
    const more = words.length > 4 ? ` and ${words.length - 4} more` : ''
    return `${lead} ${shown}${more}`
  }

  if (pattern.startsWith('re:')) return `Tools matching /${pattern.slice(3)}/`
  if (pattern.includes('*')) return `Tools named like "${pattern}"`
  return `The tool "${pattern}"`
}

export interface RuleSummary {
  /** What happens, in plain words. */
  effect: string
  /** What it applies to. */
  subject: string
  /** Extra conditions, each already readable. */
  conditions: string[]
}

export function summarizeRule(
  match: PolicyMatch,
  effect: PolicyEffect,
  serverName?: (id: string) => string
): RuleSummary {
  const conditions: string[] = []

  if (match.serverId && match.serverId !== '*') {
    conditions.push(`only on ${serverName ? serverName(match.serverId) : match.serverId}`)
  }
  if (match.clientName && match.clientName !== '*') {
    const apps = alternatives(match.clientName)
    conditions.push(apps.length > 0 ? `only from ${apps.join(' or ')}` : `only from ${match.clientName}`)
  }
  if (match.argMatches) {
    const where = match.argPath ? `the "${match.argPath}" argument` : 'any argument'
    // A long regex swamps the sentence and wraps the row onto three lines; the
    // full pattern is still shown on the line below and in the tooltip.
    conditions.push(
      match.argMatches.length > MAX_INLINE_PATTERN
        ? `when ${where} matches a pattern`
        : `when ${where} matches /${match.argMatches}/`
    )
  } else if (match.argPath) {
    conditions.push(`when a "${match.argPath}" argument is present`)
  }
  if (match.method && match.method !== 'tools/call' && match.method !== '*') {
    conditions.push(`on ${match.method}`)
  }

  return {
    effect: EFFECT_VERB[effect],
    subject: describeToolPattern(match.tool),
    conditions
  }
}
