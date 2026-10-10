/**
 * Postgres implementation of the write boundary.
 *
 * Two things here are load-bearing rather than incidental.
 *
 * **Change detection happens in SQL, not in JavaScript.** `upsertServers`
 * compares the incoming row against the stored one inside the statement and
 * only bumps `updated_at` when a *served* field differs. Doing it in the worker
 * would mean reading 27,000 rows to write 40; doing it wrong would mark the
 * whole catalogue changed every week and push all of it into every client's
 * next delta.
 *
 * **`updated_at` is ours.** It is what the delta cursor orders by, so it must
 * move when a client would notice something and stay still when it would not.
 */
import postgres from 'postgres'
import type { CatalogueEntry, ProbeResult, StageResult } from '@bridge/types'
import type {
  CatalogueStore,
  DownloadTarget,
  IconTarget,
  ProbeTarget,
  ServerRow,
  UpsertOutcome
} from './store'

export class PostgresStore implements CatalogueStore {
  private readonly sql: postgres.Sql

  constructor(url: string) {
    this.sql = postgres(url, { max: 4, idle_timeout: 20, connect_timeout: 10 })
  }

  async upsertServers(rows: ServerRow[]): Promise<UpsertOutcome> {
    if (rows.length === 0) return { added: 0, changed: 0, unchanged: 0 }

    // One jsonb parameter expanded by `jsonb_to_recordset`, rather than
    // postgres.js's multi-row helper: it is a single bind regardless of batch
    // size, and it avoids the helper's readonly-tuple typing entirely.
    const payload = rows.map((r, i) => ({
      // Carried in the payload rather than via WITH ORDINALITY, which Postgres
      // refuses to combine with a column definition list. It exists only so
      // "last occurrence wins" below is deterministic.
      ord: i,
      key: r.key,
      namespace: r.namespace,
      title: r.title,
      description: r.description,
      version: r.version,
      repository_url: r.repositoryUrl,
      website_url: r.websiteUrl,
      status: r.status,
      packages: r.packages,
      remotes: r.remotes,
      published_at: r.publishedAt,
      source_updated_at: r.sourceUpdatedAt
    }))

    const result = await this.sql<Array<{ inserted: boolean; is_changed: boolean }>>`
      with input as (
        -- DISTINCT ON, because ON CONFLICT cannot touch the same row twice in
        -- one statement: a batch containing a duplicate key fails outright
        -- with "cannot affect row a second time". The registry has returned
        -- the same name twice across a page boundary, and batches are 500
        -- rows, so one duplicate would fail the registry stage — which is
        -- critical, which aborts the whole weekly run. The ord column makes
        -- "last occurrence wins" deterministic rather than planner-dependent.
        select distinct on (x.key)
               x.key, x.namespace, x.title, x.description, x.version,
               x.repository_url, x.website_url, x.status, x.packages, x.remotes,
               x.published_at, x.source_updated_at
          from jsonb_to_recordset(${this.sql.json(payload as never)}) as x(
            ord bigint,
            key text, namespace text, title text, description text, version text,
            repository_url text, website_url text, status text,
            packages jsonb, remotes jsonb,
            published_at timestamptz, source_updated_at timestamptz
          )
         where x.key is not null
         order by x.key, x.ord desc
      ),
      classified as (
        -- The decision is made HERE, once, against the pre-statement snapshot,
        -- and then used both to set updated_at and to report the counts.
        --
        -- The previous version inferred "did this change?" afterwards by
        -- testing updated_at = now(), which is unsound: now() is the
        -- transaction timestamp, so an insert and a re-upsert landing in the
        -- same clock tick made an unchanged row look changed. It failed about
        -- one run in five, and the consequence of believing it would be every
        -- weekly sync marking all 28,000 entries changed and pushing the whole
        -- catalogue into every client's next delta.
        select i.*,
               (r.key is null) as is_new,
               (r.key is not null and (
                     r.title          is distinct from i.title
                  or r.description    is distinct from i.description
                  or r.version        is distinct from i.version
                  or r.namespace      is distinct from i.namespace
                  or r.repository_url is distinct from i.repository_url
                  or r.website_url    is distinct from i.website_url
                  or r.status         is distinct from i.status
                  or r.packages       is distinct from i.packages
                  or r.remotes        is distinct from i.remotes
                  -- A row the registry has published again counts as changed.
                  or r.deleted_at is not null
               )) as is_changed,
               coalesce(r.updated_at, now()) as kept_updated_at
          from input i
          left join registry_servers r on r.key = i.key
      ),
      written as (
        insert into registry_servers
          (key, namespace, title, description, version, repository_url, website_url,
           status, packages, remotes, published_at, source_updated_at, updated_at)
        select key, namespace, title, description, version, repository_url, website_url,
               status, packages, remotes, published_at, source_updated_at,
               case when is_new or is_changed then now() else kept_updated_at end
          from classified
        on conflict (key) do update set
          namespace         = excluded.namespace,
          title             = excluded.title,
          description       = excluded.description,
          version           = excluded.version,
          repository_url    = excluded.repository_url,
          website_url       = excluded.website_url,
          status            = excluded.status,
          packages          = excluded.packages,
          remotes           = excluded.remotes,
          published_at      = excluded.published_at,
          source_updated_at = excluded.source_updated_at,
          -- Resurrect anything the registry has published again.
          deleted_at        = null,
          -- Already decided in classified; no re-derivation, no drift.
          updated_at        = excluded.updated_at
        -- xmax = 0 is the standard way to tell an INSERT from an ON CONFLICT
        -- UPDATE, so added is read back rather than guessed.
        returning key, (xmax = 0) as inserted
      )
      select w.inserted, c.is_changed
        from written w
        join classified c on c.key = w.key
    `

    let added = 0
    let changed = 0
    for (const row of result) {
      if (row.inserted) added++
      else if (row.is_changed) changed++
    }
    return { added, changed, unchanged: result.length - added - changed }
  }

  async markMissingDeleted(seen: Set<string>): Promise<number> {
    // Guarded: an empty `seen` would delete the entire catalogue, and the only
    // way to get here with one is a bug upstream.
    if (seen.size === 0) return 0
    const rows = await this.sql<Array<{ key: string }>>`
      update registry_servers
         set deleted_at = now(), updated_at = now()
       where deleted_at is null
         and key not like 'bridge:%'
         and key <> all(${this.sql.array([...seen])})
      returning key
    `
    return rows.length
  }

  async countLive(): Promise<number> {
    const [row] = await this.sql<Array<{ n: string }>>`
      select count(*)::text as n from registry_servers where deleted_at is null
    `
    return Number(row?.n ?? 0)
  }

  async downloadTargets(limit: number): Promise<DownloadTarget[]> {
    // Oldest-first so the budget converges over successive runs rather than
    // re-asking about the same packages every week.
    const rows = await this.sql<Array<{ key: string; registry_type: string; identifier: string }>>`
      select r.key,
             p->>'registryType' as registry_type,
             p->>'identifier'   as identifier
        from registry_servers r
        cross join lateral jsonb_array_elements(r.packages) as p
       where r.deleted_at is null
         and p->>'identifier' is not null
         and p->>'registryType' in ('npm', 'pypi')
       order by r.downloads is not null, r.updated_at asc
       limit ${limit}
    `
    return rows.map((r) => ({ key: r.key, registryType: r.registry_type, identifier: r.identifier }))
  }

  async setDownloads(key: string, downloads: number, source: 'npm' | 'pypi'): Promise<void> {
    // Does NOT touch updated_at: a download count moving is not a reason to
    // push an entry into every client's next delta.
    await this.sql`
      update registry_servers set downloads = ${downloads}, downloads_source = ${source}
       where key = ${key}
    `
  }

  async probeTargets(staleBefore: string): Promise<ProbeTarget[]> {
    const rows = await this.sql<Array<{ key: string; endpoint: string; vendor_domain: string }>>`
      select c.key, (r.remotes->0->>'url') as endpoint, c.vendor_domain
        from curated c
        join registry_servers r on r.key = c.key
       where r.deleted_at is null
         and c.vendor_domain is not null
         and r.remotes->0->>'url' is not null
         and (c.verified_at is null or c.verified_at < ${staleBefore}::timestamptz)
    `
    return rows.map((r) => ({ key: r.key, endpoint: r.endpoint, vendorDomain: r.vendor_domain }))
  }

  async iconTargets(): Promise<IconTarget[]> {
    const rows = await this.sql<
      Array<{ key: string; icon_domain: string; icon_url: string | null; icon_asset: string | null }>
    >`
      select c.key,
             coalesce(c.icon_domain, c.vendor_domain) as icon_domain,
             c.icon_url,
             c.icon_asset
        from curated c
        join registry_servers r on r.key = c.key
       where r.deleted_at is null
         and coalesce(c.icon_domain, c.vendor_domain) is not null
    `
    return rows.map((r) => ({
      key: r.key,
      iconDomain: r.icon_domain,
      iconUrl: r.icon_url,
      iconAsset: r.icon_asset
    }))
  }

  async setIconAsset(key: string, asset: string): Promise<void> {
    // Bumps curated.updated_at, which the served view folds into updated_at —
    // so a newly resolved icon does reach clients. Guarded by `is distinct
    // from` so re-resolving to the same asset is not a change.
    await this.sql`
      update curated set icon_asset = ${asset}, updated_at = now()
       where key = ${key} and icon_asset is distinct from ${asset}
    `
  }

  async recordProbe(result: ProbeResult): Promise<void> {
    await this.sql`
      insert into probes (key, endpoint, outcome, detail, probed_at)
      values (${result.key}, ${result.endpoint}, ${result.outcome},
              ${this.sql.json((result.detail ?? {}) as never)}, ${result.probedAt}::timestamptz)
    `
  }

  async setVerified(key: string, verifiedAt: string): Promise<void> {
    // Bumps curated.updated_at, which the catalogue_entries view folds into the
    // served updated_at — so a fresh verification does reach clients.
    await this.sql`
      update curated set verified_at = ${verifiedAt}::timestamptz, updated_at = now()
       where key = ${key}
    `
  }

  async allEntries(): Promise<CatalogueEntry[]> {
    const rows = await this.sql<Array<Record<string, unknown>>>`
      select * from catalogue_entries order by key asc
    `
    return rows.map((r) => ({
      key: r.key as string,
      namespace: (r.namespace as string) ?? null,
      title: r.title as string,
      description: (r.description as string) ?? '',
      version: (r.version as string) ?? null,
      repositoryUrl: (r.repository_url as string) ?? null,
      websiteUrl: (r.website_url as string) ?? null,
      status: r.status as string,
      packages: (r.packages as never[]) ?? [],
      remotes: (r.remotes as never[]) ?? [],
      isFirstParty: !!r.is_first_party,
      vendorDomain: (r.vendor_domain as string) ?? null,
      iconUrl: r.icon_asset ? `${process.env.CDN_BASE ?? ''}/${r.icon_asset}` : null,
      category: (r.category as string) ?? null,
      pricingTier: (r.pricing_tier as CatalogueEntry['pricingTier']) ?? 'unknown',
      evidence: (r.evidence as CatalogueEntry['evidence']) ?? 'unverified',
      featuredRank: (r.featured_rank as number) ?? null,
      downloads: (r.downloads as number) ?? null,
      downloadsSource: (r.downloads_source as CatalogueEntry['downloadsSource']) ?? null,
      publishedAt: r.published_at ? new Date(r.published_at as string).toISOString() : null,
      updatedAt: new Date(r.updated_at as string).toISOString(),
      verifiedAt: r.verified_at ? new Date(r.verified_at as string).toISOString() : null
    }))
  }

  async publishSnapshot(meta: {
    digest: string
    url: string
    bytes: number
    entryCount: number
    cursor: string
  }): Promise<void> {
    // One transaction: a moment with two current snapshots, or none, would be
    // served to somebody.
    await this.sql.begin(async (tx) => {
      await tx`lock table published_registry_servers, published_curated in exclusive mode`
      await tx`delete from published_registry_servers`
      await tx`insert into published_registry_servers select * from registry_servers`
      await tx`delete from published_curated`
      await tx`insert into published_curated select * from curated`
      await tx`update snapshots set is_current = false where is_current`
      await tx`
        insert into snapshots (digest, url, bytes, entry_count, cursor, is_current)
        values (${meta.digest}, ${meta.url}, ${meta.bytes}, ${meta.entryCount}, ${meta.cursor}, true)
        on conflict (digest) do update set is_current = true, generated_at = now(), url = excluded.url, cursor = excluded.cursor, bytes = excluded.bytes, entry_count = excluded.entry_count
      `
    })
  }

  async close(): Promise<void> { await this.sql.end({ timeout: 5 }) }

  async acquireLock(): Promise<void> {
    // Dedicated connection so a session advisory lock cannot move between pool connections.
    const held = await this.sql.reserve()
    const [row] = await held`select pg_try_advisory_lock(824671) as acquired`
    if (!row?.acquired) { held.release(); throw new Error('Another catalogue sync is running') }
    this.releaseLock = async () => { await held`select pg_advisory_unlock(824671)`; held.release() }
  }
  releaseLock: (() => Promise<void>) | undefined

  async readSyncState(key: string): Promise<string | null> {
    const [row] = await this.sql<Array<{ value: string }>>`
      select value from sync_state where key = ${key}
    `
    return row?.value ?? null
  }

  async writeSyncState(key: string, value: string): Promise<void> {
    await this.sql`
      insert into sync_state (key, value) values (${key}, ${value})
      on conflict (key) do update set value = excluded.value
    `
  }

  async recordRun(r: StageResult): Promise<void> {
    await this.sql`
      insert into sync_runs (stage, started_at, finished_at, fetched, added, changed, removed, error)
      values (${r.stage}, ${r.startedAt}::timestamptz, ${r.finishedAt}::timestamptz,
              ${r.fetched}, ${r.added}, ${r.changed}, ${r.removed}, ${r.error})
    `
  }
}
