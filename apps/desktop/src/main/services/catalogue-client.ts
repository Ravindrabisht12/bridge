import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import type { CatalogueEntry, Page, SnapshotMeta } from '@bridge/types'

export function serviceUrl(raw: string): string {
  const url = new URL(raw)
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) {
    throw new Error('Catalogue service requires HTTPS (localhost HTTP is allowed)')
  }
  return url.href.replace(/\/$/, '')
}

export function validateEntries(value: unknown): CatalogueEntry[] {
  if (!Array.isArray(value) || value.length > 5000) throw new Error('Invalid catalogue entry list')
  const keys = new Set<string>()
  for (const item of value) {
    if (!item || typeof item.key !== 'string' || !item.key || keys.has(item.key) || typeof item.title !== 'string' ||
        typeof item.description !== 'string' || !Array.isArray(item.packages) || !Array.isArray(item.remotes) ||
        !['active', 'deprecated', 'deleted'].includes(item.status) || typeof item.updatedAt !== 'string' || !Number.isFinite(Date.parse(item.updatedAt))) {
      throw new Error('Invalid catalogue entry')
    }
    keys.add(item.key)
  }
  return value as CatalogueEntry[]
}

export async function limitedFetch(url: string, signal: AbortSignal, maxBytes = 8 * 1024 * 1024): Promise<Buffer> {
  const response = await fetch(url, { signal, redirect: 'error' })
  if (!response.ok) throw new Error(`Catalogue request failed: HTTP ${response.status}`)
  if (!response.body) throw new Error('Empty catalogue response')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length
    if (size > maxBytes) throw new Error('Catalogue response exceeds size limit')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

export function decodeSnapshot(bytes: Buffer, meta: SnapshotMeta): CatalogueEntry[] {
  if (bytes.length !== meta.bytes) throw new Error('Snapshot size mismatch')
  const json = gunzipSync(bytes, { maxOutputLength: 16 * 1024 * 1024 })
  const digest = 'sha256-' + createHash('sha256').update(json).digest('hex')
  if (digest !== meta.digest) throw new Error('Snapshot digest mismatch')
  const body = JSON.parse(json.toString('utf8'))
  if (body.version !== 1) throw new Error('Unsupported snapshot version')
  const entries = validateEntries(body.entries)
  if (!entries.length || entries.length !== meta.entryCount) throw new Error('Snapshot count mismatch')
  return entries
}

export async function searchService(base: string, term: string, cursor: string | null, signal: AbortSignal): Promise<Page<CatalogueEntry>> {
  const query = new URLSearchParams({ q: term, limit: '100' })
  if (cursor) query.set('cursor', cursor)
  const page = JSON.parse((await limitedFetch(`${base}/v1/search?${query}`, signal)).toString('utf8'))
  page.items = validateEntries(page.items)
  if (page.nextCursor !== null && typeof page.nextCursor !== 'string') throw new Error('Invalid search cursor')
  return page
}
