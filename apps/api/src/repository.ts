/**
 * The data boundary.
 *
 * Routes talk to this interface, never to SQL. Two implementations exist: one
 * on Postgres for production, one in memory for tests. That is not ceremony —
 * it means the route logic (cursors, caps, cache headers, error shapes) is
 * fully tested without a database anywhere near CI, and the day this moves off
 * Supabase only one file changes.
 */
import type { AppRelease, CatalogueDelta, CatalogueEntry, Page, SnapshotMeta } from '@bridge/types'

export interface SearchArgs {
  q: string
  firstPartyOnly: boolean
  category: string | null
  limit: number
  cursor: string | null
}

export interface DeltaArgs {
  since: string | null
  limit: number
}

export interface CatalogueRepository {
  /** Ranked search. Name matches must outrank description matches. */
  search(args: SearchArgs): Promise<Page<CatalogueEntry>>

  /** One entry, or null. Never throws for "not found". */
  get(key: string): Promise<CatalogueEntry | null>

  /** The curated set, ordered for the front page. */
  featured(limit: number): Promise<CatalogueEntry[]>

  /** Everything changed since a cursor, plus explicit removals. */
  delta(args: DeltaArgs): Promise<CatalogueDelta>

  /** Where the current bulk snapshot lives. Null before the first publish. */
  currentSnapshot(): Promise<SnapshotMeta | null>

  /** The current desktop release. Null before the first one ships. */
  currentRelease(): Promise<AppRelease | null>

  /** Cheap liveness probe. Throws if the backing store is unreachable. */
  ping(): Promise<void>
}
