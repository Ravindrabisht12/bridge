/**
 * The five stages, in order, each one writing a `sync_runs` row.
 *
 * Ports rather than implementations: the real registry pull, favicon discovery
 * and probe logic all already exist and are already debugged in the desktop app
 * (`src/main/services/registry-sync.ts`, `icons.ts`, `favicon.ts`,
 * `probe.ts`). They move here — they do not get rewritten. Two bugs in
 * particular are already fixed in that code and would certainly be reintroduced
 * by a clean-room version:
 *
 *   - the page cap that silently truncated the catalogue alphabetically, so
 *     `io.github.*` — most of the real servers — never arrived;
 *   - category inference reading the namespace, where every `io.github.*` entry
 *     contains the word "github" and `dev` swallowed 18,528 of 27,213 entries.
 */
import type { StageResult, SyncStage } from '@bridge/types'

export interface StageContext {
  /** Set on a scheduled run; false when a human triggered it by hand. */
  scheduled: boolean
  now: () => Date
  log: (msg: string) => void
}

export interface Stage {
  name: SyncStage
  run(ctx: StageContext): Promise<Omit<StageResult, 'stage' | 'startedAt' | 'finishedAt'>>
}

/** Wraps a stage so timing and failure are recorded identically for all of them. */
export async function runStage(stage: Stage, ctx: StageContext): Promise<StageResult> {
  const startedAt = ctx.now().toISOString()
  try {
    const out = await stage.run(ctx)
    return { stage: stage.name, startedAt, finishedAt: ctx.now().toISOString(), ...out }
  } catch (err) {
    // A failed stage is recorded, not thrown away. The next stage decides
    // whether it can proceed — icons failing should not stop a publish, a
    // registry pull failing must.
    return {
      stage: stage.name,
      startedAt,
      finishedAt: ctx.now().toISOString(),
      fetched: 0,
      added: 0,
      changed: 0,
      removed: 0,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

/** Stages whose failure must abort the run rather than degrade it. */
export const CRITICAL: ReadonlySet<SyncStage> = new Set<SyncStage>(['registry', 'publish'])

export function shouldAbort(results: readonly StageResult[]): StageResult | null {
  return results.find((r) => r.error !== null && CRITICAL.has(r.stage)) ?? null
}
