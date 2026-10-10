import { describe, expect, it } from 'vitest'
import { MAX_SEARCH_OFFSET, clampLimit, decodeCursor, decodeOffset, encodeCursor, encodeOffset } from '../src/cursor'

describe('cursors', () => {
  it('round-trips', () => {
    const c = { updatedAt: '2026-01-02T03:04:05.000Z', key: 'io.github.a/b' }
    expect(decodeCursor(encodeCursor(c))).toEqual(c)
  })

  it('survives a key containing the separator', () => {
    // Keys are reverse-DNS and could contain anything; splitting on the last
    // '|' instead of the first would corrupt one.
    const c = { updatedAt: '2026-01-02T03:04:05.000Z', key: 'weird|key/with|pipes' }
    expect(decodeCursor(encodeCursor(c))).toEqual(c)
  })

  it('rejects junk rather than guessing', () => {
    expect(decodeCursor(null)).toBeNull()
    expect(decodeCursor('')).toBeNull()
    expect(decodeCursor('not-base64!!!')).toBeNull()
    expect(decodeCursor(Buffer.from('nopipe').toString('base64url'))).toBeNull()
    expect(decodeCursor(Buffer.from('|onlykey').toString('base64url'))).toBeNull()
    expect(decodeCursor(Buffer.from('notadate|k').toString('base64url'))).toBeNull()
  })

  it('round-trips an offset cursor', () => {
    expect(decodeOffset(encodeOffset(0))).toBe(0)
    expect(decodeOffset(encodeOffset(250))).toBe(250)
  })

  it('rejects an offset beyond the cap rather than scanning deep', () => {
    expect(decodeOffset(encodeOffset(MAX_SEARCH_OFFSET))).toBe(MAX_SEARCH_OFFSET)
    expect(decodeOffset(encodeOffset(MAX_SEARCH_OFFSET + 1))).toBeNull()
    expect(decodeOffset(encodeOffset(-1))).toBeNull()
  })

  it('does not confuse the two cursor kinds', () => {
    // A keyset cursor handed to the offset decoder, and the reverse, must both
    // be refused — they mean different things and page different orderings.
    expect(decodeOffset(encodeCursor({ updatedAt: '2026-01-01T00:00:00.000Z', key: 'a' }))).toBeNull()
    expect(decodeCursor(encodeOffset(5))).toBeNull()
  })

  it('clamps a limit instead of trusting or rejecting it', () => {
    expect(clampLimit(undefined, 25, 100)).toBe(25)
    expect(clampLimit('50', 25, 100)).toBe(50)
    expect(clampLimit('99999', 25, 100)).toBe(100)
    expect(clampLimit('0', 25, 100)).toBe(25)
    expect(clampLimit('-5', 25, 100)).toBe(25)
    expect(clampLimit('abc', 25, 100)).toBe(25)
  })
})
