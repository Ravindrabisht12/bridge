/**
 * `PostgresRepository` against real Postgres.
 *
 * The route tests use the memory repository, which proves the HTTP contract.
 * This proves the SQL: the ranking, the keyset pagination, the view that folds
 * curation into the registry mirror, and the constraints that refuse a verified
 * seal with no evidence behind it.
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startTestDatabase, type TestDatabase } from '@bridge/pgtest'
import { PostgresRepository } from '../src/postgres-repository'
import { decodeCursor } from '../src/cursor'

const MIGRATIONS = join(import.meta.dirname, '..', '..', '..', 'infrastructure', 'supabase', 'migrations')

let db: TestDatabase
let repo: PostgresRepository

/** Inserts through raw SQL, so the repository is only ever the thing read. */
async function seed(
  key: string,
  opts: {
    title?: string
    description?: string
    updatedAt?: string
    remotes?: unknown[]
    curated?: { firstParty?: boolean; domain?: string; evidence?: string; rank?: number; category?: string }
    deleted?: boolean
  } = {}
): Promise<void> {
  await db.raw.query(
    `insert into registry_servers (key, namespace, title, description, status, remotes, updated_at, deleted_at)
     values ($1, split_part($1,'/',1), $2, $3, 'active', $4::jsonb, $5::timestamptz, $6::timestamptz)`,
    [
      key,
      opts.title ?? key,
      opts.description ?? '',
      JSON.stringify(opts.remotes ?? []),
      opts.updatedAt ?? '2026-01-01T00:00:00Z',
      opts.deleted ? '2026-01-02T00:00:00Z' : null
    ]
  )
  if (opts.curated) {
    const c = opts.curated
    await db.raw.query(
      `insert into curated (key, is_first_party, vendor_domain, evidence, featured_rank, category)
       values ($1, $2, $3, $4, $5, $6)`,
      [key, c.firstParty ?? false, c.domain ?? null, c.evidence ?? 'unverified', c.rank ?? null, c.category ?? null]
    )
  }
}

beforeAll(async () => {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()
  db = await startTestDatabase(files.map((f) => join(MIGRATIONS, f)))
  repo = new PostgresRepository(db.url, { staging: true })
}, 60_000)

afterAll(async () => {
  await db?.close()
})

beforeEach(async () => {
  await db.reset()
})

describe('search ranking', () => {
  beforeEach(async () => {
    await seed('a/notion', { title: 'Notion', curated: { firstParty: true, domain: 'notion.com', evidence: 'mcp-oauth' } })
    await seed('b/notion-clone', { title: 'Notion Clone' })
    await seed('c/other', { title: 'Something', description: 'integrates with Notion somehow' })
  })

  it('puts an exact name match first', async () => {
    // Someone typing "notion" wants Notion, not the forty servers whose
    // description mentions it.
    const page = await repo.search({ q: 'Notion', firstPartyOnly: false, category: null, limit: 10, cursor: null })
    expect(page.items[0]!.title).toBe('Notion')
  })

  it('finds a description-only match too', async () => {
    const page = await repo.search({ q: 'notion', firstPartyOnly: false, category: null, limit: 10, cursor: null })
    expect(page.items.map((i) => i.title)).toContain('Something')
  })

  it('matches a substring the tsvector would miss', async () => {
    // pg_trgm on title is why "otio" finds Notion; full-text alone would not.
    await seed('d/x', { title: 'Notionary' })
    const page = await repo.search({ q: 'otion', firstPartyOnly: false, category: null, limit: 10, cursor: null })
    expect(page.items.length).toBeGreaterThan(0)
  })

  it('restricts to the verified set on request', async () => {
    const page = await repo.search({ q: 'notion', firstPartyOnly: true, category: null, limit: 10, cursor: null })
    expect(page.items).toHaveLength(1)
    expect(page.items[0]!.isFirstParty).toBe(true)
  })

  it('never returns a soft-deleted entry', async () => {
    await seed('z/gone', { title: 'Notion Deleted', deleted: true })
    const page = await repo.search({ q: 'notion', firstPartyOnly: false, category: null, limit: 20, cursor: null })
    expect(page.items.map((i) => i.key)).not.toContain('z/gone')
  })

  it('filters by category', async () => {
    await seed('e/cat', { title: 'Notion Thing', curated: { category: 'productivity' } })
    const page = await repo.search({ q: 'notion', firstPartyOnly: false, category: 'productivity', limit: 10, cursor: null })
    expect(page.items.map((i) => i.key)).toEqual(['e/cat'])
  })
})

describe('search pagination', () => {
  beforeEach(async () => {
    // Same title on all of them, so ordering falls to the key tiebreak and
    // paging is deterministic.
    for (let i = 0; i < 7; i++) await seed(`p/${i}`, { title: `Paging ${i}` })
  })

  it('page two is not page one', async () => {
    // The bug this exists for: `offset ${cursor ? 0 : 0}` was a no-op, so the
    // nextCursor was handed out and then ignored, and every page was page one.
    const first = await repo.search({ q: 'Paging', firstPartyOnly: false, category: null, limit: 3, cursor: null })
    expect(first.items).toHaveLength(3)
    expect(first.nextCursor).not.toBeNull()

    const second = await repo.search({
      q: 'Paging', firstPartyOnly: false, category: null, limit: 3, cursor: first.nextCursor
    })
    const a = first.items.map((i) => i.key)
    const b = second.items.map((i) => i.key)
    expect(b).not.toEqual(a)
    expect(a.filter((k) => b.includes(k))).toEqual([])
  })

  it('walks every match exactly once', async () => {
    const seen: string[] = []
    let cursor: string | null = null
    for (let guard = 0; guard < 10; guard++) {
      const page = await repo.search({ q: 'Paging', firstPartyOnly: false, category: null, limit: 2, cursor })
      seen.push(...page.items.map((i) => i.key))
      cursor = page.nextCursor
      if (!cursor) break
    }
    expect(seen).toHaveLength(7)
    expect(new Set(seen).size).toBe(7)
  })

  it('stops offering pages at the end', async () => {
    const page = await repo.search({ q: 'Paging', firstPartyOnly: false, category: null, limit: 50, cursor: null })
    expect(page.nextCursor).toBeNull()
  })
})

describe('the catalogue_entries view', () => {
  it('does not null the key when there is no curation row', async () => {
    // `select r.*, c.*` was a real bug in the desktop app: duplicate key and
    // updated_at meant a missing overlay nulled the entry's own key. The view
    // aliases every column explicitly so it cannot recur.
    await seed('a/bare', { title: 'Bare' })
    const entry = await repo.get('a/bare')
    expect(entry?.key).toBe('a/bare')
    expect(entry?.title).toBe('Bare')
    expect(entry?.isFirstParty).toBe(false)
    expect(entry?.evidence).toBe('unverified')
    expect(entry?.pricingTier).toBe('unknown')
  })

  it('folds curation in when it exists', async () => {
    await seed('a/curated', {
      title: 'Curated',
      curated: { firstParty: true, domain: 'vendor.com', evidence: 'mcp-open', rank: 3, category: 'dev' }
    })
    const entry = await repo.get('a/curated')
    expect(entry).toMatchObject({
      isFirstParty: true, vendorDomain: 'vendor.com', evidence: 'mcp-open', featuredRank: 3, category: 'dev'
    })
  })

  it('serves the later of the two updated_at values', async () => {
    // A curation edit alone must reach clients. If the served timestamp used
    // the registry's clock, a new category or a fresh verification would never
    // appear in a delta.
    await seed('a/one', { updatedAt: '2026-01-01T00:00:00Z', curated: { category: 'dev' } })
    await db.raw.query(`update curated set updated_at = '2026-06-01T00:00:00Z' where key = 'a/one'`)
    const entry = await repo.get('a/one')
    expect(entry!.updatedAt).toBe('2026-06-01T00:00:00.000Z')
  })

  it('returns null for an unknown key rather than throwing', async () => {
    expect(await repo.get('nope/nope')).toBeNull()
  })
})

describe('the first-party constraints', () => {
  it('refuses a verified seal with no evidence behind it', async () => {
    // The one piece of bad data that would actively mislead a user, so the
    // database refuses it rather than trusting the code above it.
    await seed('a/one')
    await expect(
      db.raw.query(
        `insert into curated (key, is_first_party, vendor_domain, evidence)
         values ('a/one', true, 'vendor.com', 'unverified')`
      )
    ).rejects.toThrow(/curated_first_party_needs_evidence/)
  })

  it('refuses first-party with no vendor domain', async () => {
    await seed('b/two')
    await expect(
      db.raw.query(
        `insert into curated (key, is_first_party, evidence) values ('b/two', true, 'mcp-open')`
      )
    ).rejects.toThrow(/curated_first_party_needs_domain/)
  })

  it('allows an unverified entry with no domain', async () => {
    await seed('c/three')
    await expect(
      db.raw.query(`insert into curated (key, is_first_party) values ('c/three', false)`)
    ).resolves.toBeTruthy()
  })
})

describe('featured', () => {
  it('orders by editorial rank and excludes the unranked', async () => {
    await seed('a/third', { title: 'Third', curated: { rank: 3 } })
    await seed('b/first', { title: 'First', curated: { rank: 1 } })
    await seed('c/none', { title: 'Unranked', curated: {} })
    const items = await repo.featured(10)
    expect(items.map((i) => i.title)).toEqual(['First', 'Third'])
  })
})

describe('delta', () => {
  beforeEach(async () => {
    await seed('a/one', { updatedAt: '2026-01-01T00:00:00Z' })
    await seed('b/two', { updatedAt: '2026-02-01T00:00:00Z' })
    await seed('c/three', { updatedAt: '2026-03-01T00:00:00Z' })
  })

  it('returns everything with no cursor, oldest first', async () => {
    const d = await repo.delta({ since: null, limit: 10 })
    expect(d.changed.map((e) => e.key)).toEqual(['a/one', 'b/two', 'c/three'])
    expect(d.hasMore).toBe(false)
  })

  it('pages by keyset without repeating or skipping', async () => {
    const first = await repo.delta({ since: null, limit: 2 })
    expect(first.changed.map((e) => e.key)).toEqual(['a/one', 'b/two'])
    expect(first.hasMore).toBe(true)

    const second = await repo.delta({ since: first.cursor, limit: 2 })
    expect(second.changed.map((e) => e.key)).toEqual(['c/three'])
    expect(second.hasMore).toBe(false)
  })

  it('breaks timestamp ties by key, so a batch write does not stall paging', async () => {
    // A worker upserting 3,000 rows in one transaction gives them all the same
    // updated_at. A cursor of the timestamp alone would loop forever or drop
    // the tail of the batch.
    await db.reset()
    for (const k of ['x/1', 'x/2', 'x/3']) await seed(k, { updatedAt: '2026-05-01T00:00:00Z' })

    const first = await repo.delta({ since: null, limit: 2 })
    expect(first.changed.map((e) => e.key)).toEqual(['x/1', 'x/2'])
    const second = await repo.delta({ since: first.cursor, limit: 2 })
    expect(second.changed.map((e) => e.key)).toEqual(['x/3'])
  })

  it('lists removals explicitly on the final page only', async () => {
    await db.raw.query(
      `update registry_servers set deleted_at = now(), updated_at = '2026-04-01T00:00:00Z' where key = 'a/one'`
    )
    const all = await repo.delta({ since: null, limit: 10 })
    expect(all.removed).toEqual(['a/one'])

    const partial = await repo.delta({ since: null, limit: 1 })
    // A client that stops paging must not record a cursor past a removal it
    // has not applied.
    expect(partial.hasMore).toBe(true)
    expect(partial.removed).toEqual([])
  })

  it('hands back a cursor that decodes to the last row served', async () => {
    const d = await repo.delta({ since: null, limit: 2 })
    expect(decodeCursor(d.cursor)).toEqual({ updatedAt: '2026-02-01T00:00:00.000Z', key: 'b/two' })
  })
})

describe('snapshot and release', () => {
  it('returns null before anything is published', async () => {
    expect(await repo.currentSnapshot()).toBeNull()
    expect(await repo.currentRelease()).toBeNull()
  })

  it('reads the current snapshot', async () => {
    await db.raw.query(
      `insert into snapshots (digest, url, bytes, entry_count, cursor, is_current)
       values ('sha256-x', 'https://cdn/x.json.gz', 1234, 55, 'cur', true)`
    )
    const snap = await repo.currentSnapshot()
    expect(snap).toMatchObject({ digest: 'sha256-x', bytes: 1234, entryCount: 55 })
  })

  it('cannot have two current snapshots', async () => {
    const ins = (d: string) =>
      db.raw.query(
        `insert into snapshots (digest, url, bytes, entry_count, cursor, is_current)
         values ($1, 'https://cdn/x', 1, 1, 'c', true)`, [d]
      )
    await ins('sha256-a')
    await expect(ins('sha256-b')).rejects.toThrow(/snapshots_one_current_idx/)
  })
})

describe('ping', () => {
  it('succeeds against a live database', async () => {
    await expect(repo.ping()).resolves.toBeUndefined()
  })
})
