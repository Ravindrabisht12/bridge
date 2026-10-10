/**
 * Types the worker owns. Separate from the catalogue contract because these
 * never cross to the desktop app — they are the job's own bookkeeping, and
 * keeping them apart stops internal fields leaking into the public shape.
 */
import type { CatalogueEntry, ProbeOutcome } from './catalogue'

export type SyncStage = 'registry' | 'downloads' | 'probe' | 'icons' | 'publish'

export interface StageResult {
  stage: SyncStage
  startedAt: string
  finishedAt: string
  fetched: number
  added: number
  changed: number
  removed: number
  error: string | null
}

export interface ProbeResult {
  key: string
  endpoint: string
  outcome: ProbeOutcome
  detail: Record<string, unknown> | null
  probedAt: string
}

/**
 * What the publish step is handed. Kept explicit so the shrink guard in
 * `guard.ts` can be given a plain object in a test rather than a live database.
 */
export interface PublishCandidate {
  entries: CatalogueEntry[]
  previousEntryCount: number
  generatedAt: string
}
