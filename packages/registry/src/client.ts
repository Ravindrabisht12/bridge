/**
 * The paginating registry client.
 *
 * An async generator rather than a function returning an array: the catalogue
 * is ~27,000 entries and the caller — desktop app or worker — wants to write
 * each page as it lands rather than hold the whole thing in memory first.
 *
 * `MAX_PAGES` is a runaway guard, not a budget. Reaching it means the caller
 * did NOT see the whole catalogue, and because the registry pages
 * alphabetically that means whole namespaces are missing. So exhausting it
 * raises rather than returning quietly — a truncated catalogue that looks
 * successful is the worst of the available outcomes.
 */
import { REGISTRY_BASE, type RegistryEntry, type RegistryListResponse } from './schema'

export const PAGE_SIZE = 100
export const MAX_PAGES = 600
export const REQUEST_TIMEOUT_MS = 60_000

export class RegistryTruncatedError extends Error {
  constructor(readonly pages: number, readonly fetched: number) {
    super(
      `registry paging hit the ${pages}-page guard after ${fetched} entries; ` +
        'the catalogue is alphabetical, so this result is missing whole namespaces'
    )
    this.name = 'RegistryTruncatedError'
  }
}

export interface RegistryPage {
  entries: RegistryEntry[]
  /** 1-based. */
  page: number
  /** Running total across pages. */
  fetched: number
}

export interface CrawlOptions {
  baseUrl?: string
  /** ISO 8601. Omit for a full pass. */
  updatedSince?: string | null
  pageSize?: number
  maxPages?: number
  /** Injected so tests need no network and the worker can add retries. */
  fetchImpl?: typeof fetch
  /** Checked between pages so a long crawl can be stopped. */
  signal?: { aborted: boolean }
}

async function getJson<T>(url: string, fetchImpl: typeof fetch): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: 'application/json', 'user-agent': 'Bridge-MCP-Client' }
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`)
    return (await res.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

/** Yields pages until the registry runs out of cursor, or the guard trips. */
export async function* crawl(opts: CrawlOptions = {}): AsyncGenerator<RegistryPage> {
  const base = opts.baseUrl ?? REGISTRY_BASE
  const limit = opts.pageSize ?? PAGE_SIZE
  const maxPages = opts.maxPages ?? MAX_PAGES
  const fetchImpl = opts.fetchImpl ?? fetch

  let cursor: string | null = null
  let page = 0
  let fetched = 0

  do {
    if (opts.signal?.aborted) return

    const params = new URLSearchParams({ version: 'latest', limit: String(limit) })
    if (cursor) params.set('cursor', cursor)
    if (opts.updatedSince) params.set('updated_since', opts.updatedSince)

    const body = await getJson<RegistryListResponse>(`${base}/v0/servers?${params}`, fetchImpl)
    const entries = body.servers ?? []
    fetched += entries.length
    page++

    yield { entries, page, fetched }

    cursor = body.metadata?.nextCursor ?? null
  } while (cursor && page < maxPages)

  // A cursor still in hand means the registry had more to give.
  if (cursor) throw new RegistryTruncatedError(maxPages, fetched)
}
