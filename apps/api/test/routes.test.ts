/**
 * Route behaviour, against the in-memory repository. No database, no network.
 * What is being pinned here is the contract: status codes, error shapes,
 * clamping, cursor handling, and the delta rules that can destroy a user's
 * catalogue if they are wrong.
 */
import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app'
import { MemoryRepository } from '../src/memory-repository'
import { encodeCursor } from '../src/cursor'
import { entry, release, snapshot } from './fixtures'

const app = (repo = new MemoryRepository()) => buildApp(repo)

describe('GET /health', () => {
  it('is 200 when the store answers', async () => {
    const res = await app().inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('is 503 — not 500 — when the store is unreachable', async () => {
    const broken = new MemoryRepository()
    broken.ping = async () => {
      throw new Error('connection refused')
    }
    const res = await app(broken).inject({ method: 'GET', url: '/health' })
    // A load balancer must be able to tell "my dependency is down" from
    // "this process is broken".
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ ok: false })
  })
})

describe('GET /v1/search', () => {
  const repo = new MemoryRepository([
    entry({ key: 'a/notion', title: 'Notion', isFirstParty: true, vendorDomain: 'notion.com', evidence: 'mcp-oauth' }),
    entry({ key: 'b/notion-clone', title: 'Notion Clone' }),
    entry({ key: 'c/other', title: 'Other', description: 'integrates with Notion somehow' })
  ])

  it('ranks an exact name match first, then prefix, then description', async () => {
    const res = await app(repo).inject({ method: 'GET', url: '/v1/search?q=Notion' })
    expect(res.statusCode).toBe(200)
    expect(res.json().items.map((e: { title: string }) => e.title)).toEqual([
      'Notion',
      'Notion Clone',
      'Other'
    ])
  })

  it('rejects a one-character query rather than scanning the table', async () => {
    const res = await app(repo).inject({ method: 'GET', url: '/v1/search?q=n' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('bad_request')
  })

  it('rejects a malformed cursor', async () => {
    const res = await app(repo).inject({ method: 'GET', url: '/v1/search?q=notion&cursor=garbage' })
    expect(res.statusCode).toBe(400)
  })

  it('filters to the verified set on request', async () => {
    const res = await app(repo).inject({ method: 'GET', url: '/v1/search?q=notion&firstParty=true' })
    expect(res.json().items).toHaveLength(1)
    expect(res.json().items[0].title).toBe('Notion')
  })

  it('caps the page size instead of honouring an absurd limit', async () => {
    const many = new MemoryRepository(
      Array.from({ length: 300 }, (_, i) => entry({ key: `k/${i}`, title: `Thing ${i}` }))
    )
    const res = await app(many).inject({ method: 'GET', url: '/v1/search?q=Thing&limit=99999' })
    expect(res.json().items).toHaveLength(100)
  })

  it('pages search, and page two differs from page one', async () => {
    // Mirrors the Postgres integration test. The two implementations must page
    // the same way or the route tests are proving nothing about production.
    const many = new MemoryRepository(
      Array.from({ length: 7 }, (_, i) => entry({ key: `p/${i}`, title: `Paging ${i}` }))
    )
    const app0 = app(many)
    const first = await app0.inject({ method: 'GET', url: '/v1/search?q=Paging&limit=3' })
    expect(first.json().items).toHaveLength(3)
    expect(first.json().nextCursor).not.toBeNull()

    const second = await app0.inject({
      method: 'GET',
      url: `/v1/search?q=Paging&limit=3&cursor=${encodeURIComponent(first.json().nextCursor)}`
    })
    expect(second.statusCode).toBe(200)
    expect(second.json().items.map((e: { key: string }) => e.key)).not.toEqual(
      first.json().items.map((e: { key: string }) => e.key)
    )
  })

  it('accepts its own search cursor', async () => {
    // Search cursors are offsets; validating them with the keyset decoder
    // would 400 every legitimate page-two request.
    const many = new MemoryRepository(
      Array.from({ length: 5 }, (_, i) => entry({ key: `p/${i}`, title: `Paging ${i}` }))
    )
    const app0 = app(many)
    const first = await app0.inject({ method: 'GET', url: '/v1/search?q=Paging&limit=2' })
    const next = first.json().nextCursor as string
    const res = await app0.inject({ method: 'GET', url: `/v1/search?q=Paging&limit=2&cursor=${encodeURIComponent(next)}` })
    expect(res.statusCode).toBe(200)
  })

  it('is cacheable by a shared cache', async () => {
    const res = await app(repo).inject({ method: 'GET', url: '/v1/search?q=notion' })
    expect(res.headers['cache-control']).toContain('s-maxage')
  })
})

describe('GET /v1/catalogue/:key', () => {
  const repo = new MemoryRepository([entry({ key: 'io.github.a/b' })])

  it('returns the entry', async () => {
    const res = await app(repo).inject({ method: 'GET', url: '/v1/catalogue/io.github.a%2Fb' })
    expect(res.statusCode).toBe(200)
    expect(res.json().key).toBe('io.github.a/b')
  })

  it('404s with a typed error, not a bare string', async () => {
    const res = await app(repo).inject({ method: 'GET', url: '/v1/catalogue/nope' })
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('not_found')
  })
})

describe('GET /v1/catalogue (delta)', () => {
  const older = entry({ key: 'a/one', updatedAt: '2026-01-01T00:00:00.000Z' })
  const newer = entry({ key: 'b/two', updatedAt: '2026-02-01T00:00:00.000Z' })
  const repo = new MemoryRepository([older, newer], [{ key: 'c/gone', updatedAt: '2026-02-02T00:00:00.000Z' }])

  it('sends everything when there is no cursor', async () => {
    const res = await app(repo).inject({ method: 'GET', url: '/v1/catalogue' })
    expect(res.statusCode).toBe(200)
    expect(res.json().changed.map((e: { key: string }) => e.key)).toEqual(['a/one', 'b/two'])
  })

  it('sends only what changed after the cursor', async () => {
    const cursor = encodeCursor({ updatedAt: older.updatedAt, key: older.key })
    const res = await app(repo).inject({ method: 'GET', url: `/v1/catalogue?since=${cursor}` })
    expect(res.json().changed.map((e: { key: string }) => e.key)).toEqual(['b/two'])
  })

  it('lists removals explicitly — absence never means deleted', async () => {
    const res = await app(repo).inject({ method: 'GET', url: '/v1/catalogue' })
    expect(res.json().removed).toEqual(['c/gone'])
  })

  it('withholds removals while more pages remain', async () => {
    // A client that stops paging early must not record a cursor past a removal
    // it never saw. This is the rule that stops a truncated response from
    // silently emptying a catalogue.
    const res = await app(repo).inject({ method: 'GET', url: '/v1/catalogue?limit=1' })
    expect(res.json().hasMore).toBe(true)
    expect(res.json().removed).toEqual([])
  })

  it('400s on a malformed cursor rather than resending the world', async () => {
    const res = await app(repo).inject({ method: 'GET', url: '/v1/catalogue?since=not-a-cursor' })
    expect(res.statusCode).toBe(400)
  })

  it('is idempotent — replaying a delta changes nothing', async () => {
    const first = await app(repo).inject({ method: 'GET', url: '/v1/catalogue' })
    const again = await app(repo).inject({ method: 'GET', url: '/v1/catalogue' })
    expect(again.json()).toEqual(first.json())
  })
})

describe('GET /v1/featured', () => {
  it('orders by editorial rank', async () => {
    const repo = new MemoryRepository([
      entry({ key: 'a', title: 'Third', featuredRank: 3 }),
      entry({ key: 'b', title: 'First', featuredRank: 1 }),
      entry({ key: 'c', title: 'Unranked' })
    ])
    const res = await app(repo).inject({ method: 'GET', url: '/v1/featured' })
    expect(res.json().items.map((e: { title: string }) => e.title)).toEqual(['First', 'Third'])
  })
})

describe('snapshot and release', () => {
  it('404s before the first publish rather than returning an empty object', async () => {
    const bare = app()
    expect((await bare.inject({ method: 'GET', url: '/v1/snapshot/latest' })).statusCode).toBe(404)
    expect((await bare.inject({ method: 'GET', url: '/v1/app/latest' })).statusCode).toBe(404)
  })

  it('serves snapshot metadata, not the bytes', async () => {
    const repo = new MemoryRepository([], [], snapshot, release)
    const res = await app(repo).inject({ method: 'GET', url: '/v1/snapshot/latest' })
    expect(res.json().url).toContain('cdn.')
    expect(res.json().digest).toBe('sha256-abc')
  })

  it('serves the current release', async () => {
    const repo = new MemoryRepository([], [], snapshot, release)
    const res = await app(repo).inject({ method: 'GET', url: '/v1/app/latest' })
    expect(res.json().version).toBe('0.1.0')
    expect(res.json().minimumSupported).toBe('0.1.0')
  })
})

describe('errors', () => {
  it('never leaks an internal message', async () => {
    const broken = new MemoryRepository()
    broken.featured = async () => {
      throw new Error('relation "catalogue_entries" does not exist')
    }
    const res = await app(broken).inject({ method: 'GET', url: '/v1/featured' })
    expect(res.statusCode).toBe(500)
    // A schema name in a public JSON body is how databases get mapped.
    expect(JSON.stringify(res.json())).not.toContain('catalogue_entries')
    expect(res.json().error.code).toBe('internal')
  })

  it('404s an unknown route with the same error shape', async () => {
    const res = await app().inject({ method: 'GET', url: '/v1/nope' })
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('not_found')
  })
})
