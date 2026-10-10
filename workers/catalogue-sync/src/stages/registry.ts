/**
 * Stage 1: mirror the registry.
 *
 * Critical — if this fails there is nothing to publish, and the run aborts.
 *
 * A full pass tracks every key it saw so anything absent can be soft-deleted.
 * An incremental pass must NOT do that: it only asks for entries changed since
 * a timestamp, so "not seen" means "not changed", and deleting on that basis
 * would empty the catalogue on the first incremental run.
 */
import { crawl, displayTitle, kindOf } from '@bridge/registry'
import type { RegistryEntry } from '@bridge/registry'
import { officialMeta } from '@bridge/registry'
import type { Stage, StageContext } from '../stages'
import type { CatalogueStore, ServerRow } from '../store'

export const LAST_SYNC_KEY = 'registry.lastSync'

/** The registry's own name is the key; everything else is derived from it. */
export function toRow(entry: RegistryEntry): ServerRow {
  const s = entry.server
  const meta = officialMeta(entry)
  const slash = s.name.indexOf('/')
  return {
    key: s.name,
    namespace: slash > 0 ? s.name.slice(0, slash) : null,
    title: displayTitle(s.name, s.title),
    description: (s.description ?? '').trim(),
    version: s.version ?? null,
    repositoryUrl: s.repository?.url ?? null,
    websiteUrl: s.websiteUrl ?? null,
    status: meta.status ?? 'active',
    packages: s.packages ?? [],
    remotes: s.remotes ?? [],
    publishedAt: meta.publishedAt ?? null,
    sourceUpdatedAt: meta.updatedAt ?? null
  }
}

export interface RegistryStageOptions {
  store: CatalogueStore
  full: boolean
  fetchImpl?: typeof fetch
  baseUrl?: string
  maxPages?: number
  /** Rows per upsert. Batched so a 27,000-entry pass is not one transaction. */
  batchSize?: number
}

export function registryStage(opts: RegistryStageOptions): Stage {
  return {
    name: 'registry',
    async run(ctx: StageContext) {
      const startedAtIso = ctx.now().toISOString()
      const since = opts.full ? null : await opts.store.readSyncState(LAST_SYNC_KEY)
      const seen = new Set<string>()
      let fetched = 0
      let added = 0
      let changed = 0
      let batch: ServerRow[] = []

      const flush = async (): Promise<void> => {
        if (batch.length === 0) return
        const out = await opts.store.upsertServers(batch)
        added += out.added
        changed += out.changed
        batch = []
      }

      for await (const page of crawl({
        updatedSince: since,
        fetchImpl: opts.fetchImpl,
        baseUrl: opts.baseUrl,
        maxPages: opts.maxPages
      })) {
        for (const entry of page.entries) {
          // A nameless entry has no key, so it cannot be stored or addressed.
          if (!entry.server?.name) continue
          const row = toRow(entry)
          seen.add(row.key)
          batch.push(row)
          fetched++
          if (batch.length >= (opts.batchSize ?? 500)) await flush()
        }
        ctx.log(`registry: ${fetched} entries`)
      }
      await flush()

      // Only a full pass knows what is absent.
      const removed = opts.full ? await opts.store.markMissingDeleted(seen) : 0

      // Written only on success: a failed pass must resume, not skip.
      await opts.store.writeSyncState(LAST_SYNC_KEY, startedAtIso)

      return { fetched, added, changed, removed, error: null }
    }
  }
}

/** Exposed for the orchestrator's decision about whether to do a full pass. */
export const kindOfEntry = kindOf
