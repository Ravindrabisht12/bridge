/**
 * Stage 2: weekly download counts from npm and PyPI.
 *
 * Degrades. A missing number is a missing number; it is not a reason to skip a
 * week of catalogue updates.
 *
 * Null rather than 0 when unknown, so "no data" and "nobody uses it" stay
 * distinguishable — the registry publishes no popularity signal at all, so this
 * is the only such signal in the product and a wrong zero would be worse than
 * a blank.
 */
import type { Stage, StageContext } from '../stages'
import type { CatalogueStore } from '../store'

const TIMEOUT_MS = 15_000

export async function fetchDownloads(
  registryType: string,
  identifier: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ downloads: number; source: 'npm' | 'pypi' } | null> {
  const get = async <T>(url: string): Promise<T> => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    try {
      const res = await fetchImpl(url, { signal: ctrl.signal, headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()) as T
    } finally {
      clearTimeout(timer)
    }
  }

  try {
    if (registryType === 'npm') {
      const d = await get<{ downloads?: number }>(
        `https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(identifier)}`
      )
      return typeof d.downloads === 'number' ? { downloads: d.downloads, source: 'npm' } : null
    }
    if (registryType === 'pypi') {
      const d = await get<{ data?: { last_week?: number } }>(
        `https://pypistats.org/api/packages/${encodeURIComponent(identifier.toLowerCase())}/recent`
      )
      const week = d.data?.last_week
      return typeof week === 'number' ? { downloads: week, source: 'pypi' } : null
    }
  } catch {
    // A 404 for an unpublished package and a rate limit look the same from
    // here, and neither is worth failing a stage over.
  }
  return null
}

export interface DownloadsStageOptions {
  store: CatalogueStore
  fetchImpl?: typeof fetch
  /**
   * One request per package and thousands of packaged servers, so this runs to
   * a time budget and resumes next week. A fixed small batch would take dozens
   * of runs to converge; no budget at all would run for hours.
   */
  budgetMs?: number
  batch?: number
  concurrency?: number
}

export function downloadsStage(opts: DownloadsStageOptions): Stage {
  return {
    name: 'downloads',
    async run(ctx: StageContext) {
      const deadline = ctx.now().getTime() + (opts.budgetMs ?? 4 * 60_000)
      const targets = await opts.store.downloadTargets(opts.batch ?? 2000)
      let fetched = 0
      let changed = 0

      const queue = [...targets]
      const worker = async (): Promise<void> => {
        for (let t = queue.shift(); t; t = queue.shift()) {
          if (ctx.now().getTime() > deadline) return
          fetched++
          const result = await fetchDownloads(t.registryType, t.identifier, opts.fetchImpl)
          if (result) {
            await opts.store.setDownloads(t.key, result.downloads, result.source)
            changed++
          }
        }
      }
      await Promise.all(Array.from({ length: opts.concurrency ?? 6 }, worker))

      ctx.log(`downloads: ${changed} of ${fetched} resolved`)
      return { fetched, added: 0, changed, removed: 0, error: null }
    }
  }
}
