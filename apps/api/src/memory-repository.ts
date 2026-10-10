/**
 * In-memory repository, for tests and for `pnpm dev` without a database.
 *
 * It implements the same ordering and cursor semantics as the Postgres one on
 * purpose: if the two disagree about tie-breaking, the tests here are worthless.
 * The ranking is deliberately crude — real relevance is Postgres's job — but
 * the *contract* (name beats description, stable order, no duplicates across
 * pages) is what the tests pin.
 *
 * Fields are declared and assigned rather than written as constructor
 * parameter properties: those need a code transform, and Node's strip-only
 * type stripping does type *erasure* only. Same reason there are no enums,
 * namespaces or decorators anywhere in this package.
 */
import type { AppRelease, CatalogueDelta, CatalogueEntry, Page, SnapshotMeta } from '@bridge/types'
import { decodeCursor, decodeOffset, encodeCursor, encodeOffset, MAX_SEARCH_OFFSET } from './cursor'
import type { CatalogueRepository, DeltaArgs, SearchArgs } from './repository'

export class MemoryRepository implements CatalogueRepository {
  private readonly entries: CatalogueEntry[]
  private readonly removed: Array<{ key: string; updatedAt: string }>
  private readonly snapshot: SnapshotMeta | null
  private readonly release: AppRelease | null

  constructor(
    entries: CatalogueEntry[] = [],
    removed: Array<{ key: string; updatedAt: string }> = [],
    snapshot: SnapshotMeta | null = null,
    release: AppRelease | null = null
  ) {
    this.entries = entries
    this.removed = removed
    this.snapshot = snapshot
    this.release = release
  }

  /** Stable order: updated_at then key, matching the SQL. */
  private static byCursor(a: CatalogueEntry, b: CatalogueEntry): number {
    return a.updatedAt === b.updatedAt ? a.key.localeCompare(b.key) : a.updatedAt.localeCompare(b.updatedAt)
  }

  async search(args: SearchArgs): Promise<Page<CatalogueEntry>> {
    const term = args.q.trim().toLowerCase()
    const scored = this.entries
      .filter((e) => (args.firstPartyOnly ? e.isFirstParty : true))
      .filter((e) => (args.category ? e.category === args.category : true))
      .map((e) => {
        const title = e.title.toLowerCase()
        // Name matches outrank description matches, and an exact name wins
        // outright — someone typing "notion" wants Notion.
        let score = 0
        if (title === term) score = 100
        else if (title.startsWith(term)) score = 80
        else if (title.includes(term)) score = 60
        else if ((e.namespace ?? '').toLowerCase().includes(term)) score = 40
        else if (e.description.toLowerCase().includes(term)) score = 20
        return { e, score }
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => (b.score - a.score) || a.e.key.localeCompare(b.e.key))
      .map((r) => r.e)

    // Offset, matching the SQL: search is relevance-ordered, so a keyset
    // cursor cannot express a position in it.
    const start = decodeOffset(args.cursor) ?? 0
    const items = scored.slice(start, start + args.limit)
    const next = start + items.length
    const more = next < scored.length
    return {
      items,
      nextCursor: more && next <= MAX_SEARCH_OFFSET ? encodeOffset(next) : null,
      total: scored.length
    }
  }

  async get(key: string): Promise<CatalogueEntry | null> {
    return this.entries.find((e) => e.key === key) ?? null
  }

  async featured(limit: number): Promise<CatalogueEntry[]> {
    return this.entries
      .filter((e) => e.featuredRank !== null)
      .sort((a, b) => (a.featuredRank ?? 0) - (b.featuredRank ?? 0))
      .slice(0, limit)
  }

  async delta(args: DeltaArgs): Promise<CatalogueDelta> {
    const since = decodeCursor(args.since)
    const after = (e: { updatedAt: string; key: string }): boolean => {
      if (!since) return true
      if (e.updatedAt !== since.updatedAt) return e.updatedAt > since.updatedAt
      return e.key > since.key
    }

    const changed = this.entries.filter(after).sort(MemoryRepository.byCursor)
    const page = changed.slice(0, args.limit)
    const hasMore = changed.length > page.length
    // Removals ride along with the page they fall in, so a client that stops
    // paging halfway has still applied every removal up to its new cursor.
    const removals = this.removed.filter(after).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))

    const lastEntry = page.at(-1)
    const lastRemoval = removals.at(-1)
    const tip = [lastEntry, lastRemoval].filter(Boolean).sort((a, b) =>
      MemoryRepository.byCursor(a as CatalogueEntry, b as CatalogueEntry)
    ).at(-1)

    return {
      cursor: tip ? encodeCursor({ updatedAt: tip.updatedAt, key: tip.key }) : (args.since ?? ''),
      hasMore,
      changed: page,
      removed: hasMore ? [] : removals.map((r) => r.key)
    }
  }

  async currentSnapshot(): Promise<SnapshotMeta | null> {
    return this.snapshot
  }

  async currentRelease(): Promise<AppRelease | null> {
    return this.release
  }

  async ping(): Promise<void> {
    /* memory is always up */
  }
}
