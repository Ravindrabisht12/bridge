/**
 * Postgres implementation.
 *
 * Reads exclusively from the `catalogue_entries` view, so the registry/curated
 * join and the column aliasing live in SQL where they can be reasoned about
 * once. `select r.*, c.*` was a real bug in the desktop app — duplicate `key`
 * and `updated_at` meant a missing overlay nulled the entry's own key — and the
 * view exists so that cannot recur here.
 */
import postgres from 'postgres'
import type { AppRelease, CatalogueDelta, CatalogueEntry, Page, SnapshotMeta } from '@bridge/types'
import { encodeCursor, decodeCursor, decodeOffset, encodeOffset, MAX_SEARCH_OFFSET } from './cursor'
import type { CatalogueRepository, DeltaArgs, SearchArgs } from './repository'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>

function toEntry(r: Row): CatalogueEntry {
  return {
    key: r.key,
    namespace: r.namespace ?? null,
    title: r.title,
    description: r.description ?? '',
    version: r.version ?? null,
    repositoryUrl: r.repository_url ?? null,
    websiteUrl: r.website_url ?? null,
    status: r.status,
    packages: r.packages ?? [],
    remotes: r.remotes ?? [],
    isFirstParty: !!r.is_first_party,
    vendorDomain: r.vendor_domain ?? null,
    // Prefer the copy on our own CDN; a vendor URL is the fallback, never the
    // thing a browser is told to fetch if we have the bytes.
    iconUrl: r.icon_asset ? `${process.env.CDN_BASE ?? ''}/${r.icon_asset}` : null,
    category: r.category ?? null,
    pricingTier: r.pricing_tier ?? 'unknown',
    evidence: r.evidence ?? 'unverified',
    featuredRank: r.featured_rank ?? null,
    downloads: r.downloads ?? null,
    downloadsSource: r.downloads_source ?? null,
    publishedAt: r.published_at ? new Date(r.published_at).toISOString() : null,
    updatedAt: new Date(r.updated_at).toISOString(),
    verifiedAt: r.verified_at ? new Date(r.verified_at).toISOString() : null
  }
}

export class PostgresRepository implements CatalogueRepository {
  private readonly sql: postgres.Sql
  private readonly entries: string
  private readonly registry: string

  constructor(url: string, opts: { staging?: boolean } = {}) {
    this.entries = opts.staging ? 'catalogue_entries' : 'published_catalogue_entries'
    this.registry = opts.staging ? 'registry_servers' : 'published_registry_servers'
    // Declared-then-assigned, not a parameter property: Node's strip-only
    // type stripping erases types but does not transform code.
    this.sql = postgres(url, {
      // Small pool on purpose: the CDN absorbs the reads, so the origin needs
      // headroom for bursts rather than a large idle pool.
      max: Number(process.env.PG_POOL ?? 8),
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: true
    })
  }

  async search(args: SearchArgs): Promise<Page<CatalogueEntry>> {
    const { sql } = this
    const offset = decodeOffset(args.cursor) ?? 0

    // websearch_to_tsquery rather than to_tsquery: it accepts what a person
    // actually types, including quotes and OR, without throwing on syntax.
    const rows = await sql<Row[]>`
      with matched as (
        select e.*,
               ts_rank(r.search_tsv, websearch_to_tsquery('simple', ${args.q})) as rank,
               (lower(e.title) = lower(${args.q})) as exact
        from ${this.sql(this.entries)} e
        join ${this.sql(this.registry)} r on r.key = e.key
        where (
                r.search_tsv @@ websearch_to_tsquery('simple', ${args.q})
                or e.title ilike ${'%' + args.q + '%'}
              )
          and (${args.firstPartyOnly} = false or e.is_first_party)
          and (${args.category}::text is null or e.category = ${args.category})
      )
      select * from matched
      -- Exact name first, then relevance, then a stable tiebreak so paging
      -- never repeats or skips a row.
      order by exact desc, rank desc, key asc
      limit ${args.limit + 1}
      offset ${offset}
    `

    const items = rows.slice(0, args.limit).map(toEntry)
    const next = offset + items.length
    return {
      items,
      // Stop offering pages past the cap rather than handing out a cursor the
      // next request would reject.
      nextCursor: rows.length > args.limit && next <= MAX_SEARCH_OFFSET ? encodeOffset(next) : null,
      total: null
    }
  }

  async get(key: string): Promise<CatalogueEntry | null> {
    const rows = await this.sql<Row[]>`select * from ${this.sql(this.entries)} where key = ${key} limit 1`
    return rows[0] ? toEntry(rows[0]) : null
  }

  async featured(limit: number): Promise<CatalogueEntry[]> {
    const rows = await this.sql<Row[]>`
      select * from ${this.sql(this.entries)}
      where featured_rank is not null
      order by featured_rank asc, title asc
      limit ${limit}
    `
    return rows.map(toEntry)
  }

  async delta(args: DeltaArgs): Promise<CatalogueDelta> {
    const since = decodeCursor(args.since)
    const { sql } = this

    // Live entries and tombstones share one cursor and one page boundary.
    const rows = await sql<Row[]>`
      with changes as (
        select e.key, e.updated_at, false as removed, to_jsonb(e) as entry
          from ${sql(this.entries)} e
        union all
        select key, updated_at, true as removed, null::jsonb as entry
          from ${sql(this.registry)} where deleted_at is not null
      )
      select *, to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_time
        from changes
       where ${since ? sql`(updated_at, key) > (${since.updatedAt}::timestamptz, ${since.key})` : sql`true`}
       order by updated_at, key limit ${args.limit + 1}
    `
    const page = rows.slice(0, args.limit)
    const last = page.at(-1)
    return {
      cursor: last ? encodeCursor({ updatedAt: last.cursor_time.replace(/(\.\d{3})000Z$/, '$1Z'), key: last.key }) : (args.since ?? ''),
      hasMore: rows.length > args.limit,
      changed: page.filter((r) => !r.removed).map((r) => toEntry(r.entry)),
      removed: page.filter((r) => r.removed).map((r) => r.key)
    }
  }

  async close(): Promise<void> { await this.sql.end({ timeout: 5 }) }

  async currentSnapshot(): Promise<SnapshotMeta | null> {
    const rows = await this.sql<Row[]>`select * from snapshots where is_current limit 1`
    const r = rows[0]
    if (!r) return null
    return {
      digest: r.digest,
      url: r.url,
      bytes: Number(r.bytes),
      entryCount: r.entry_count,
      cursor: r.cursor,
      generatedAt: new Date(r.generated_at).toISOString()
    }
  }

  async currentRelease(): Promise<AppRelease | null> {
    const rows = await this.sql<Row[]>`select * from app_releases where is_current limit 1`
    const r = rows[0]
    if (!r) return null
    return {
      version: r.version,
      notes: r.notes ?? null,
      notesUrl: r.notes_url ?? null,
      publishedAt: new Date(r.published_at).toISOString(),
      minimumSupported: r.minimum_supported,
      downloads: r.downloads ?? []
    }
  }

  async ping(): Promise<void> {
    await this.sql`select 1`
  }
}
