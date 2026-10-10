/**
 * The icons stage.
 *
 * It was previously untestable: it took a raw connection string and ran its own
 * SQL instead of going through `CatalogueStore`, so there was no way to
 * exercise it without a database. It now takes a store like every other stage.
 */
import { describe, expect, it } from 'vitest'
import { MemoryStore } from '../src/memory-store'
import { iconsStage, resolveIcon } from '../src/stages/icons'
import type { AssetStorage } from '../src/storage'
import type { IconTarget } from '../src/store'

const ctx = { scheduled: true, now: () => new Date('2026-03-01T00:00:00.000Z'), log: () => {} }

/** A 1x1 PNG, with a real IHDR so pngWidth can read it. */
function png(width: number): Buffer {
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4)
  ihdr.writeUInt32BE(width, 8)
  ihdr.writeUInt32BE(width, 12)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr])
}

const imageResponse = (bytes: Buffer, mime = 'image/png') =>
  new Response(bytes, { status: 200, headers: { 'content-type': mime } })

function storage(): AssetStorage & { puts: string[] } {
  const puts: string[] = []
  return { puts, async put(key) { puts.push(key); return `https://cdn/${key}` } }
}

const target = (over: Partial<IconTarget> = {}): IconTarget => ({
  key: 'com.notion/mcp', iconDomain: 'notion.com', iconUrl: null, iconAsset: null, ...over
})

describe('resolveIcon', () => {
  it('prefers a pinned URL when one is set', async () => {
    // Slack's recognisable multi-colour mark is only in its .ico, so the
    // curated entry pins it.
    const asked: string[] = []
    const fetchImpl = (async (url: string) => {
      asked.push(String(url))
      return imageResponse(png(64), 'image/x-icon')
    }) as unknown as typeof fetch

    const icon = await resolveIcon(target({ iconUrl: 'https://slack.com/favicon.ico' }), fetchImpl)
    expect(icon?.url).toBe('https://slack.com/favicon.ico')
    expect(asked).toEqual(['https://slack.com/favicon.ico'])
  })

  it('does NOT settle for /favicon.ico when something larger exists', async () => {
    // The regression this stage was rewritten for. A plain GET /favicon.ico
    // gets a 16px icon, which is a blur in a 46px slot.
    const fetchImpl = (async (url: string) => {
      const u = String(url)
      if (u.endsWith('/favicon.ico')) return imageResponse(png(16), 'image/x-icon')
      if (u.includes('apple-touch-icon')) return imageResponse(png(180))
      if (u === 'https://notion.com/' || u === 'https://notion.com') return new Response('<html></html>', { headers: { 'content-type': 'text/html' } })
      return new Response('', { status: 404 })
    }) as unknown as typeof fetch

    const icon = await resolveIcon(target(), fetchImpl)
    expect(icon).not.toBeNull()
    expect(icon!.width).toBeGreaterThanOrEqual(128)
    expect(icon!.url).toContain('apple-touch-icon')
  })

  it('falls back to .ico when it is all the vendor publishes', async () => {
    // Canva, MongoDB and Asana were lost entirely by a version that ranked
    // .ico last and capped the attempt list.
    const fetchImpl = (async (url: string) => {
      const u = String(url)
      if (u.endsWith('/favicon.ico')) return imageResponse(png(32), 'image/x-icon')
      return new Response('', { status: 404 })
    }) as unknown as typeof fetch

    const icon = await resolveIcon(target({ iconDomain: 'canva.com' }), fetchImpl)
    expect(icon?.url).toContain('favicon.ico')
  })

  it('falls back to discovery when the pinned URL fails', async () => {
    const fetchImpl = (async (url: string) => {
      const u = String(url)
      if (u === 'https://pinned.example/gone.png') return new Response('', { status: 404 })
      if (u.endsWith('/favicon.ico')) return imageResponse(png(48), 'image/x-icon')
      return new Response('', { status: 404 })
    }) as unknown as typeof fetch

    const icon = await resolveIcon(target({ iconUrl: 'https://pinned.example/gone.png' }), fetchImpl)
    expect(icon?.url).toContain('favicon.ico')
  })

  it('refuses a non-image, however it is served', async () => {
    // Windsurf's apple-touch-icon path answers with HTML.
    const fetchImpl = (async () =>
      new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch
    expect(await resolveIcon(target(), fetchImpl)).toBeNull()
  })

  it('refuses an oversized image', async () => {
    const fetchImpl = (async () => imageResponse(Buffer.alloc(300 * 1024))) as unknown as typeof fetch
    expect(await resolveIcon(target(), fetchImpl)).toBeNull()
  })

  it('returns null when the vendor publishes nothing', async () => {
    // Replicate answers 404 at /favicon.ico.
    const fetchImpl = (async () => new Response('', { status: 404 })) as unknown as typeof fetch
    expect(await resolveIcon(target({ iconDomain: 'replicate.com' }), fetchImpl)).toBeNull()
  })

  it('survives a homepage that will not load', async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).endsWith('/favicon.ico')) return imageResponse(png(32), 'image/x-icon')
      throw new Error('connection reset')
    }) as unknown as typeof fetch
    expect((await resolveIcon(target(), fetchImpl))?.url).toContain('favicon.ico')
  })
})

describe('icons stage', () => {
  async function seeded(): Promise<MemoryStore> {
    const store = new MemoryStore(() => '2026-03-01T00:00:00.000Z')
    await store.upsertServers([{
      key: 'com.notion/mcp', namespace: 'com.notion', title: 'Notion', description: '',
      version: null, repositoryUrl: null, websiteUrl: null, status: 'active',
      packages: [], remotes: [], publishedAt: null, sourceUpdatedAt: null
    }])
    store.setCurated('com.notion/mcp', 'notion.com')
    return store
  }

  it('stores the bytes content-addressed and records the asset', async () => {
    const store = await seeded()
    const assets = storage()
    const fetchImpl = (async (url: string) =>
      String(url).endsWith('/favicon.ico') ? imageResponse(png(64), 'image/x-icon') : new Response('', { status: 404 })
    ) as unknown as typeof fetch

    const out = await iconsStage({ store, storage: assets, fetchImpl }).run(ctx)
    expect(out.changed).toBe(1)
    expect(assets.puts[0]).toMatch(/^icons\/[0-9a-f]{64}\.ico$/)
    expect((await store.iconTargets())[0]!.iconAsset).toBe(assets.puts[0])
  })

  it('does not re-upload an unchanged icon', async () => {
    const store = await seeded()
    const assets = storage()
    const fetchImpl = (async (url: string) =>
      String(url).endsWith('/favicon.ico') ? imageResponse(png(64), 'image/x-icon') : new Response('', { status: 404 })
    ) as unknown as typeof fetch

    await iconsStage({ store, storage: assets, fetchImpl }).run(ctx)
    const second = await iconsStage({ store, storage: assets, fetchImpl }).run(ctx)
    expect(second.changed).toBe(0)
    expect(assets.puts).toHaveLength(1)
  })

  it('skips a soft-deleted entry', async () => {
    const store = await seeded()
    await store.markMissingDeleted(new Set(['other/thing']))
    expect(await store.iconTargets()).toEqual([])
  })

  it('never asks about an uncurated entry', async () => {
    // Resolving icons for all 28,000 registry entries would mean crawling
    // 28,000 third-party homepages.
    const store = await seeded()
    await store.upsertServers([{
      key: 'io.github.someone/rebuild', namespace: 'io.github.someone', title: 'Rebuild',
      description: '', version: null, repositoryUrl: null, websiteUrl: null, status: 'active',
      packages: [], remotes: [], publishedAt: null, sourceUpdatedAt: null
    }])
    expect((await store.iconTargets()).map((t) => t.key)).toEqual(['com.notion/mcp'])
  })

  it('degrades: one vendor failing does not fail the stage', async () => {
    const store = await seeded()
    store.setCurated('io.github.x/other', 'broken.example')
    await store.upsertServers([{
      key: 'io.github.x/other', namespace: 'io.github.x', title: 'Other', description: '',
      version: null, repositoryUrl: null, websiteUrl: null, status: 'active',
      packages: [], remotes: [], publishedAt: null, sourceUpdatedAt: null
    }])
    const fetchImpl = (async (url: string) => {
      if (String(url).includes('broken.example')) throw new Error('refused')
      return String(url).endsWith('/favicon.ico') ? imageResponse(png(64), 'image/x-icon') : new Response('', { status: 404 })
    }) as unknown as typeof fetch

    const out = await iconsStage({ store, storage: storage(), fetchImpl }).run(ctx)
    expect(out.error).toBeNull()
    expect(out.changed).toBe(1)
  })

  it('a resolved icon is a curation edit, so it reaches clients', async () => {
    // An advancing clock, or this asserts nothing. A newly resolved icon must
    // move the served updated_at — otherwise it never appears in a delta and
    // no client ever sees it.
    let tick = 0
    const clock = () => new Date(Date.UTC(2026, 2, 1, 0, 0, tick++)).toISOString()
    const store = new MemoryStore(clock)
    await store.upsertServers([{
      key: 'com.notion/mcp', namespace: 'com.notion', title: 'Notion', description: '',
      version: null, repositoryUrl: null, websiteUrl: null, status: 'active',
      packages: [], remotes: [], publishedAt: null, sourceUpdatedAt: null
    }])
    store.setCurated('com.notion/mcp', 'notion.com')

    const before = (await store.allEntries())[0]!.updatedAt
    await store.setIconAsset('com.notion/mcp', 'icons/abc.png')
    const after = (await store.allEntries())[0]!.updatedAt

    expect(after > before).toBe(true)
    expect((await store.iconTargets())[0]!.iconAsset).toBe('icons/abc.png')
  })
})
