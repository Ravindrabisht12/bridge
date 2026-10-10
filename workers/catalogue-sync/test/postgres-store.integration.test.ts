/**
 * `PostgresStore` against real Postgres.
 *
 * Everything here is SQL that had never executed before these tests existed:
 * the upsert that decides for itself whether a row changed, the soft-delete
 * sweep, the lateral join over `packages`, the two-statement snapshot swap.
 * A memory store cannot verify any of it — it can only agree with itself.
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startTestDatabase, type TestDatabase } from '@bridge/pgtest'
import { PostgresStore } from '../src/postgres-store'
import type { ServerRow } from '../src/store'

const MIGRATIONS = join(import.meta.dirname, '..', '..', '..', 'infrastructure', 'supabase', 'migrations')

let db: TestDatabase
let store: PostgresStore

const row = (key: string, over: Partial<ServerRow> = {}): ServerRow => ({
  key,
  namespace: key.includes('/') ? key.slice(0, key.indexOf('/')) : null,
  title: 'Thing',
  description: 'Does a thing.',
  version: '1.0.0',
  repositoryUrl: null,
  websiteUrl: null,
  status: 'active',
  packages: [],
  remotes: [],
  publishedAt: null,
  sourceUpdatedAt: null,
  ...over
})

beforeAll(async () => {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()
  db = await startTestDatabase(files.map((f) => join(MIGRATIONS, f)))
  store = new PostgresStore(db.url)
}, 60_000)

afterAll(async () => {
  await db?.close()
})

beforeEach(async () => {
  await db.reset()
})

describe('upsertServers', () => {
  it('inserts and reports what it inserted', async () => {
    const out = await store.upsertServers([row('a/one'), row('b/two')])
    expect(out).toEqual({ added: 2, changed: 0, unchanged: 0 })
    expect(await store.countLive()).toBe(2)
  })

  it('reports an unchanged row as unchanged, not changed', async () => {
    // The one that matters most. If this were wrong, every weekly sync would
    // mark all 28,000 entries changed and push the whole catalogue into every
    // client's next delta.
    await store.upsertServers([row('a/one')])
    const second = await store.upsertServers([row('a/one')])
    expect(second).toEqual({ added: 0, changed: 0, unchanged: 1 })
  })

  it('leaves updated_at alone when nothing a client sees moved', async () => {
    await store.upsertServers([row('a/one')])
    const before = await db.raw.query<{ updated_at: Date }>(
      'select updated_at from registry_servers where key = $1', ['a/one']
    )
    await store.upsertServers([row('a/one', { sourceUpdatedAt: '2030-01-01T00:00:00Z' })])
    const after = await db.raw.query<{ updated_at: Date }>(
      'select updated_at from registry_servers where key = $1', ['a/one']
    )
    // The registry's own clock moving is not something a client notices.
    expect(after.rows[0]!.updated_at).toEqual(before.rows[0]!.updated_at)
  })

  it('moves updated_at when a served field changes', async () => {
    await store.upsertServers([row('a/one')])
    const before = await db.raw.query<{ updated_at: Date }>(
      'select updated_at from registry_servers where key = $1', ['a/one']
    )
    const out = await store.upsertServers([row('a/one', { description: 'Different now.' })])
    const after = await db.raw.query<{ updated_at: Date }>(
      'select updated_at from registry_servers where key = $1', ['a/one']
    )
    expect(out.changed).toBe(1)
    expect(after.rows[0]!.updated_at.getTime()).toBeGreaterThan(before.rows[0]!.updated_at.getTime())
  })

  it('notices a change inside packages, not just scalars', async () => {
    await store.upsertServers([row('a/one', { packages: [{ registryType: 'npm', identifier: 'x' }] })])
    const out = await store.upsertServers([
      row('a/one', { packages: [{ registryType: 'npm', identifier: 'x', version: '2' }] })
    ])
    expect(out.changed).toBe(1)
  })

  it('handles a batch with a duplicate key without deadlocking', async () => {
    // The registry has returned the same name twice on a page boundary before.
    // `ON CONFLICT` cannot see a second row in the same statement, so this
    // would error with "cannot affect row a second time" if unguarded.
    const out = await store.upsertServers([row('a/one'), row('a/one', { title: 'Second' })])
    expect(out.added + out.changed).toBeGreaterThan(0)
    expect(await store.countLive()).toBe(1)
  })

  it('stores an empty batch without a round trip', async () => {
    expect(await store.upsertServers([])).toEqual({ added: 0, changed: 0, unchanged: 0 })
  })
})

describe('markMissingDeleted', () => {
  it('soft-deletes what a full pass did not see', async () => {
    await store.upsertServers([row('a/one'), row('b/two')])
    const removed = await store.markMissingDeleted(new Set(['a/one']))
    expect(removed).toBe(1)
    expect(await store.countLive()).toBe(1)
  })

  it('refuses to delete everything when handed an empty set', async () => {
    // The only way to reach this with an empty set is a bug upstream, and the
    // consequence would be an empty catalogue for every user.
    await store.upsertServers([row('a/one'), row('b/two')])
    expect(await store.markMissingDeleted(new Set())).toBe(0)
    expect(await store.countLive()).toBe(2)
  })

  it('does not re-delete something already deleted', async () => {
    await store.upsertServers([row('a/one'), row('b/two')])
    await store.markMissingDeleted(new Set(['a/one']))
    expect(await store.markMissingDeleted(new Set(['a/one']))).toBe(0)
  })

  it('resurrects a row the registry publishes again', async () => {
    await store.upsertServers([row('a/one')])
    await store.markMissingDeleted(new Set(['other/thing']))
    expect(await store.countLive()).toBe(0)

    const out = await store.upsertServers([row('a/one')])
    expect(out.changed).toBe(1)
    expect(await store.countLive()).toBe(1)
  })
})

describe('downloadTargets', () => {
  it('finds every npm and PyPI package via the lateral join', async () => {
    await store.upsertServers([
      row('a/npm', { packages: [{ registryType: 'npm', identifier: 'pkg-a' }] }),
      row('b/two', {
        packages: [
          { registryType: 'oci', identifier: 'ignored' },
          { registryType: 'pypi', identifier: 'pkg-b' }
        ]
      }),
      row('c/none', { packages: [{ registryType: 'mcpb', identifier: 'nope' }] })
    ])
    const targets = await store.downloadTargets(10)
    expect(targets.map((t) => t.identifier).sort()).toEqual(['pkg-a', 'pkg-b'])
  })

  it('skips soft-deleted rows', async () => {
    await store.upsertServers([row('a/npm', { packages: [{ registryType: 'npm', identifier: 'x' }] })])
    await store.markMissingDeleted(new Set(['other/thing']))
    expect(await store.downloadTargets(10)).toEqual([])
  })

  it('honours the limit', async () => {
    await store.upsertServers(
      Array.from({ length: 5 }, (_, i) =>
        row(`a/${i}`, { packages: [{ registryType: 'npm', identifier: `p${i}` }] })
      )
    )
    expect(await store.downloadTargets(2)).toHaveLength(2)
  })
})

describe('setDownloads', () => {
  it('records a count without disturbing updated_at', async () => {
    await store.upsertServers([row('a/one')])
    const before = await db.raw.query<{ updated_at: Date }>(
      'select updated_at from registry_servers where key = $1', ['a/one']
    )
    await store.setDownloads('a/one', 4321, 'npm')
    const after = await db.raw.query<{ downloads: number; updated_at: Date }>(
      'select downloads, updated_at from registry_servers where key = $1', ['a/one']
    )
    expect(after.rows[0]!.downloads).toBe(4321)
    // A popularity number moving is not a reason to re-send the entry to
    // every client.
    expect(after.rows[0]!.updated_at).toEqual(before.rows[0]!.updated_at)
  })
})

describe('sync state and run records', () => {
  it('round-trips state and overwrites on conflict', async () => {
    expect(await store.readSyncState('k')).toBeNull()
    await store.writeSyncState('k', 'one')
    await store.writeSyncState('k', 'two')
    expect(await store.readSyncState('k')).toBe('two')
  })

  it('records a stage run, including a failure', async () => {
    await store.recordRun({
      stage: 'registry',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:01:00.000Z',
      fetched: 10, added: 1, changed: 2, removed: 0,
      error: 'HTTP 503'
    })
    const rows = await db.raw.query<{ stage: string; error: string }>('select stage, error from sync_runs')
    expect(rows.rows[0]).toMatchObject({ stage: 'registry', error: 'HTTP 503' })
  })
})

describe('publishSnapshot', () => {
  it('leaves exactly one current snapshot', async () => {
    const meta = (digest: string) => ({
      digest, url: `https://cdn/${digest}`, bytes: 1, entryCount: 1, cursor: 'c'
    })
    await store.publishSnapshot(meta('sha256-one'))
    await store.publishSnapshot(meta('sha256-two'))

    const rows = await db.raw.query<{ digest: string }>('select digest from snapshots where is_current')
    // A moment with two current snapshots, or none, would be served to
    // somebody — hence the transaction and the unique partial index.
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]!.digest).toBe('sha256-two')
  })

  it('republishing the same digest is idempotent', async () => {
    const meta = { digest: 'sha256-same', url: 'https://cdn/x', bytes: 1, entryCount: 1, cursor: 'c' }
    await store.publishSnapshot(meta)
    await store.publishSnapshot(meta)
    const all = await db.raw.query('select digest from snapshots')
    expect(all.rows).toHaveLength(1)
  })
})
