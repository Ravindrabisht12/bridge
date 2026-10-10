/**
 * The API path that actually ships.
 *
 * `PostgresRepository` takes a `staging` flag that swaps which tables it reads:
 * `catalogue_entries` / `registry_servers` when set, `published_*` when not.
 * Production constructs it without the flag — and every other integration test
 * passes `staging: true`, so the shipping path had no coverage at all. The
 * published view is a *different view over different tables*; nothing verified
 * it had the same columns, that search worked against it, or that the
 * publication swap made data visible.
 *
 * Its own file because PGlite's socket bridge accepts one connection, and this
 * needs a repository configured differently from the staging suite's.
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startTestDatabase, type TestDatabase } from '@bridge/pgtest'
import { PostgresRepository } from '../src/postgres-repository'

const MIGRATIONS = join(import.meta.dirname, '..', '..', '..', 'infrastructure', 'supabase', 'migrations')

let db: TestDatabase
/** No `staging` flag — exactly how `server.ts` builds it. */
let repo: PostgresRepository

/** What `publishSnapshot`'s transaction does: staging becomes published. */
async function publish(): Promise<void> {
  await db.raw.exec(`
    begin;
    delete from published_registry_servers;
    insert into published_registry_servers select * from registry_servers;
    delete from published_curated;
    insert into published_curated select * from curated;
    commit;`)
}

async function stage(key: string, title: string, opts: { firstParty?: boolean; rank?: number } = {}): Promise<void> {
  await db.raw.query(
    `insert into registry_servers (key, namespace, title, description, status, remotes)
     values ($1, split_part($1,'/',1), $2, 'Pages and databases.', 'active', '[]'::jsonb)`,
    [key, title]
  )
  await db.raw.query(
    `insert into curated (key, is_first_party, vendor_domain, evidence, featured_rank, category)
     values ($1, $2, $3, $4, $5, 'productivity')`,
    [key, opts.firstParty ?? false, opts.firstParty ? 'notion.com' : null,
     opts.firstParty ? 'mcp-oauth' : 'unverified', opts.rank ?? null]
  )
}

beforeAll(async () => {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()
  db = await startTestDatabase(files.map((f) => join(MIGRATIONS, f)))
  repo = new PostgresRepository(db.url)
}, 60_000)

afterAll(async () => {
  await db?.close()
})

beforeEach(async () => {
  await db.reset()
  await db.raw.exec('truncate published_registry_servers, published_curated cascade;')
})

describe('the published path serves nothing until publication', () => {
  it('hides staging data entirely', async () => {
    // The whole point of the staging/published split: a half-finished sync is
    // never served to anybody.
    await stage('com.notion/mcp', 'Notion', { firstParty: true, rank: 1 })

    expect(await repo.featured(10)).toEqual([])
    expect(await repo.get('com.notion/mcp')).toBeNull()
    expect((await repo.search({ q: 'Notion', firstPartyOnly: false, category: null, limit: 10, cursor: null })).items)
      .toEqual([])
    expect((await repo.delta({ since: null, limit: 10 })).changed).toEqual([])
  })
})

describe('the published path after publication', () => {
  beforeEach(async () => {
    await stage('com.notion/mcp', 'Notion', { firstParty: true, rank: 1 })
    await stage('io.github.someone/clone', 'Notion Clone')
    await publish()
  })

  it('reads one entry, with curation folded in', async () => {
    const entry = await repo.get('com.notion/mcp')
    expect(entry).toMatchObject({
      key: 'com.notion/mcp',
      isFirstParty: true,
      vendorDomain: 'notion.com',
      evidence: 'mcp-oauth',
      category: 'productivity'
    })
  })

  it('searches — which needs published_registry_servers to carry search_tsv', async () => {
    // `create table (like ... including all)` copies columns and indexes but
    // not triggers, so the tsvector is only present because the publication
    // INSERT copies the already-computed column. If that ever stops being
    // true, search silently returns nothing and this test is the only warning.
    const page = await repo.search({ q: 'Notion', firstPartyOnly: false, category: null, limit: 10, cursor: null })
    expect(page.items.map((i) => i.title)).toContain('Notion')
    expect(page.items[0]!.title).toBe('Notion')
  })

  it('honours firstPartyOnly against the published curation', async () => {
    const page = await repo.search({ q: 'Notion', firstPartyOnly: true, category: null, limit: 10, cursor: null })
    expect(page.items.map((i) => i.key)).toEqual(['com.notion/mcp'])
  })

  it('serves featured by editorial rank', async () => {
    expect((await repo.featured(10)).map((i) => i.title)).toEqual(['Notion'])
  })

  it('serves a delta', async () => {
    const delta = await repo.delta({ since: null, limit: 10 })
    expect(delta.changed).toHaveLength(2)
    expect(delta.removed).toEqual([])
  })

  it('does not null the key when a published entry has no curation', async () => {
    await db.raw.query(`delete from published_curated where key = 'io.github.someone/clone'`)
    const entry = await repo.get('io.github.someone/clone')
    expect(entry?.key).toBe('io.github.someone/clone')
    expect(entry?.isFirstParty).toBe(false)
    expect(entry?.evidence).toBe('unverified')
  })

  it('keeps serving the previous publication when staging is emptied', async () => {
    // A worker mid-rebuild must not blank the API.
    await db.raw.exec('truncate registry_servers, curated cascade;')
    expect((await repo.featured(10))).toHaveLength(1)
    expect(await repo.get('com.notion/mcp')).not.toBeNull()
  })

  it('reflects a removal only once it is published', async () => {
    await db.raw.query(`update registry_servers set deleted_at = now() where key = 'com.notion/mcp'`)
    expect(await repo.get('com.notion/mcp')).not.toBeNull()

    await publish()
    expect(await repo.get('com.notion/mcp')).toBeNull()
  })
})
