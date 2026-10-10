/**
 * The permission decision, in one place.
 *
 * Two surfaces enforce policy — the MCP proxy and the Claude Code hook — and a
 * security decision that lives in two functions eventually differs in one of
 * them. Everything from "what do the rules say" through "did a grant cover
 * this" happens here; each caller keeps only its own recording and prompting.
 */
import type { ActionGrant } from '@shared/action-grant'
import { describeConstraint, failedConstraint } from '@shared/action-grant'
import type { Finding, PolicyEffect, PolicyRule, Settings } from '@shared/types'
import { activeActionGrants, consumeActionGrant } from '../db/action-grants'
import type { Db } from '../db'
import { scanArguments } from '../scanners'
import { evaluate, strictest, type PolicyContext, type PolicyDecision } from './engine'

export interface DecisionInput {
  settings: Settings
  rules: readonly PolicyRule[]
  ctx: PolicyContext
  sessionId: string
  db: Db | null
  /** The tool's definition changed since it was last approved. */
  toolChanged: boolean
  log?: (line: string) => void
}

export interface Decision {
  /** Effect before any user prompt. `ask` means a prompt is required. */
  effect: PolicyEffect
  verdict: PolicyDecision
  ruleId: string | null
  findings: Finding[]
  /** An argument looks like a credential and the setting escalates on that. */
  credentialGate: boolean
  /** This decision cannot be remembered or reused. */
  onceOnly: boolean
  /** The grant that authorised the call, when one did. A use is already spent. */
  grant: ActionGrant | null
  /** Why a live grant did not cover this call, when one nearly did. */
  grantMiss: Finding | null
  /** Result-side redaction patterns from the winning rule. */
  redactResult: string[]
}

export function decide(input: DecisionInput): Decision {
  const { settings, rules, ctx, db } = input
  const tool = ctx.tool ?? 'unknown'

  const credentialAction = settings.credentialAction ?? 'ask'
  const findings = scanArguments(ctx.args, {
    ...settings,
    scanSecrets: settings.scanSecrets || credentialAction !== 'flag'
  })
  const sensitive = findings.some((finding) => finding.type === 'secret' && finding.severity === 'high')
  const credentialGate = sensitive && credentialAction !== 'flag'
  const actionGate = settings.strictActionApproval !== false
  const onceOnly = credentialGate || actionGate

  const verdict = evaluate(rules, ctx, settings.defaultEffect)
  let effect: PolicyEffect = verdict.effect
  let ruleId = verdict.ruleId

  if (credentialGate) {
    const gated = strictest(effect, credentialAction === 'deny' ? 'deny' : 'ask')
    // The rule no longer explains the outcome once the credential gate wins.
    if (gated !== effect) ruleId = null
    effect = gated
  }
  if (actionGate) effect = strictest(effect, 'ask')
  if (settings.pauseToolCalls) effect = 'deny'

  if (settings.askOnToolChange && input.toolChanged) {
    effect = strictest(effect, 'ask')
    findings.push({
      type: 'tool-changed',
      severity: 'high',
      label: 'Tool definition changed',
      detail: `"${tool}" was redefined since the last time it ran.`,
      side: 'meta'
    })
  }

  // A grant replaces only the strict-mode prompt. An explicit ask/deny rule, a
  // credential gate, tool drift and pause stay authoritative, so a grant can
  // never widen a permission the user narrowed elsewhere.
  let grant: ActionGrant | null = null
  let grantMiss: Finding | null = null
  const grantEligible =
    effect === 'ask' && verdict.effect === 'allow' && !credentialGate && !input.toolChanged && !!db

  if (grantEligible && db) {
    const match = { serverId: ctx.serverId, sessionId: input.sessionId, tool, args: ctx.args }
    try {
      grant = consumeActionGrant(db, match)
    } catch (err) {
      // A failed lookup leaves the call needing approval; it never sails through.
      input.log?.(`grant lookup failed: ${(err as Error).message}`)
      grant = null
    }
    if (grant) {
      effect = 'allow'
      ruleId = grant.id
    } else {
      grantMiss = explainGrantMiss(db, match)
      if (grantMiss) findings.push(grantMiss)
    }
  }

  return {
    effect,
    verdict,
    ruleId,
    findings,
    credentialGate,
    onceOnly,
    grant,
    grantMiss,
    redactResult: verdict.redactResult
  }
}

/**
 * Names the condition that kept an existing grant from covering this call.
 *
 * Without it, stepping outside a scope is indistinguishable from having no
 * grant at all: same prompt, no reason. Naming the bound is what makes a scope
 * legible — the user sees the boundary held, and the agent's error says which
 * one it crossed.
 */
function explainGrantMiss(
  db: Db,
  match: { serverId: string; sessionId: string; tool: string; args: unknown }
): Finding | null {
  let candidates: ActionGrant[]
  try {
    candidates = activeActionGrants(db).filter(
      (grant) =>
        grant.serverId === match.serverId &&
        grant.tools.includes(match.tool) &&
        (grant.sessionId === null || grant.sessionId === match.sessionId)
    )
  } catch {
    return null
  }

  for (const grant of candidates) {
    const failed = failedConstraint(grant, match.args)
    if (!failed) continue
    return {
      type: 'grant-scope',
      severity: 'low',
      label: 'Outside an active permission',
      detail: `A permission covers "${match.tool}" but requires ${describeConstraint(failed)}. This call does not satisfy it, so it needs a fresh decision.`,
      side: 'meta'
    }
  }
  return null
}
