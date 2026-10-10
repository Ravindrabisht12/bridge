import type { CatalogEntry, RegistryPackage, RegistryRemote } from '@shared/registry'
import type { ClientId } from '@shared/types'
import type { Db } from './index'

const parse = <T>(v: string | null | undefined, fallback: T): T => {
  if (v === null || v === undefined) return fallback
  try {
    return JSON.parse(v) as T
  } catch {
    return fallback
  }
}

const toEntry = (r: any): CatalogEntry => ({
  name: r.name,
  title: r.title,
  description: r.description,
  version: r.version,
  namespace: r.namespace,
  repositoryUrl: r.repository_url,
  websiteUrl: r.website_url,
  status: r.status,
  publishedAt: r.published_at,
  updatedAt: r.updated_at,
  kind: r.kind,
  packages: parse<RegistryPackage[]>(r.packages, []),
  remotes: parse<RegistryRemote[]>(r.remotes, []),
  iconUrl: r.icon_url ?? null,
  downloads: r.downloads,
  downloadsSource: r.downloads_source,
  categories: parse<string[]>(r.categories, []),
  syncedAt: r.synced_at
})

export function upsertCatalog(db: Db, entries: readonly CatalogEntry[]): number {
  const stmt = db.prepare(
    `INSERT INTO catalog (
       name, title, description, version, namespace, repository_url, website_url, status,
       published_at, updated_at, kind, packages, remotes, downloads, downloads_source,
       categories, synced_at, icon_url
     ) VALUES (
       @name, @title, @description, @version, @namespace, @repository_url, @website_url, @status,
       @published_at, @updated_at, @kind, @packages, @remotes, @downloads, @downloads_source,
       @categories, @synced_at, @icon_url
     )
     ON CONFLICT(name) DO UPDATE SET
       title = excluded.title, description = excluded.description, version = excluded.version,
       namespace = excluded.namespace, repository_url = excluded.repository_url,
       website_url = excluded.website_url, status = excluded.status,
       published_at = excluded.published_at, updated_at = excluded.updated_at,
       kind = excluded.kind, packages = excluded.packages, remotes = excluded.remotes,
       categories = excluded.categories, synced_at = excluded.synced_at,
       icon_url = excluded.icon_url`
  )
  const tx = db.transaction((rows: readonly CatalogEntry[]) => {
    for (const e of rows) {
      stmt.run({
        name: e.name,
        title: e.title,
        description: e.description,
        version: e.version,
        namespace: e.namespace,
        repository_url: e.repositoryUrl,
        website_url: e.websiteUrl,
        status: e.status,
        published_at: e.publishedAt,
        updated_at: e.updatedAt,
        kind: e.kind,
        packages: JSON.stringify(e.packages),
        remotes: JSON.stringify(e.remotes),
        downloads: e.downloads,
        downloads_source: e.downloadsSource,
        categories: JSON.stringify(e.categories),
        synced_at: e.syncedAt,
        icon_url: e.iconUrl
      })
    }
  })
  tx(entries)
  return entries.length
}

/**
 * Packaged entries that have no usage figure yet. Enrichment is spread across
 * syncs rather than done in one pass: there are thousands of them and each
 * needs its own request to npm or PyPI.
 */
export function pickForEnrichment(db: Db, limit: number): CatalogEntry[] {
  return (
    db
      .prepare(
        `SELECT * FROM catalog
         WHERE downloads IS NULL
           AND kind IN ('stdio','both')
           AND (packages LIKE '%"npm"%' OR packages LIKE '%"pypi"%')
         ORDER BY updated_at DESC NULLS LAST
         LIMIT ?`
      )
      .all(limit) as any[]
  ).map(toEntry)
}

export function setDownloads(db: Db, name: string, downloads: number | null, source: string | null): void {
  db.prepare('UPDATE catalog SET downloads = ?, downloads_source = ? WHERE name = ?').run(downloads, source, name)
}

export interface CatalogQuery {
  search?: string
  category?: string
  /** 'stdio' runs locally, 'remote' is publisher-hosted. */
  kind?: 'stdio' | 'remote'
  /** 'standalone' declares no required credentials; 'needs-credentials' does. */
  requirement?: 'standalone' | 'needs-credentials'
  sort?: 'relevance' | 'downloads' | 'newest' | 'updated' | 'name'
  limit?: number
  offset?: number
  /** Hide deprecated and withdrawn entries. Default true. */
  activeOnly?: boolean
}

export function queryCatalog(db: Db, q: CatalogQuery): { entries: CatalogEntry[]; total: number } {
  const where: string[] = []
  const params: Record<string, unknown> = {}

  if (q.activeOnly !== false) where.push("status = 'active'")
  if (q.search) {
    where.push('(name LIKE @search OR title LIKE @search OR description LIKE @search)')
    params.search = `%${q.search}%`
  }
  if (q.category) {
    where.push('categories LIKE @category')
    params.category = `%"${q.category}"%`
  }
  if (q.kind === 'stdio') where.push("kind IN ('stdio','both')")
  if (q.kind === 'remote') where.push("kind IN ('remote','both')")

  // Required credentials are nested inside the packages/remotes JSON, so this
  // narrows in SQL and `facetsOf` decides precisely in the renderer.
  if (q.requirement === 'needs-credentials') {
    where.push("(packages LIKE '%\"isRequired\":true%' OR remotes LIKE '%\"isRequired\":true%')")
  }
  if (q.requirement === 'standalone') {
    where.push("(packages NOT LIKE '%\"isRequired\":true%' AND remotes NOT LIKE '%\"isRequired\":true%')")
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const order =
    q.sort === 'downloads'
      ? 'downloads DESC NULLS LAST, updated_at DESC'
      : q.sort === 'newest'
        ? 'published_at DESC NULLS LAST'
        : q.sort === 'name'
          ? 'name ASC'
          : q.sort === 'updated'
            ? 'updated_at DESC NULLS LAST'
            : // relevance: exact-ish name matches first, then usage
              'CASE WHEN name LIKE @search THEN 0 ELSE 1 END, downloads DESC NULLS LAST, updated_at DESC'

  const total = (db.prepare(`SELECT COUNT(*) AS c FROM catalog ${clause}`).get(params) as { c: number }).c

  const entries = (
    db
      .prepare(
        `SELECT * FROM catalog ${clause} ORDER BY ${q.sort === 'relevance' && !q.search ? 'downloads DESC NULLS LAST' : order}
         LIMIT @limit OFFSET @offset`
      )
      .all({ ...params, search: params.search ?? '', limit: Math.min(q.limit ?? 50, 200), offset: q.offset ?? 0 }) as any[]
  ).map(toEntry)

  return { entries, total }
}

export function getCatalogEntry(db: Db, name: string): CatalogEntry | null {
  const row = db.prepare('SELECT * FROM catalog WHERE name = ?').get(name)
  return row ? toEntry(row) : null
}

export function catalogStats(db: Db): {
  total: number
  lastSyncedAt: number | null
  withDownloads: number
  needsBackfill: boolean
  byCategory: Array<{ id: string; count: number }>
} {
  const total = (db.prepare('SELECT COUNT(*) c FROM catalog').get() as { c: number }).c
  const last = db.prepare('SELECT MAX(synced_at) s FROM catalog').get() as { s: number | null }
  const withDownloads = (db.prepare('SELECT COUNT(*) c FROM catalog WHERE downloads IS NOT NULL').get() as { c: number }).c

  const counts = new Map<string, number>()
  for (const row of db.prepare('SELECT categories FROM catalog').all() as Array<{ categories: string }>) {
    for (const id of parse<string[]>(row.categories, [])) counts.set(id, (counts.get(id) ?? 0) + 1)
  }

  // Set by the sync once it has stored every field this build captures.
  const shape = readSyncState(db, 'registry.shape')

  return {
    total,
    lastSyncedAt: last.s,
    withDownloads,
    needsBackfill: total > 0 && shape !== '3',
    byCategory: [...counts.entries()]
      .map(([id, count]) => ({ id, count }))
      .sort((a, b) => b.count - a.count)
  }
}

/* ------------------------------ sync state ------------------------------- */

export function readSyncState(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function writeSyncState(db: Db, key: string, value: string): void {
  db.prepare(
    'INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value)
}

/* ---------------------------- client wiring ------------------------------ */

export interface ServerClientLink {
  serverId: string
  client: ClientId
  installed: boolean
  updatedAt: number
}

export function listServerClients(db: Db, serverId?: string): ServerClientLink[] {
  const rows = serverId
    ? (db.prepare('SELECT * FROM server_clients WHERE server_id = ?').all(serverId) as any[])
    : (db.prepare('SELECT * FROM server_clients').all() as any[])
  return rows.map((r) => ({
    serverId: r.server_id,
    client: r.client as ClientId,
    installed: !!r.installed,
    updatedAt: r.updated_at
  }))
}

export function setServerClient(db: Db, serverId: string, client: ClientId, installed: boolean): void {
  db.prepare(
    `INSERT INTO server_clients (server_id, client, installed, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(server_id, client) DO UPDATE SET installed = excluded.installed, updated_at = excluded.updated_at`
  ).run(serverId, client, installed ? 1 : 0, Date.now())
}

export function deleteServerClients(db: Db, serverId: string): void {
  db.prepare('DELETE FROM server_clients WHERE server_id = ?').run(serverId)
}

/* ------------------------------ icon memory ------------------------------- */

export interface IconResolution {
  iconUrl: string | null
  resolvedAt: number
}

/**
 * Every remembered icon decision, for loading into memory at startup.
 *
 * Read in one go rather than per domain: the table is small (one row per
 * vendor) and the Library asks about sixty domains at once, so sixty prepared
 * statements would cost more than the single scan.
 */
export function allIconResolutions(db: Db): Map<string, IconResolution> {
  const rows = db
    .prepare('SELECT domain, icon_url AS iconUrl, resolved_at AS resolvedAt FROM icon_resolution')
    .all() as Array<{ domain: string; iconUrl: string | null; resolvedAt: number }>
  return new Map(rows.map((r) => [r.domain, { iconUrl: r.iconUrl, resolvedAt: r.resolvedAt }]))
}

export function rememberIcon(db: Db, domain: string, iconUrl: string | null): void {
  db.prepare(
    `INSERT INTO icon_resolution (domain, icon_url, resolved_at) VALUES (?, ?, ?)
     ON CONFLICT(domain) DO UPDATE SET icon_url = excluded.icon_url, resolved_at = excluded.resolved_at`
  ).run(domain, iconUrl, Date.now())
}
