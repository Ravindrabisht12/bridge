/** Catalogue content comes from the configured Bridge service; never crawl vendors. */
import type { CatalogueEntry, SnapshotMeta } from '@bridge/types'
import type { CatalogEntry } from '@shared/registry'
import { readSettings } from '../../db/repo'
import type { FileLogger } from '@shared/logger'
import type { SyncProgress } from '@shared/syncprogress'
import type { Db } from '../../db'
import * as catalog from '../../db/catalog'
import { decodeSnapshot, limitedFetch, searchService, serviceUrl } from './catalogue-client'
export type { SyncProgress }

const localKey = (key: string): string => key.startsWith('bridge:off_') ? key.slice(7) : key

export function mergeServiceEntries(db: Db, entries: CatalogueEntry[]): void {
  const now = Date.now()
  const rows = entries.map((entry): CatalogEntry => ({
    name: localKey(entry.key), title: entry.title, description: entry.description, namespace: entry.namespace ?? '',
    version: entry.version ?? '', repositoryUrl: entry.repositoryUrl, websiteUrl: entry.websiteUrl,
    status: entry.status as CatalogEntry['status'], publishedAt: entry.publishedAt ? Date.parse(entry.publishedAt) : null, updatedAt: Date.parse(entry.updatedAt),
    packages: entry.packages, remotes: entry.remotes, iconUrl: entry.iconUrl,
    downloads: entry.downloads, downloadsSource: entry.downloadsSource,
    categories: entry.category ? [entry.category] : [], syncedAt: now,
    kind: entry.packages.length ? (entry.remotes.length ? 'both' : 'stdio') : (entry.remotes.length ? 'remote' : 'none')
  }))
  catalog.upsertCatalog(db, rows)
  for (const row of rows) catalog.setDownloads(db, row.name, row.downloads, row.downloadsSource)
}

export class RegistrySync {
  private running = false
  private aborter = new AbortController()
  private readonly searches = new Map<string, string | null>()
  constructor(private readonly db: Db, private readonly log: FileLogger, private readonly onProgress: (p: SyncProgress) => void) {}
  get isRunning(): boolean { return this.running }
  private baseUrl(): string {
    const raw = process.env.BRIDGE_API_URL || readSettings(this.db).catalogueSourceUrl
    if (!raw || raw.includes('registry.modelcontextprotocol.io')) throw new Error('Set the Bridge catalogue service URL in Settings. Your saved library remains available offline.')
    return serviceUrl(raw)
  }
  abort(): void { this.aborter.abort() }

  /** Repeating the same search fetches its next page, up to the API's search cap. */
  async searchRemote(term: string): Promise<{ found: number; error?: string }> {
    const query = term.trim()
    if (query.length < 2) return { found: 0 }
    try {
      const cursor = this.searches.get(query) ?? null
      const page = await searchService(this.baseUrl(), query, cursor, AbortSignal.any([this.aborter.signal, AbortSignal.timeout(30_000)]))
      mergeServiceEntries(this.db, page.items)
      this.searches.set(query, page.nextCursor)
      return { found: page.items.length }
    } catch (err) { return { found: 0, error: (err as Error).message } }
  }

  async sync(_full = false): Promise<SyncProgress> {
    if (this.running) return { phase: 'servers', fetched: 0, total: null, message: 'A sync is already running.' }
    this.running = true
    this.aborter = new AbortController()
    try {
      const base = this.baseUrl()
      const signal = AbortSignal.any([this.aborter.signal, AbortSignal.timeout(30_000)])
      this.onProgress({ phase: 'servers', fetched: 0, total: null })
      const meta: SnapshotMeta = JSON.parse((await limitedFetch(`${base}/v1/snapshot/latest`, signal)).toString('utf8'))
      const source = serviceUrl(meta.url)
      if (catalog.readSyncState(this.db, 'service.digest') !== meta.digest) {
        const entries = decodeSnapshot(await limitedFetch(source, signal), meta)
        this.db.transaction(() => {
          const previous: string[] = JSON.parse(catalog.readSyncState(this.db, 'service.keys') ?? '[]')
          const keys = new Set(entries.map((entry) => localKey(entry.key)))
          mergeServiceEntries(this.db, entries)
          // Only remove rows previously owned by this snapshot. User overlays and custom entries survive.
          const remove = this.db.prepare('DELETE FROM catalog WHERE name = ?')
          for (const key of previous) if (!keys.has(key)) remove.run(key)
          catalog.writeSyncState(this.db, 'service.keys', JSON.stringify([...keys]))
          catalog.writeSyncState(this.db, 'service.digest', meta.digest)
          catalog.writeSyncState(this.db, 'service.assetOrigin', new URL(source).origin)
        })()
      }
      catalog.writeSyncState(this.db, 'registry.lastSync', new Date().toISOString())
      const done: SyncProgress = { phase: 'done', fetched: meta.entryCount, total: meta.entryCount }
      this.onProgress(done)
      return done
    } catch (err) {
      const failed: SyncProgress = { phase: 'error', fetched: 0, total: null, message: (err as Error).message }
      this.log.warn('Catalogue sync failed; retaining the local library')
      this.onProgress(failed)
      return failed
    } finally { this.running = false }
  }
}
