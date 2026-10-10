/**
 * The unified catalogue: registry mirror + operator overlay + custom entries,
 * queried as one list.
 *
 * The union happens in SQL rather than in the renderer so that paging, counting
 * and sorting stay correct across both halves. A UI that fetched two lists and
 * stitched them together would silently mis-sort and mis-count the moment
 * either side had more rows than the page size.
 */
import { randomUUID } from 'node:crypto'
import {
  emptyOverlay,
  type CatalogueItem,
  type CatalogueQuery,
  type CustomEntry,
  type EntrySource,
  type Overlay,
  type Tier
} from '@shared/catalogue'
import { displayTitle, type RegistryPackage, type RegistryRemote } from '@shared/registry'
import type { Db } from './index'

const parse = <T>(v: string | null | undefined, fallback: T): T => {
  if (v === null || v === undefined) return fallback
  try {
    return JSON.parse(v) as T
  } catch {
    return fallback
  }
}

export const newCustomId = (): string => `cst_${randomUUID().replace(/-/g, '').slice(0, 18)}`

/* --------------------------------- overlay -------------------------------- */

const toOverlay = (r: any, key: string): Overlay =>
  r
    ? {
        key,
        tier: (r.tier ?? 'unknown') as Tier,
        featuredRank: r.featured_rank,
        tags: parse<string[]>(r.tags, []),
        notes: r.notes ?? null,
        rating: r.rating,
        hidden: !!r.hidden,
        authObserved: r.auth_observed ?? null,
        updatedAt: r.updated_at ?? 0
      }
    : emptyOverlay(key)

export function getOverlay(db: Db, key: string): Overlay {
  return toOverlay(db.prepare('SELECT * FROM catalog_overlay WHERE key = ?').get(key), key)
}

export function saveOverlay(db: Db, patch: Partial<Overlay> & { key: string }): Overlay {
  const current = getOverlay(db, patch.key)
  const next: Overlay = { ...current, ...patch, updatedAt: Date.now() }
  db.prepare(
    `INSERT INTO catalog_overlay (key, tier, featured_rank, tags, notes, rating, hidden, auth_observed, updated_at)
     VALUES (@key, @tier, @featured_rank, @tags, @notes, @rating, @hidden, @auth_observed, @updated_at)
     ON CONFLICT(key) DO UPDATE SET
       tier = excluded.tier, featured_rank = excluded.featured_rank, tags = excluded.tags,
       notes = excluded.notes, rating = excluded.rating, hidden = excluded.hidden,
       auth_observed = excluded.auth_observed, updated_at = excluded.updated_at`
  ).run({
    key: next.key,
    tier: next.tier,
    featured_rank: next.featuredRank,
    tags: JSON.stringify(next.tags),
    notes: next.notes,
    rating: next.rating,
    hidden: next.hidden ? 1 : 0,
    auth_observed: next.authObserved,
    updated_at: next.updatedAt
  })
  return next
}

/** Keys currently carrying a given tag. Used to prune a stale directory. */
export function listKeysWithTag(db: Db, tag: string): string[] {
  return (
    db.prepare('SELECT key FROM catalog_overlay WHERE tags LIKE ?').all(`%"${tag}"%`) as Array<{ key: string }>
  ).map((r) => r.key)
}

export function listOfficialTagged(db: Db): string[] {
  return listKeysWithTag(db, 'official')
}

export function listTags(db: Db): string[] {
  const seen = new Set<string>()
  for (const row of db.prepare('SELECT tags FROM catalog_overlay').all() as Array<{ tags: string }>) {
    for (const tag of parse<string[]>(row.tags, [])) seen.add(tag)
  }
  return [...seen].sort()
}

/* ------------------------------ custom entries ---------------------------- */

const toCustom = (r: any): CustomEntry => ({
  id: r.id,
  source: r.source as Exclude<EntrySource, 'registry'>,
  title: r.title,
  description: r.description,
  command: r.command,
  args: parse<string[]>(r.args, []),
  env: parse<Record<string, string>>(r.env, {}),
  url: r.url,
  gitRef: r.git_ref,
  cwd: r.cwd,
  createdAt: r.created_at,
  updatedAt: r.updated_at
})

export function listCustomEntries(db: Db): CustomEntry[] {
  return (db.prepare('SELECT * FROM custom_entries ORDER BY title').all() as any[]).map(toCustom)
}

export function getCustomEntry(db: Db, id: string): CustomEntry | null {
  const row = db.prepare('SELECT * FROM custom_entries WHERE id = ?').get(id)
  return row ? toCustom(row) : null
}

export function saveCustomEntry(db: Db, entry: Omit<CustomEntry, 'createdAt' | 'updatedAt'>): CustomEntry {
  const now = Date.now()
  const existing = getCustomEntry(db, entry.id)
  db.prepare(
    `INSERT INTO custom_entries (id, source, title, description, command, args, env, url, git_ref, cwd, created_at, updated_at)
     VALUES (@id, @source, @title, @description, @command, @args, @env, @url, @git_ref, @cwd, @created_at, @updated_at)
     ON CONFLICT(id) DO UPDATE SET
       source = excluded.source, title = excluded.title, description = excluded.description,
       command = excluded.command, args = excluded.args, env = excluded.env, url = excluded.url,
       git_ref = excluded.git_ref, cwd = excluded.cwd, updated_at = excluded.updated_at`
  ).run({
    id: entry.id,
    source: entry.source,
    title: entry.title,
    description: entry.description,
    command: entry.command,
    args: JSON.stringify(entry.args),
    env: JSON.stringify(entry.env),
    url: entry.url,
    git_ref: entry.gitRef,
    cwd: entry.cwd,
    created_at: existing?.createdAt ?? now,
    updated_at: now
  })
  return getCustomEntry(db, entry.id)!
}

export function deleteCustomEntry(db: Db, id: string): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM custom_entries WHERE id = ?').run(id)
    db.prepare('DELETE FROM catalog_overlay WHERE key = ?').run(id)
  })
  tx()
}

/* ------------------------------- unified read ----------------------------- */

/**
 * One SELECT over both halves. Registry rows and custom rows are projected into
 * the same column list so filtering, counting and ordering apply to the union
 * rather than to either side alone.
 */
const UNIFIED = `
  SELECT
    c.name              AS key,
    'registry'          AS source,
    c.title             AS title,
    c.description       AS description,
    c.namespace         AS namespace,
    c.version           AS version,
    c.repository_url    AS repository_url,
    c.website_url       AS website_url,
    c.icon_url          AS icon_url,
    c.status            AS status,
    c.published_at      AS published_at,
    c.updated_at        AS updated_at,
    c.packages          AS packages,
    c.remotes           AS remotes,
    c.downloads         AS downloads,
    c.downloads_source  AS downloads_source,
    c.categories        AS categories,
    NULL                AS custom_id
  FROM catalog c
  UNION ALL
  SELECT
    e.id                AS key,
    e.source            AS source,
    e.title             AS title,
    e.description       AS description,
    NULL                AS namespace,
    ''                  AS version,
    CASE WHEN e.source = 'custom-git' THEN e.url ELSE NULL END AS repository_url,
    NULL                AS website_url,
    NULL                AS icon_url,
    'active'            AS status,
    e.created_at        AS published_at,
    e.updated_at        AS updated_at,
    CASE WHEN e.source = 'custom-remote' THEN '[]' ELSE '[{"registryType":"custom","identifier":"local"}]' END AS packages,
    CASE WHEN e.source = 'custom-remote' THEN '[{"type":"streamable-http","url":"' || COALESCE(e.url,'') || '"}]' ELSE '[]' END AS remotes,
    NULL                AS downloads,
    NULL                AS downloads_source,
    '["other"]'         AS categories,
    e.id                AS custom_id
  FROM custom_entries e
  WHERE NOT EXISTS (SELECT 1 FROM catalog c WHERE c.name = e.id)
`

const REQUIRED_MARKER = '%"isRequired":true%'

/**
 * Overlay columns are aliased rather than splatted with `o.*`. Both tables
 * carry `key` and `updated_at`, and in a duplicate-name result the later column
 * wins — so `o.*` would overwrite the entry's own updated_at, and null out its
 * key entirely whenever no overlay row existed.
 */
const OVERLAY_COLS = `
  o.tier          AS o_tier,
  o.featured_rank AS o_featured_rank,
  o.tags          AS o_tags,
  o.notes         AS o_notes,
  o.rating        AS o_rating,
  o.hidden        AS o_hidden,
  o.auth_observed AS o_auth_observed,
  o.updated_at    AS o_updated_at`

const overlayFromRow = (r: any, key: string): Overlay =>
  r.o_tier === null || r.o_tier === undefined
    ? emptyOverlay(key)
    : {
        key,
        tier: r.o_tier as Tier,
        featuredRank: r.o_featured_rank,
        tags: parse<string[]>(r.o_tags, []),
        notes: r.o_notes ?? null,
        rating: r.o_rating,
        hidden: !!r.o_hidden,
        authObserved: r.o_auth_observed ?? null,
        updatedAt: r.o_updated_at ?? 0
      }

const itemFromRow = (db: Db, r: any): CatalogueItem => ({
  key: r.key,
  source: r.source as EntrySource,
  // Derived on read, not trusted from storage: a row synced by an older build
  // holds whatever the registry sent, and many first-party publishers send the
  // literal string "mcp". Deriving here means titles are correct immediately
  // rather than after a multi-minute backfill.
  title: r.source === 'registry' ? displayTitle(r.key, r.title) : r.title,
  description: r.description,
  namespace: r.namespace,
  version: r.version ?? '',
  repositoryUrl: r.repository_url,
  websiteUrl: r.website_url,
  iconUrl: r.icon_url,
  status: r.status,
  publishedAt: r.published_at,
  updatedAt: r.updated_at,
  packages: parse<RegistryPackage[]>(r.packages, []),
  remotes: parse<RegistryRemote[]>(r.remotes, []),
  downloads: r.downloads,
  downloadsSource: r.downloads_source,
  categories: parse<string[]>(r.categories, []),
  overlay: overlayFromRow(r, r.key),
  custom: r.custom_id ? getCustomEntry(db, r.custom_id) : null
})

export function queryCatalogue(db: Db, q: CatalogueQuery): { items: CatalogueItem[]; total: number } {
  const where: string[] = []
  const params: Record<string, unknown> = {}

  if (!q.includeHidden) where.push('COALESCE(o.hidden, 0) = 0')
  where.push("u.status = 'active'")

  if (q.search) {
    where.push('(u.key LIKE @search OR u.title LIKE @search OR u.description LIKE @search)')
    params.search = `%${q.search}%`
  }
  if (q.category) {
    where.push('u.categories LIKE @category')
    params.category = `%"${q.category}"%`
  }
  if (q.hosting === 'local') where.push("u.packages != '[]'")
  if (q.hosting === 'hosted') where.push("u.remotes != '[]'")
  if (q.requirement === 'needs-credentials') {
    where.push('(u.packages LIKE @req OR u.remotes LIKE @req)')
    params.req = REQUIRED_MARKER
  }
  if (q.requirement === 'standalone') {
    where.push('(u.packages NOT LIKE @req AND u.remotes NOT LIKE @req)')
    params.req = REQUIRED_MARKER
  }
  if (q.tier) {
    where.push("COALESCE(o.tier, 'unknown') = @tier")
    params.tier = q.tier
  }
  if (q.source) {
    where.push('u.source = @source')
    params.source = q.source
  }
  if (q.tag) {
    where.push('o.tags LIKE @tag')
    params.tag = `%"${q.tag}"%`
  }
  if (q.featuredOnly) where.push('o.featured_rank IS NOT NULL')
  // `catalogue_key` records where an installed server came from, so this is an
  // exact match rather than a guess based on the name.
  if (q.installedOnly) {
    where.push('u.key IN (SELECT catalogue_key FROM servers WHERE catalogue_key IS NOT NULL)')
  }

  const clause = `WHERE ${where.join(' AND ')}`
  const base = `FROM (${UNIFIED}) u LEFT JOIN catalog_overlay o ON o.key = u.key ${clause}`

  const order = (() => {
    switch (q.sort) {
      case 'downloads':
        return 'u.downloads DESC NULLS LAST, u.updated_at DESC'
      case 'rating':
        return 'o.rating DESC NULLS LAST, u.downloads DESC NULLS LAST'
      case 'newest':
        return 'u.published_at DESC NULLS LAST'
      case 'updated':
        return 'u.updated_at DESC NULLS LAST'
      case 'name':
        return 'u.title ASC'
      case 'relevance':
        return 'CASE WHEN u.key LIKE @search THEN 0 ELSE 1 END, u.downloads DESC NULLS LAST'
      case 'featured':
      default:
        // Curated picks in the operator's order, then real usage.
        return 'o.featured_rank ASC NULLS LAST, u.downloads DESC NULLS LAST, u.title ASC'
    }
  })()

  const total = (db.prepare(`SELECT COUNT(*) AS c ${base}`).get(params) as { c: number }).c

  const rows = db
    .prepare(`SELECT u.*, ${OVERLAY_COLS} ${base} ORDER BY ${order} LIMIT @limit OFFSET @offset`)
    .all({
      ...params,
      search: params.search ?? '',
      limit: Math.min(q.limit ?? 60, 200),
      offset: q.offset ?? 0
    }) as any[]

  return { items: rows.map((r) => itemFromRow(db, r)), total }
}

export function getCatalogueItem(db: Db, key: string): CatalogueItem | null {
  const row = db
    .prepare(
      `SELECT u.*, ${OVERLAY_COLS}
       FROM (${UNIFIED}) u LEFT JOIN catalog_overlay o ON o.key = u.key
       WHERE u.key = ? LIMIT 1`
    )
    .get(key) as any
  return row ? itemFromRow(db, row) : null
}

/**
 * The registry entry that serves a specific endpoint, if there is one.
 *
 * Matching on the *domain* alone was wrong: Google publishes five products
 * under googleapis.com, so a domain match returned an arbitrary one — the
 * Android Management API got promoted in place of Drive, Gmail and Sheets. The
 * host has to match exactly.
 */
export function findFirstPartyByEndpoint(db: Db, endpointUrl: string, domain: string): string | null {
  let wantHost: string
  let wantPath: string
  try {
    const u = new URL(endpointUrl)
    wantHost = u.host.toLowerCase()
    wantPath = u.pathname.replace(/\/$/, '')
  } catch {
    return null
  }
  const reversed = domain.split('.').reverse().join('.')
  const rows = db
    .prepare(
      `SELECT name, namespace, remotes FROM catalog
       WHERE status = 'active' AND (namespace = @ns OR namespace LIKE @nsPrefix)`
    )
    .all({ ns: reversed, nsPrefix: `${reversed}.%` }) as Array<{
    name: string
    namespace: string
    remotes: string
  }>

  for (const row of rows) {
    let urls: string[] = []
    try {
      urls = (JSON.parse(row.remotes) as Array<{ url?: string }>).map((r) => r.url ?? '').filter(Boolean)
    } catch {
      continue
    }
    for (const url of urls) {
      try {
        const u = new URL(url)
        if (u.host.toLowerCase() !== wantHost) continue
        // Same host and same path is the same server; a different path under
        // the same host is a different product.
        if (u.pathname.replace(/\/$/, '') === wantPath) return row.name
      } catch {
        continue
      }
    }
  }
  return null
}

export function catalogueFacetCounts(db: Db): {
  total: number
  bySource: Record<string, number>
  byTier: Record<string, number>
  featured: number
  custom: number
} {
  const rows = db
    .prepare(
      `SELECT u.source AS source, COALESCE(o.tier,'unknown') AS tier,
              CASE WHEN o.featured_rank IS NOT NULL THEN 1 ELSE 0 END AS featured
       FROM (${UNIFIED}) u LEFT JOIN catalog_overlay o ON o.key = u.key
       WHERE u.status = 'active' AND COALESCE(o.hidden,0) = 0`
    )
    .all() as Array<{ source: string; tier: string; featured: number }>

  const bySource: Record<string, number> = {}
  const byTier: Record<string, number> = {}
  let featured = 0
  for (const r of rows) {
    bySource[r.source] = (bySource[r.source] ?? 0) + 1
    byTier[r.tier] = (byTier[r.tier] ?? 0) + 1
    featured += r.featured
  }
  return {
    total: rows.length,
    bySource,
    byTier,
    featured,
    custom: rows.filter((r) => r.source !== 'registry').length
  }
}
