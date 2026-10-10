/**
 * Moved here with the code it tests. These cover the parts that were
 * expensive to get right: declared sizes lie, filenames sometimes tell the
 * truth, and PNG width has to be read from the IHDR chunk rather than trusted.
 */
import { describe, expect, it } from 'vitest'
import {
  conventionalCandidates,
  parseSizes,
  pngWidth,
  rankCandidates,
  sizeFromUrl
} from '../src/discovery'

describe('declared icon sizes', () => {
  it('reads a sizes attribute', () => {
    expect(parseSizes('192x192')).toBe(192)
    expect(parseSizes('16x16 32x32 48x48')).toBe(48)
  })

  it('treats a vector as effectively unbounded', () => {
    expect(parseSizes('any')).toBe(1024)
  })

  it('returns zero when nothing is declared', () => {
    expect(parseSizes(undefined)).toBe(0)
    expect(parseSizes('')).toBe(0)
    expect(parseSizes('nonsense')).toBe(0)
  })
})

describe('size hints from a url', () => {
  it('prefers vector', () => {
    expect(sizeFromUrl('https://x/favicon.svg')).toBe(1024)
  })

  it('reads a dimension out of the filename', () => {
    expect(sizeFromUrl('https://x/icon-512x512.png')).toBe(512)
    expect(sizeFromUrl('https://x/android-chrome-192x192.png')).toBe(192)
  })

  it('assumes an ico is tiny, because it nearly always is', () => {
    expect(sizeFromUrl('https://x/favicon.ico')).toBe(16)
  })

  it('says nothing when the name says nothing', () => {
    expect(sizeFromUrl('https://x/logo.png')).toBe(0)
  })
})

describe('png measurement', () => {
  it('reads width from the IHDR header', () => {
    const png = Buffer.alloc(32)
    png.writeUInt32BE(0x89504e47, 0)
    png.writeUInt32BE(256, 16)
    expect(pngWidth(png)).toBe(256)
  })

  it('returns zero for anything that is not a png', () => {
    expect(pngWidth(Buffer.from('not a png at all, really'))).toBe(0)
    expect(pngWidth(Buffer.alloc(4))).toBe(0)
  })
})

describe('candidate ranking', () => {
  it('puts the largest first', () => {
    const ranked = rankCandidates([
      { url: 'https://x/a-32.png', size: 32, source: 'path' },
      { url: 'https://x/b-512.png', size: 512, source: 'link' }
    ])
    expect(ranked[0]?.size).toBe(512)
  })

  it('sinks .ico below everything, however it was sized', () => {
    // An .ico is nearly always 16px whatever it claims, so it is a last resort.
    const ranked = rankCandidates([
      { url: 'https://x/favicon.ico', size: 999, source: 'path' },
      { url: 'https://x/small.png', size: 32, source: 'path' }
    ])
    expect(ranked[0]?.url).toContain('small.png')
    expect(ranked[1]?.url).toContain('favicon.ico')
  })

  it('drops duplicate urls', () => {
    const ranked = rankCandidates([
      { url: 'https://x/a.png', size: 64, source: 'path' },
      { url: 'https://x/a.png', size: 64, source: 'link' }
    ])
    expect(ranked).toHaveLength(1)
  })

  it('always offers an ico fallback among the conventional paths', () => {
    // Canva, MongoDB and Asana publish nothing else, so this must survive.
    const urls = conventionalCandidates('example.com').map((c) => c.url)
    expect(urls.some((u) => u.endsWith('/favicon.ico'))).toBe(true)
    expect(urls.some((u) => u.endsWith('/apple-touch-icon.png'))).toBe(true)
  })
})
