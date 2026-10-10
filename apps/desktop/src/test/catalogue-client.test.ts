import { describe, expect, it } from 'vitest'
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { decodeSnapshot, serviceUrl } from '../main/services/catalogue-client'
import { OFFICIAL_SERVERS, officialIconData } from '@shared/official'

const entry = { key: 'vendor/tool', title: 'Tool', description: '', packages: [], remotes: [], status: 'active', updatedAt: '2026-09-01T00:00:00Z' }
function fixture(entries = [entry]) {
  const json = JSON.stringify({ version: 1, entries })
  const bytes = gzipSync(json)
  return { bytes, meta: { digest: 'sha256-' + createHash('sha256').update(json).digest('hex'), bytes: bytes.length, entryCount: entries.length, url: 'https://assets.example/snapshot.gz', cursor: '', generatedAt: '' } }
}
describe('catalogue integrity', () => {
  it('verifies and decodes a snapshot', () => {
    const f = fixture()
    expect(decodeSnapshot(f.bytes, f.meta)).toEqual([entry])
  })
  it('rejects tampering and duplicate keys before merge', () => {
    const f = fixture()
    expect(() => decodeSnapshot(f.bytes, { ...f.meta, digest: 'wrong' })).toThrow('digest')
    const duplicate = fixture([entry, entry])
    expect(() => decodeSnapshot(duplicate.bytes, duplicate.meta)).toThrow('entry')
  })
  it('allows local development and requires HTTPS elsewhere', () => {
    expect(serviceUrl('http://localhost:8787/')).toBe('http://localhost:8787')
    expect(() => serviceUrl('http://example.com')).toThrow('HTTPS')
    expect(() => serviceUrl('https://token@example.com')).toThrow('HTTPS')
  })
})

describe('curated icons ship with the app', () => {
  it('has a mark for every curated entry', () => {
    // The Library is compiled in so it works before there is a network. Without
    // icons it rendered as 55 grey monograms and looked broken — the desktop
    // app no longer asks vendors for icons, and `catalog:icons` is restricted
    // to a configured service's asset origin, so with no service there was no
    // icon path at all.
    const missing = OFFICIAL_SERVERS.filter((s) => !officialIconData(s.id)).map((s) => s.title)
    expect(missing).toEqual([])
  })

  it('serves them as inline data, needing no request', () => {
    const icon = officialIconData('off_github')
    expect(icon).toMatch(/^data:image\/[a-z+.-]+;base64,/)
  })

  it('accepts the bridge: prefixed key the catalogue uses', () => {
    expect(officialIconData('bridge:off_github')).toBe(officialIconData('off_github'))
  })

  it('returns null for anything uncurated', () => {
    expect(officialIconData('io.github.someone/rebuild')).toBeNull()
  })
})
