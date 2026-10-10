/**
 * The orchestrator.
 *
 * Runs the stages in order, records each one, and stops if a critical stage
 * failed. Kept free of process concerns — no env reading, no exit codes, no
 * database construction — so the whole policy is testable with a memory store
 * and a fake clock.
 */
import type { StageResult } from '@bridge/types'
import { runStage, shouldAbort, type Stage, type StageContext } from './stages'
import type { CatalogueStore } from './store'

export interface RunOptions {
  store: CatalogueStore
  stages: Stage[]
  ctx: StageContext
}

export interface RunReport {
  results: StageResult[]
  /** The critical stage that stopped the run, if any. */
  abortedAt: StageResult | null
  ok: boolean
}

export async function runSync(opts: RunOptions): Promise<RunReport> {
  const results: StageResult[] = []

  for (const stage of opts.stages) {
    const result = await runStage(stage, opts.ctx)
    results.push(result)

    // Recorded before the abort check, so a failure is always in the audit
    // trail even when it stops the run. Losing the row that explains why a
    // sync stopped is the one thing that makes an unattended job unfixable.
    try {
      await opts.store.recordRun(result)
    } catch (err) {
      opts.ctx.log(`could not record ${stage.name}: ${err instanceof Error ? err.message : String(err)}`)
    }

    if (result.error) opts.ctx.log(`${stage.name} failed: ${result.error}`)

    const fatal = shouldAbort([result])
    if (fatal) {
      opts.ctx.log(`aborting: ${fatal.stage} is critical`)
      return { results, abortedAt: fatal, ok: false }
    }
  }

  return { results, abortedAt: null, ok: true }
}
