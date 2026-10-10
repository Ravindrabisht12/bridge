/**
 * The crawl guard.
 *
 * The registry pages alphabetically, so a cap reached quietly does not mean
 * "most of the catalogue" — it means whole namespaces are absent, `io.github.*`
 * included, which is most of the real servers. That bug cost real time to find
 * once. These tests make it impossible to reintroduce by accident.
 */
import { describe, expect, it } from 'vitest'
import { RegistryTruncatedError, crawl } from '../src/client'
import type { RegistryEntry } from '../src/schema'

const server = (name: string): RegistryEntry => ({ server: { name, description: '' } })

/** A fake registry with `total` entries, paged like the real one. */
function fakeRegistry(total: number, pageSize = 2) {
  const calls: string[] = []
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input))
    calls.push(url.search)
    const cursor = Number(url.searchParams.get('cursor') ?? 0)
    const slice = Array.from({ length: Math.min(pageSize, total - cursor) }, (_, i) =>
      server(`io.github.x/s${cursor + i}`)
    )
    const next = cursor + slice.length
    return new Response(
      JSON.stringify({ servers: slice, metadata: next < total ? { nextCursor: String(next) } : {} }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  }
  return { fetchImpl, calls }
}

describe('crawl', () => {
  it('yields every page and every entry', async () => {
    const { fetchImpl } = fakeRegistry(5)
    const seen: string[] = []
    for await (const page of crawl({ fetchImpl, pageSize: 2 })) {
      for (const e of page.entries) seen.push(e.server.name)
    }
    expect(seen).toHaveLength(5)
    expect(seen.at(-1)).toBe('io.github.x/s4')
  })

  it('reports a running total per page', async () => {
    const { fetchImpl } = fakeRegistry(5)
    const totals: number[] = []
    for await (const page of crawl({ fetchImpl, pageSize: 2 })) totals.push(page.fetched)
    expect(totals).toEqual([2, 4, 5])
  })

  it('throws rather than returning a truncated catalogue', async () => {
    // The whole point: a cap that is hit must be loud. Returning quietly here
    // is what silently drops namespaces.
    const { fetchImpl } = fakeRegistry(100)
    const run = async () => {
      for await (const _ of crawl({ fetchImpl, pageSize: 2, maxPages: 3 })) { /* drain */ }
    }
    await expect(run()).rejects.toThrow(RegistryTruncatedError)
    await expect(run()).rejects.toThrow(/missing whole namespaces/)
  })

  it('does not throw when the guard is merely reached with nothing left', async () => {
    // Exactly 3 pages of data and a 3-page cap is a complete crawl, not a
    // truncation — the difference is whether a cursor is still in hand.
    const { fetchImpl } = fakeRegistry(6)
    const run = async () => {
      for await (const _ of crawl({ fetchImpl, pageSize: 2, maxPages: 3 })) { /* drain */ }
    }
    await expect(run()).resolves.toBeUndefined()
  })

  it('passes updated_since through for an incremental pass', async () => {
    const { fetchImpl, calls } = fakeRegistry(2)
    for await (const _ of crawl({ fetchImpl, pageSize: 2, updatedSince: '2026-01-01T00:00:00Z' })) { /* drain */ }
    expect(calls[0]).toContain('updated_since=2026-01-01')
  })

  it('omits updated_since for a full pass', async () => {
    const { fetchImpl, calls } = fakeRegistry(2)
    for await (const _ of crawl({ fetchImpl, pageSize: 2 })) { /* drain */ }
    expect(calls[0]).not.toContain('updated_since')
  })

  it('stops when signalled, without throwing', async () => {
    const { fetchImpl } = fakeRegistry(100)
    const signal = { aborted: false }
    let pages = 0
    for await (const _ of crawl({ fetchImpl, pageSize: 2, signal })) {
      pages++
      if (pages === 2) signal.aborted = true
    }
    expect(pages).toBe(2)
  })

  it('surfaces an HTTP error instead of yielding an empty page', async () => {
    // An outage answering 503 must not look like "the catalogue is empty".
    const fetchImpl: typeof fetch = async () => new Response('nope', { status: 503 })
    const run = async () => {
      for await (const _ of crawl({ fetchImpl })) { /* drain */ }
    }
    await expect(run()).rejects.toThrow(/HTTP 503/)
  })
})
