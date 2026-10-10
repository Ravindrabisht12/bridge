/**
 * Icon fetching and caching.
 *
 * Registry icons are URLs on each publisher's own domain. Letting the renderer
 * load them directly would mean every publisher whose row scrolls into view
 * learns your IP address and when you looked — a tracking beacon per entry, in
 * an app whose whole premise is that you should be able to see what leaves your
 * machine. It would also require loosening the renderer's CSP to allow remote
 * images.
 *
 * So icons are fetched here, in the main process, cached on disk, and handed to
 * the renderer as `data:` URIs. One fetch per icon, ever; no per-view beacon;
 * the CSP stays as tight as it was.
 *
 * Two things have to be remembered for that "ever" to hold across restarts:
 * the bytes, which go in the cache directory, and *which URL won for a domain*,
 * which goes in the database. Only caching the bytes meant every launch
 * re-fetched each vendor's homepage to rediscover a winner it already had —
 * which is exactly what made the Library sit on grey monograms for several
 * seconds after every restart.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bridgeHome } from '@shared/control'
import type { FileLogger } from '@shared/logger'
import {
  candidatesFromPage,
  conventionalCandidates,
  pngWidth,
  rankCandidates,
  type IconCandidate
} from './favicon'

const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  // Safe here specifically because icons are rendered in an <img>, which has
  // no scripting context — unlike inline <svg>, <object> or <embed>.
  'image/svg+xml',
  'image/webp',
  // Most vendor favicons are still served as ICO; browsers render them fine in
  // an <img>, and without these an official server shows a blank monogram and
  // reads as untrustworthy.
  'image/x-icon',
  'image/vnd.microsoft.icon'
])
const MAX_BYTES = 256 * 1024
const FETCH_TIMEOUT_MS = 8000

/**
 * How long a remembered decision is served before it is checked again. A hit
 * is refreshed in the background, so staleness never costs the user a wait; a
 * miss is retried sooner, because a vendor adding a favicon is more likely than
 * one changing theirs.
 */
const HIT_TTL_MS = 30 * 24 * 60 * 60 * 1000
const MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Durable storage for resolutions. An interface rather than a database handle
 * so the cache can be exercised without one.
 */
export interface IconMemory {
  all(): Map<string, { iconUrl: string | null; resolvedAt: number }>
  remember(domain: string, iconUrl: string | null): void
}

const EXT: Record<string, string> = {
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/svg+xml': 'svg',
  'image/webp': 'webp'
}

export class IconCache {
  private readonly dir = join(bridgeHome(), 'icons')
  /** Icons that failed once; not retried for the life of the process. */
  private readonly failed = new Set<string>()
  private readonly inFlight = new Map<string, Promise<string | null>>()
  /** domain -> winning icon URL (or null), plus when we decided that. */
  private readonly resolved = new Map<string, { iconUrl: string | null; resolvedAt: number }>()
  private readonly resolving = new Map<string, Promise<string | null>>()
  /** Domains already being refreshed in the background this session. */
  private readonly refreshing = new Set<string>()

  constructor(
    private readonly log: FileLogger,
    private readonly memory?: IconMemory
  ) {
    try {
      mkdirSync(this.dir, { recursive: true })
    } catch {
      /* a missing cache directory only costs us the icons */
    }
    // Loaded up front, in one query: the whole point is that opening the
    // Library on a warm machine touches the network zero times.
    try {
      if (memory) for (const [domain, entry] of memory.all()) this.resolved.set(domain, entry)
    } catch (err) {
      this.log.warn(`could not load remembered icons: ${(err as Error).message}`)
    }
  }

  private pathFor(url: string, mime: string): string {
    const hash = createHash('sha256').update(url).digest('hex').slice(0, 24)
    return join(this.dir, `${hash}.${EXT[mime] ?? 'img'}`)
  }

  private toDataUri(bytes: Buffer, mime: string): string {
    return `data:${mime};base64,${bytes.toString('base64')}`
  }

  /**
   * The vendor's own favicon, tried at the conventional locations.
   *
   * Registry entries carry an icon only ~7% of the time, and almost never for
   * the first-party servers people most want — so Atlassian rendered as a blank
   * letter and looked less trustworthy than a random npm package. The favicon
   * comes from the same domain the registry already verified, so it is the
   * vendor's own mark rather than a third-party icon service (which would also
   * leak every lookup to that service).
   */
  async favicon(domain: string): Promise<string | null> {
    const clean = domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    if (!clean || !/^[a-z0-9.-]+$/.test(clean)) return null

    // A resolved winner is remembered, because parsing a homepage to find it is
    // far too expensive to repeat on every render — or on every launch.
    const remembered = this.resolved.get(clean)
    if (remembered) {
      const ttl = remembered.iconUrl ? HIT_TTL_MS : MISS_TTL_MS
      const stale = Date.now() - remembered.resolvedAt > ttl
      if (!stale) return remembered.iconUrl ? this.get(remembered.iconUrl) : null

      // Stale but usable: answer now from what we know, look again behind the
      // user's back. A cached icon that is a month out of date beats a spinner.
      if (remembered.iconUrl) {
        this.refreshLater(clean)
        return this.get(remembered.iconUrl)
      }
    }

    const pending = this.resolving.get(clean)
    if (pending) return pending

    const task = this.resolveBest(clean).finally(() => this.resolving.delete(clean))
    this.resolving.set(clean, task)
    return task
  }

  /**
   * Resolves a known set of domains ahead of anyone asking, a few at a time.
   *
   * The remembering above means this happens once on a given machine. Without
   * it the *first* launch after an upgrade still shows grey monograms, because
   * the table starts empty — so the work is done while the user is looking at
   * some other page instead of while they are looking at the Library. On a warm
   * machine every domain is already known and this makes no requests at all.
   */
  async prewarm(want: { domains: readonly string[]; urls: readonly string[] }): Promise<void> {
    const now = Date.now()
    const domains = [...new Set(want.domains)].filter((d) => {
      const known = this.resolved.get(d.trim().toLowerCase())
      if (!known) return true
      return now - known.resolvedAt > (known.iconUrl ? HIT_TTL_MS : MISS_TTL_MS)
    })
    // A pinned URL needs no resolution, only its bytes — and it is reached by a
    // different call, so warming the vendor's domain would not cover it.
    const urls = [...new Set(want.urls)].filter((u) => !this.failed.has(u))

    const jobs: Array<() => Promise<unknown>> = [
      ...domains.map((d) => () => this.favicon(d)),
      ...urls.map((u) => () => this.get(u))
    ]
    if (jobs.length === 0) return

    this.log.info(`warming ${domains.length} vendor icons and ${urls.length} pinned ones`)
    // Four at a time: enough to finish quickly, gentle enough that it is not a
    // burst of sixty connections the moment the app opens.
    const queue = [...jobs]
    const workers = Array.from({ length: 4 }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        try {
          await job()
        } catch {
          /* one vendor's icon is never worth failing the rest for */
        }
      }
    })
    await Promise.all(workers)
    this.log.info('icon warm-up finished')
  }

  /** Re-resolves a domain without anybody waiting on the answer. */
  private refreshLater(domain: string): void {
    if (this.refreshing.has(domain) || this.resolving.has(domain)) return
    this.refreshing.add(domain)
    setTimeout(() => {
      void this.resolveBest(domain)
        .catch(() => null)
        .finally(() => this.refreshing.delete(domain))
    }, 1500).unref?.()
  }

  private async resolveBest(domain: string): Promise<string | null> {
    const candidates = rankCandidates([
      ...conventionalCandidates(domain),
      ...(await candidatesFromPage(domain))
    ])

    let best: { url: string; data: string; width: number } | null = null

    /*
     * `.ico` is ranked last because it is nearly always tiny — but it is also
     * the only thing some vendors publish. Capping the attempt list without
     * separating the two lost Canva, MongoDB and Asana entirely, so the
     * fallbacks are held back and tried only if nothing better worked.
     */
    const isIco = (c: IconCandidate): boolean => /\.ico(\?|$)/i.test(c.url)
    const preferred = candidates.filter((c) => !isIco(c)).slice(0, 8)
    const fallbacks = candidates.filter(isIco)

    for (const candidate of preferred) {
      const data = await this.get(candidate.url)
      if (!data) continue

      const width = this.measure(data, candidate)
      if (!best || width > best.width) best = { url: candidate.url, data, width }
      // Anything this size renders crisply at 2x in a 46px slot.
      if (width >= 128) break
    }

    if (!best) {
      for (const candidate of fallbacks) {
        const data = await this.get(candidate.url)
        if (!data) continue
        best = { url: candidate.url, data, width: this.measure(data, candidate) }
        break
      }
    }

    const winner = best?.url ?? null
    this.resolved.set(domain, { iconUrl: winner, resolvedAt: Date.now() })
    try {
      this.memory?.remember(domain, winner)
    } catch (err) {
      this.log.warn(`could not remember icon for ${domain}: ${(err as Error).message}`)
    }
    if (best) this.log.debug(`icon for ${domain}: ${best.width}px from ${best.url}`)
    else this.log.debug(`no usable icon for ${domain}`)
    return best?.data ?? null
  }

  /** Measured width where possible; the declared size otherwise. */
  private measure(dataUri: string, candidate: IconCandidate): number {
    if (dataUri.startsWith('data:image/svg')) return 1024
    const comma = dataUri.indexOf(',')
    if (comma === -1) return candidate.size
    try {
      const measured = pngWidth(Buffer.from(dataUri.slice(comma + 1), 'base64'))
      return measured || candidate.size
    } catch {
      return candidate.size
    }
  }

  /** Returns a data URI, or null when the icon cannot be used. */
  async get(url: string): Promise<string | null> {
    if (this.failed.has(url)) return null

    const existing = this.inFlight.get(url)
    if (existing) return existing

    const task = this.load(url).finally(() => this.inFlight.delete(url))
    this.inFlight.set(url, task)
    return task
  }

  private async load(url: string): Promise<string | null> {
    // Only ever fetch over https, and never follow a redirect to something else.
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      this.failed.add(url)
      return null
    }
    if (parsed.protocol !== 'https:') {
      this.failed.add(url)
      return null
    }

    for (const mime of ALLOWED_MIME) {
      const cached = this.pathFor(url, mime)
      if (existsSync(cached)) {
        try {
          return this.toDataUri(readFileSync(cached), mime)
        } catch {
          break
        }
      }
    }

    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS)
    try {
      const res = await fetch(parsed.toString(), {
        signal: abort.signal,
        // The origin was checked before the request; a redirect would leave it.
        redirect: 'error',
        headers: { accept: 'image/*', 'user-agent': 'Bridge-MCP-Client' }
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const mime = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
      if (!ALLOWED_MIME.has(mime)) throw new Error(`unsupported type ${mime || '(none)'}`)

      const buf = await readCapped(res, MAX_BYTES)

      try {
        writeFileSync(this.pathFor(url, mime), buf)
      } catch {
        /* an uncacheable icon is still usable this session */
      }
      return this.toDataUri(buf, mime)
    } catch (err) {
      this.failed.add(url)
      this.log.debug(`icon fetch failed for ${url}: ${(err as Error).message}`)
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Reads a response body, giving up as soon as it passes `max` bytes. */
async function readCapped(res: Response, max: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? 0)
  if (declared > max) throw new Error(`too large (${declared} bytes)`)
  if (!res.body) return Buffer.alloc(0)
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel()
      throw new Error(`too large (over ${max} bytes)`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}
