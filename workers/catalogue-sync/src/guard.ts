/**
 * The publish guard.
 *
 * This is the most important file in the worker, and the smallest.
 *
 * A snapshot is the only artefact in this system that can destroy something a
 * user can see. If the registry has an outage and answers a page with `[]`,
 * a naive job records "0 entries", publishes it, and every desktop app in the
 * world replaces a working library with nothing. Nobody notices until Monday.
 *
 * So a publish has to be able to refuse. The rule is deliberately blunt: if the
 * catalogue shrank by more than a small fraction, that is not a sync, it is an
 * incident — stop, keep serving the previous snapshot, and make someone look.
 */

/** Beyond this proportion of entries lost, refuse rather than publish. */
export const MAX_SHRINK = 0.05

/** Below this, proportions are meaningless and any drop is suspicious. */
export const SMALL_CATALOGUE = 20

export type GuardVerdict =
  | { ok: true; reason: string }
  | { ok: false; reason: string }

export function checkPublish(next: number, previous: number): GuardVerdict {
  if (!Number.isFinite(next) || next < 0) {
    return { ok: false, reason: `entry count is not a number (${next})` }
  }

  // An empty catalogue is never a legitimate sync result. Special-cased ahead
  // of the proportion so the message is the true one.
  if (next === 0) {
    return { ok: false, reason: 'refusing to publish an empty catalogue' }
  }

  // First ever publish: nothing to compare against, and refusing would mean
  // the job could never bootstrap.
  if (previous <= 0) {
    return { ok: true, reason: `first publish (${next} entries)` }
  }

  if (next >= previous) {
    return { ok: true, reason: `${next} entries, up from ${previous}` }
  }

  const lost = previous - next
  // Under a couple of dozen entries a percentage says nothing useful: losing
  // 1 of 10 is 10% and probably fine, losing 9 of 10 is not, and the curated
  // set lives in exactly this range.
  if (previous < SMALL_CATALOGUE) {
    return lost <= 1
      ? { ok: true, reason: `${next} entries, down 1 from ${previous}` }
      : { ok: false, reason: `small catalogue lost ${lost} of ${previous} entries` }
  }

  const shrink = lost / previous
  if (shrink > MAX_SHRINK) {
    return {
      ok: false,
      reason:
        `catalogue shrank ${(shrink * 100).toFixed(1)}% (${previous} to ${next}), ` +
        `over the ${(MAX_SHRINK * 100).toFixed(0)}% limit — not publishing`
    }
  }
  return { ok: true, reason: `${next} entries, down ${lost} from ${previous} (within limit)` }
}
