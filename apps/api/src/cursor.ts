/**
 * Delta cursors.
 *
 * A cursor is `<iso timestamp>|<key>`, base64url'd so nobody is tempted to
 * parse it client-side. The key is in there because timestamps collide: a
 * worker upserting 3,000 rows in one transaction gives them all the same
 * `updated_at`, and a cursor of the timestamp alone would either re-send the
 * whole batch forever or skip the tail of it.
 *
 * Opaque to clients, and stated as opaque in the OpenAPI document, so the
 * encoding can change without breaking anyone.
 */
export interface Cursor {
  updatedAt: string
  key: string
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(`${c.updatedAt}|${c.key}`, 'utf8').toString('base64url')
}

/** Returns null for anything malformed — a bad cursor is a bad request. */
export function decodeCursor(raw: string | null | undefined): Cursor | null {
  if (!raw) return null
  let decoded: string
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8')
  } catch {
    return null
  }
  const split = decoded.indexOf('|')
  if (split <= 0) return null
  const updatedAt = decoded.slice(0, split)
  const key = decoded.slice(split + 1)
  // Reject a timestamp Postgres would refuse, rather than sending it a string
  // and finding out in the query planner.
  if (!key || Number.isNaN(Date.parse(updatedAt))) return null
  return { updatedAt, key }
}

/**
 * Search cursors are a different animal.
 *
 * Delta pages by keyset on `(updated_at, key)`, which works because that is
 * the sort order. Search is ordered by *relevance* — exact-name first, then
 * rank, then key — and a keyset cursor cannot express a position in that: the
 * rank is a float that would have to round-trip exactly, and it changes when
 * the underlying row changes.
 *
 * So search pages by offset, which is correct here for the reason it is usually
 * wrong elsewhere: the result set is small and nobody pages fifty deep into a
 * search. The offset is wrapped so it stays opaque, as the contract promises,
 * and capped so a hand-written `cursor` cannot ask Postgres for a deep scan.
 */
export const MAX_SEARCH_OFFSET = 1000

export function encodeOffset(offset: number): string {
  return Buffer.from(`o:${offset}`, 'utf8').toString('base64url')
}

/** Returns null for anything malformed or out of range. */
export function decodeOffset(raw: string | null | undefined): number | null {
  if (!raw) return null
  let decoded: string
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8')
  } catch {
    return null
  }
  if (!decoded.startsWith('o:')) return null
  if (!/^o:\d+$/.test(decoded)) return null
  const n = Number(decoded.slice(2))
  if (!Number.isInteger(n) || n < 0 || n > MAX_SEARCH_OFFSET) return null
  return n
}

/** Clamp a client-supplied limit. Absent, junk and 10,000 all become sane. */
export function clampLimit(raw: unknown, fallback: number, max: number): number {
  const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : typeof raw === 'number' ? raw : NaN
  if (!Number.isFinite(n) || n < 1) return fallback
  return Math.min(Math.trunc(n), max)
}
