/**
 * The Library used to sit on grey monograms for several seconds after every
 * restart. The bytes were cached; the *decision* of which URL won for a domain
 * was not, so each launch re-fetched every vendor's homepage to work out again
 * what it already knew. These pin the remembering.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IconCache, type IconMemory } from '../main/services/icons'

const silentLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {}
} as never

function fakeMemory(seed: Array<[string, string | null, number]> = []): IconMemory & { writes: number } {
  const rows = new Map(seed.map(([d, url, at]) => [d, { iconUrl: url, resolvedAt: at }]))
  return {
    writes: 0,
    all: () => new Map(rows),
    remember(domain, iconUrl) {
      this.writes++
      rows.set(domain, { iconUrl, resolvedAt: Date.now() })
    }
  }
}

describe('IconCache durable resolutions', () => {
  // Never the real data directory: constructing the cache creates its icon
  // folder, and a unit test has no business in the user's Application Support.
  beforeEach(() => {
    vi.stubEnv('BRIDGE_HOME', mkdtempSync(join(tmpdir(), 'bridge-icons-')))
  })

  it('answers a remembered domain without touching the network', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const memory = fakeMemory([['figma.com', 'https://figma.com/favicon.ico', Date.now()]])
    const cache = new IconCache(silentLog, memory)

    // No bytes on disk under this test's home, so `get` is reached — but the
    // point is that resolution never runs: exactly one request, for the
    // remembered URL, rather than a homepage parse plus eight candidates.
    await cache.favicon('figma.com')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe('https://figma.com/favicon.ico')

    vi.unstubAllGlobals()
  })

  it('remembers "no usable icon" so the candidates are not re-probed', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const memory = fakeMemory([['nothing.example', null, Date.now()]])
    const cache = new IconCache(silentLog, memory)

    expect(await cache.favicon('nothing.example')).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()

    vi.unstubAllGlobals()
  })

  it('normalises the domain before looking it up', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const memory = fakeMemory([['figma.com', null, Date.now()]])
    const cache = new IconCache(silentLog, memory)

    expect(await cache.favicon('https://FIGMA.com/some/path')).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()

    vi.unstubAllGlobals()
  })

  it('rejects a domain that is not one', async () => {
    const cache = new IconCache(silentLog, fakeMemory())
    expect(await cache.favicon('')).toBeNull()
    expect(await cache.favicon('not a domain')).toBeNull()
  })

  it('treats a stale hit as usable rather than making the user wait', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('offline'))
    vi.stubGlobal('fetch', fetchSpy)

    const old = Date.now() - 400 * 24 * 60 * 60 * 1000
    const memory = fakeMemory([['figma.com', 'https://figma.com/icon.png', old]])
    const cache = new IconCache(silentLog, memory)

    await cache.favicon('figma.com')
    // The remembered URL is what was asked for; re-resolution is deferred.
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe('https://figma.com/icon.png')

    vi.unstubAllGlobals()
  })
})
