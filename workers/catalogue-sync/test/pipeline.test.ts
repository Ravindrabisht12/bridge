/**
 * The pipeline end to end, against the memory store and a fake registry.
 * No database, no network.
 */
import { describe, expect, it, vi } from 'vitest'
import { MemoryStore } from '../src/memory-store'
import { runSync } from '../src/run'
import { registryStage, toRow, LAST_SYNC_KEY } from '../src/stages/registry'
import { downloadsStage } from '../src/stages/downloads'
import { probeStage } from '../src/stages/probe'
import { publishStage, buildSnapshot, PublishRefused, PREVIOUS_COUNT_KEY } from '../src/stages/publish'
import type { RegistryEntry } from '@bridge/registry'

const ctx = { scheduled: true, now: () => new Date('2026-03-01T00:00:00.000Z'), log: () => {} }

const srv = (name: string, over: Partial<RegistryEntry['server']> = {}): RegistryEntry => ({
  server: { name, description: 'A server.', ...over }
})

function fakeRegistry(entries: RegistryEntry[]) {
  return {
    fetchImpl: (async () =>
      new Response(JSON.stringify({ servers: entries, metadata: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })) as unknown as typeof fetch
  }
}

describe('registry stage', () => {
  it('stores what the registry returned', async () => {
    const store = new MemoryStore(() => '2026-03-01T00:00:00.000Z')
    const { fetchImpl } = fakeRegistry([srv('io.github.a/one'), srv('com.notion/mcp')])
    const out = await registryStage({ store, full: true, fetchImpl }).run(ctx)

    expect(out.fetched).toBe(2)
    expect(out.added).toBe(2)
    expect(await store.countLive()).toBe(2)
    // displayTitle applied on the way in, so the front page never says "mcp".
    expect(store.rows.get('com.notion/mcp')?.title).toBe('Notion')
  })

  it('does not count an unchanged row as changed', async () => {
    // If this were wrong, every weekly sync would mark all 27,000 entries
    // changed and push the whole catalogue into every client's next delta.
    const store = new MemoryStore()
    const { fetchImpl } = fakeRegistry([srv('io.github.a/one')])
    await registryStage({ store, full: true, fetchImpl }).run(ctx)
    const second = await registryStage({ store, full: true, fetchImpl }).run(ctx)

    expect(second.added).toBe(0)
    expect(second.changed).toBe(0)
  })

  it('counts a real edit as changed', async () => {
    const store = new MemoryStore()
    await registryStage({ store, full: true, ...fakeRegistry([srv('io.github.a/one')]) }).run(ctx)
    const out = await registryStage({
      store,
      full: true,
      ...fakeRegistry([srv('io.github.a/one', { description: 'Now different.' })])
    }).run(ctx)
    expect(out.changed).toBe(1)
  })

  it('soft-deletes what a FULL pass no longer sees', async () => {
    const store = new MemoryStore()
    await registryStage({ store, full: true, ...fakeRegistry([srv('a/one'), srv('b/two')]) }).run(ctx)
    const out = await registryStage({ store, full: true, ...fakeRegistry([srv('a/one')]) }).run(ctx)

    expect(out.removed).toBe(1)
    expect(await store.countLive()).toBe(1)
  })

  it('never deletes on an INCREMENTAL pass', async () => {
    // An incremental pass only asks for what changed, so "not seen" means
    // "not changed". Deleting on that basis would empty the catalogue on the
    // first incremental run — the single most destructive available bug.
    const store = new MemoryStore()
    await registryStage({ store, full: true, ...fakeRegistry([srv('a/one'), srv('b/two')]) }).run(ctx)
    const out = await registryStage({ store, full: false, ...fakeRegistry([]) }).run(ctx)

    expect(out.removed).toBe(0)
    expect(await store.countLive()).toBe(2)
  })

  it('resurrects a row the registry publishes again', async () => {
    const store = new MemoryStore()
    await registryStage({ store, full: true, ...fakeRegistry([srv('a/one')]) }).run(ctx)
    await registryStage({ store, full: true, ...fakeRegistry([]) }).run(ctx)
    expect(await store.countLive()).toBe(0)

    await registryStage({ store, full: true, ...fakeRegistry([srv('a/one')]) }).run(ctx)
    expect(await store.countLive()).toBe(1)
  })

  it('records the sync marker only after a successful pass', async () => {
    const store = new MemoryStore()
    expect(await store.readSyncState(LAST_SYNC_KEY)).toBeNull()
    await registryStage({ store, full: true, ...fakeRegistry([srv('a/one')]) }).run(ctx)
    expect(await store.readSyncState(LAST_SYNC_KEY)).toBe('2026-03-01T00:00:00.000Z')
  })

  it('skips a nameless entry rather than storing an unaddressable row', async () => {
    const store = new MemoryStore()
    const bad = { server: { description: 'no name' } } as unknown as RegistryEntry
    const out = await registryStage({ store, full: true, ...fakeRegistry([bad, srv('a/one')]) }).run(ctx)
    expect(out.fetched).toBe(1)
  })
})

describe('toRow', () => {
  it('splits the namespace off the key', () => {
    const row = toRow(srv('io.github.owner/thing'))
    expect(row.key).toBe('io.github.owner/thing')
    expect(row.namespace).toBe('io.github.owner')
  })

  it('leaves the namespace null for an unnamespaced key', () => {
    expect(toRow(srv('thing')).namespace).toBeNull()
  })
})

describe('downloads stage', () => {
  it('records a count and leaves unknowns null', async () => {
    const store = new MemoryStore()
    await registryStage({
      store,
      full: true,
      ...fakeRegistry([
        srv('a/npm-one', { packages: [{ registryType: 'npm', identifier: 'pkg-a' }] }),
        srv('b/unknown', { packages: [{ registryType: 'oci', identifier: 'pkg-b' }] })
      ])
    }).run(ctx)

    const fetchImpl = (async () =>
      new Response(JSON.stringify({ downloads: 4321 }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })) as unknown as typeof fetch

    const out = await downloadsStage({ store, fetchImpl }).run(ctx)
    expect(out.changed).toBe(1)
    expect(store.rows.get('a/npm-one')?.downloads).toBe(4321)
    // Null, not 0: "no data" and "nobody uses it" must stay distinguishable.
    expect(store.rows.get('b/unknown')?.downloads).toBeNull()
  })

  it('survives a rate limit without failing the stage', async () => {
    const store = new MemoryStore()
    await registryStage({
      store, full: true,
      ...fakeRegistry([srv('a/one', { packages: [{ registryType: 'npm', identifier: 'p' }] })])
    }).run(ctx)
    const fetchImpl = (async () => new Response('slow down', { status: 429 })) as unknown as typeof fetch
    const out = await downloadsStage({ store, fetchImpl }).run(ctx)
    expect(out.error).toBeNull()
    expect(out.changed).toBe(0)
  })
})

describe('probe stage', () => {
  const withRemote = () =>
    fakeRegistry([srv('com.notion/mcp', { remotes: [{ type: 'streamable-http', url: 'https://mcp.notion.com/mcp' }] })])

  it('treats an OAuth wall as proof the endpoint is real', async () => {
    // The judgement the whole first-party claim rests on. A 401 from
    // mcp.notion.com proves Notion runs an MCP server there.
    const store = new MemoryStore()
    await registryStage({ store, full: true, ...withRemote() }).run(ctx)
    store.setCurated('com.notion/mcp', 'notion.com')
    const fetchImpl = (async () => new Response('', { status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="https://mcp.notion.com/.well-known/oauth-protected-resource"' } })) as unknown as typeof fetch

    const out = await probeStage({ store, fetchImpl }).run(ctx)
    expect(out.changed).toBe(1)
    expect(store.probes[0]?.outcome).toBe('auth-required')
    expect(store.rows.get('com.notion/mcp')?.verifiedAt).toBe('2026-03-01T00:00:00.000Z')
  })

  it('does not verify on a refusal, and does not un-verify either', async () => {
    const store = new MemoryStore()
    await registryStage({ store, full: true, ...withRemote() }).run(ctx)
    store.setCurated('com.notion/mcp', 'notion.com')
    await probeStage({
      store,
      fetchImpl: (async () => new Response('', { status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="https://mcp.notion.com/.well-known/oauth-protected-resource"' } })) as unknown as typeof fetch
    }).run(ctx)

    const out = await probeStage({
      store,
      staleAfterDays: 0,
      fetchImpl: (async () => new Response('', { status: 500 })) as unknown as typeof fetch
    }).run(ctx)

    expect(out.changed).toBe(0)
    // A vendor having a bad afternoon is not evidence they never published it.
    expect(store.rows.get('com.notion/mcp')?.verifiedAt).toBe('2026-03-01T00:00:00.000Z')
  })

  it('skips anything verified recently', async () => {
    const store = new MemoryStore()
    await registryStage({ store, full: true, ...withRemote() }).run(ctx)
    store.setCurated('com.notion/mcp', 'notion.com')
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'test' }, capabilities: {} } }), { status: 200 })) as unknown as typeof fetch
    await probeStage({ store, fetchImpl }).run(ctx)
    const second = await probeStage({ store, fetchImpl }).run(ctx)
    expect(second.fetched).toBe(0)
  })
})

describe('probe stage — what the real run exposed', () => {
  it('probes curated entries only, not all 28,000 registry rows', async () => {
    const store = new MemoryStore()
    await registryStage({
      store, full: true,
      ...fakeRegistry([
        srv('com.notion/mcp', { remotes: [{ type: 'streamable-http', url: 'https://mcp.notion.com/mcp' }] }),
        srv('io.github.someone/rebuild', { remotes: [{ type: 'sse', url: 'https://example.invalid/mcp' }] })
      ])
    }).run(ctx)
    store.setCurated('com.notion/mcp', 'notion.com')

    const seen: string[] = []
    const fetchImpl = (async (url: string) => {
      seen.push(String(url))
      return new Response('', { status: 200 })
    }) as unknown as typeof fetch

    await probeStage({ store, fetchImpl }).run(ctx)
    // Probing every registry entry would be both wrong and rude.
    expect(seen).toEqual(['https://mcp.notion.com/mcp'])
  })

  it('skips a remote whose URL will not parse instead of failing the stage', async () => {
    // One malformed `url` in 28,000 registry rows failed the entire probe
    // stage on the first real run.
    const store = new MemoryStore()
    await registryStage({
      store, full: true,
      ...fakeRegistry([srv('a/bad', { remotes: [{ type: 'sse', url: 'not a url' }] })])
    }).run(ctx)
    store.setCurated('a/bad', 'example.com')

    const out = await probeStage({ store }).run(ctx)
    expect(out.error).toBeNull()
    expect(out.fetched).toBe(0)
  })
})

describe('downloads stage — what the real run exposed', () => {
  it('asks only about npm and PyPI packages', async () => {
    // The SQL filters on registryType; the memory store did not, so a dry run
    // spent 2,000 requests on oci and mcpb identifiers that publish no counts.
    const store = new MemoryStore()
    await registryStage({
      store, full: true,
      ...fakeRegistry([
        srv('a/npm', { packages: [{ registryType: 'npm', identifier: 'x' }] }),
        srv('b/oci', { packages: [{ registryType: 'oci', identifier: 'y' }] }),
        srv('c/mcpb', { packages: [{ registryType: 'mcpb', identifier: 'z' }] })
      ])
    }).run(ctx)

    const asked: string[] = []
    const fetchImpl = (async (url: string) => {
      asked.push(String(url))
      return new Response(JSON.stringify({ downloads: 1 }), {
        status: 200, headers: { 'content-type': 'application/json' }
      })
    }) as unknown as typeof fetch

    const out = await downloadsStage({ store, fetchImpl }).run(ctx)
    expect(out.fetched).toBe(1)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('api.npmjs.org')
  })

  it('considers every package on an entry, not just the first', async () => {
    const store = new MemoryStore()
    await registryStage({
      store, full: true,
      ...fakeRegistry([
        srv('a/both', {
          packages: [
            { registryType: 'oci', identifier: 'ignored' },
            { registryType: 'npm', identifier: 'wanted' }
          ]
        })
      ])
    }).run(ctx)
    const targets = await store.downloadTargets(10)
    expect(targets.map((t) => t.identifier)).toEqual(['wanted'])
  })
})

describe('publish stage', () => {
  it('refuses when the catalogue collapsed, and does not upload', async () => {
    const store = new MemoryStore()
    await store.writeSyncState(PREVIOUS_COUNT_KEY, '1000')
    await registryStage({ store, full: true, ...fakeRegistry([srv('a/one')]) }).run(ctx)

    const upload = vi.fn(async () => ({ url: 'https://cdn/x' }))
    await expect(publishStage({ store, upload }).run(ctx)).rejects.toThrow(PublishRefused)
    expect(upload).not.toHaveBeenCalled()
    expect(store.snapshots).toHaveLength(0)
  })

  it('publishes and records the new count', async () => {
    const store = new MemoryStore()
    await registryStage({ store, full: true, ...fakeRegistry([srv('a/one'), srv('b/two')]) }).run(ctx)
    const upload = vi.fn(async () => ({ url: 'https://cdn/x.json.gz' }))

    const out = await publishStage({ store, upload }).run(ctx)
    expect(out.error).toBeNull()
    expect(upload).toHaveBeenCalledOnce()
    expect(store.snapshots[0]?.entryCount).toBe(2)
    expect(await store.readSyncState(PREVIOUS_COUNT_KEY)).toBe('2')
  })

  it('builds and checks but never writes on a dry run', async () => {
    const store = new MemoryStore()
    await registryStage({ store, full: true, ...fakeRegistry([srv('a/one')]) }).run(ctx)
    const out = await publishStage({ store }).run(ctx)
    expect(out.error).toBeNull()
    expect(store.snapshots).toHaveLength(0)
  })
})

describe('buildSnapshot', () => {
  const entry = (key: string, updatedAt: string) => ({
    key, namespace: null, title: key, description: '', version: null,
    repositoryUrl: null, websiteUrl: null, status: 'active', packages: [], remotes: [],
    isFirstParty: false, vendorDomain: null, iconUrl: null, category: null,
    pricingTier: 'unknown' as const, evidence: 'unverified' as const, featuredRank: null,
    downloads: null, downloadsSource: null, publishedAt: null, updatedAt, verifiedAt: null
  })

  it('is deterministic regardless of input order', () => {
    const a = buildSnapshot([entry('b', '2026-01-02T00:00:00.000Z'), entry('a', '2026-01-01T00:00:00.000Z')])
    const b = buildSnapshot([entry('a', '2026-01-01T00:00:00.000Z'), entry('b', '2026-01-02T00:00:00.000Z')])
    // Same content must give the same digest, or every publish looks new and
    // every client re-downloads.
    expect(a.digest).toBe(b.digest)
  })

  it('changes digest when content changes', () => {
    const a = buildSnapshot([entry('a', '2026-01-01T00:00:00.000Z')])
    const b = buildSnapshot([entry('a', '2026-01-01T00:00:00.000Z'), entry('b', '2026-01-02T00:00:00.000Z')])
    expect(a.digest).not.toBe(b.digest)
  })

  it('sets the cursor to the newest entry, so the first delta asks for the right thing', () => {
    const snap = buildSnapshot([entry('a', '2026-01-01T00:00:00.000Z'), entry('b', '2026-06-01T00:00:00.000Z')])
    expect(Buffer.from(snap.cursor, 'base64url').toString()).toBe('2026-06-01T00:00:00.000Z|b')
  })

  it('gzips', () => {
    const snap = buildSnapshot([entry('a', '2026-01-01T00:00:00.000Z')])
    expect(snap.bytes.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]))
  })
})

describe('orchestrator', () => {
  it('runs every stage and records each one', async () => {
    const store = new MemoryStore()
    const report = await runSync({
      store, ctx,
      stages: [
        registryStage({ store, full: true, ...fakeRegistry([srv('a/one')]) }),
        downloadsStage({ store, fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch }),
        probeStage({ store }),
        publishStage({ store })
      ]
    })
    expect(report.ok).toBe(true)
    expect(store.runs.map((r) => r.stage)).toEqual(['registry', 'downloads', 'probe', 'publish'])
  })

  it('aborts on a failed registry pull, before touching publish', async () => {
    const store = new MemoryStore()
    const fetchImpl = (async () => new Response('down', { status: 503 })) as unknown as typeof fetch
    const publish = publishStage({ store })
    const spy = vi.spyOn(publish, 'run')

    const report = await runSync({
      store, ctx,
      stages: [registryStage({ store, full: true, fetchImpl }), publish]
    })

    expect(report.ok).toBe(false)
    expect(report.abortedAt?.stage).toBe('registry')
    expect(spy).not.toHaveBeenCalled()
  })

  it('records the failure that stopped the run', async () => {
    // Losing the row that explains why a sync stopped is what makes an
    // unattended job unfixable.
    const store = new MemoryStore()
    const fetchImpl = (async () => new Response('down', { status: 503 })) as unknown as typeof fetch
    await runSync({ store, ctx, stages: [registryStage({ store, full: true, fetchImpl })] })
    expect(store.runs).toHaveLength(1)
    expect(store.runs[0]?.error).toMatch(/HTTP 503/)
  })

  it('carries on past a non-critical failure', async () => {
    const store = new MemoryStore()
    const report = await runSync({
      store, ctx,
      stages: [
        registryStage({ store, full: true, ...fakeRegistry([srv('a/one')]) }),
        { name: 'icons', run: async () => { throw new Error('vendor timeout') } },
        publishStage({ store })
      ]
    })
    // A missing icon is a monogram, not a reason to skip a week.
    expect(report.ok).toBe(true)
    expect(store.runs.find((r) => r.stage === 'icons')?.error).toBe('vendor timeout')
  })
})
