import type { CallStatus } from '@shared/types'
import type { Db } from './index'

/**
 * The half of a hook record that `PostToolUse` fills in.
 *
 * `PreToolUse` decides a call and knows nothing about what it did; the outcome
 * arrives later, in a different process. Without this the trace can only ever
 * say "Bridge allowed this", which is not an answer to "what happened".
 */
export interface HookOutcome {
  status: CallStatus
  result: string | null
  resultBytes: number | null
  endedAt: number
  findings: string
  findingCount: number
  maxSeverity: string
}

export interface PendingHookCall {
  id: string
  startedAt: number
}

/**
 * The open record this outcome belongs to.
 *
 * Matched on the correlation key and restricted to `permitted`, so a second
 * `PostToolUse` for an already-finished call cannot reopen it. Newest first
 * because the same tool with the same arguments can legitimately run twice in
 * a turn, and the most recent open one is the right owner.
 */
export function findPermittedHookCall(db: Db, hookKey: string): PendingHookCall | null {
  const row = db
    .prepare(
      `SELECT id, started_at AS startedAt FROM calls
        WHERE hook_key = ? AND status = 'permitted'
        ORDER BY started_at DESC LIMIT 1`
    )
    .get(hookKey) as PendingHookCall | undefined
  return row ?? null
}

/** Completes the record opened by `PreToolUse`. Never creates one. */
export function completeHookCall(db: Db, id: string, outcome: HookOutcome): boolean {
  return (
    db
      .prepare(
        `UPDATE calls SET
           status = @status, result = @result, result_bytes = @resultBytes,
           ended_at = @endedAt, duration_ms = @endedAt - started_at,
           findings = @findings, finding_count = @findingCount, max_severity = @maxSeverity
         WHERE id = @id AND status = 'permitted'`
      )
      .run({ ...outcome, id }).changes === 1
  )
}
