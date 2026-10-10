/**
 * Ranked favicon discovery — how a browser actually finds a site's icon.
 *
 * Shared because both sides need it: the desktop app resolved icons this way
 * before the catalogue moved server-side, and the worker now has to do it once
 * centrally so no user's machine ever asks a vendor for an icon.
 *
 * This is not `GET /favicon.ico`. That was tried and it is not good enough:
 * many vendors serve nothing there (Replicate answers 404), several serve HTML,
 * and where it does exist it is usually 16px — which renders as a blur in a
 * 46px slot. So candidates come from the conventional paths, the page's own
 * `<link rel="icon">` tags and its web manifest, are ranked largest-first with
 * real PNG width read from the IHDR chunk rather than trusting the declared
 * `sizes`, and `.ico` is held back as an explicit fallback rather than ranked
 * last — capping the attempt list without separating the two lost Canva,
 * MongoDB and Asana entirely.
 *
 * Pure over an injected `fetch`, so the worker can pass its SSRF-guarded one.
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

const HTML_TIMEOUT_MS = 12_000

export interface IconCandidate {
  url: string
  /** Declared or measured pixel size. Vector counts as very large. */
  size: number
  source: 'path' | 'link' | 'manifest'
}

/** Conventional locations, richest first. */
export const CONVENTIONAL_PATHS = [
  '/apple-touch-icon.png',
  '/apple-touch-icon-precomposed.png',
  '/android-chrome-192x192.png',
  '/favicon-192x192.png',
  '/favicon.svg',
  '/favicon-96x96.png',
  '/favicon-32x32.png',
  '/favicon.png',
  '/favicon.ico'
]

/** `192x192`, `any`, `16x16 32x32` -> the largest number, or 0. */
export function parseSizes(value: string | undefined): number {
  if (!value) return 0
  if (/\bany\b/i.test(value)) return 1024
  let best = 0
  for (const token of value.split(/\s+/)) {
    const m = /^(\d+)x(\d+)$/i.exec(token)
    if (m) best = Math.max(best, Number(m[1]))
  }
  return best
}

/** A hint from the file name when nothing else says how big it is. */
export function sizeFromUrl(url: string): number {
  if (/\.svg(\?|$)/i.test(url)) return 1024
  const m = /(\d{2,4})x\1|[-_](\d{2,4})\.(png|jpe?g|webp)(\?|$)/i.exec(url)
  if (m) return Number(m[1] ?? m[2])
  if (/\.ico(\?|$)/i.test(url)) return 16
  return 0
}

/**
 * Actual dimensions of a PNG, read from the IHDR header. Declared sizes lie
 * often enough — ClickUp advertises a 16x16 as its main icon — that measuring
 * the bytes is worth the few lines.
 */
export function pngWidth(bytes: Buffer): number {
  if (bytes.length < 24) return 0
  const isPng = bytes.readUInt32BE(0) === 0x89504e47
  return isPng ? bytes.readUInt32BE(16) : 0
}

/** Icon links and manifest entries declared by a page. */
export async function candidatesFromPage(domain: string, fetchImpl = fetch): Promise<IconCandidate[]> {
  const base = `https://${domain}/`
  const out: IconCandidate[] = []

  let html: string
  try {
    const res = await fetchImpl(base, {
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: AbortSignal.timeout(HTML_TIMEOUT_MS)
    })
    // A 403 here is common (bot protection); the conventional paths still work.
    if (!res.ok) return out
    html = (await res.text()).slice(0, 400_000)
  } catch {
    return out
  }

  const resolve = (href: string, from = base): string | null => {
    try {
      return new URL(href, from).toString()
    } catch {
      return null
    }
  }

  let manifestHref: string | null = null
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = (/rel=["']([^"']+)["']/i.exec(tag) ?? [])[1] ?? ''
    const href = (/href=["']([^"']+)["']/i.exec(tag) ?? [])[1]
    if (!href) continue

    if (/\bmanifest\b/i.test(rel)) {
      manifestHref = resolve(href)
      continue
    }
    if (!/\b(icon|apple-touch-icon|apple-touch-icon-precomposed|shortcut icon)\b/i.test(rel)) continue

    const url = resolve(href)
    if (!url) continue
    const declared = parseSizes((/sizes=["']([^"']+)["']/i.exec(tag) ?? [])[1])
    // An apple-touch-icon with no declared size is 180 by convention.
    const fallback = /apple-touch-icon/i.test(rel) ? 180 : sizeFromUrl(url)
    out.push({ url, size: declared || fallback, source: 'link' })
  }

  if (manifestHref) {
    try {
      const res = await fetchImpl(manifestHref, {
        headers: { 'user-agent': UA },
        signal: AbortSignal.timeout(8000)
      })
      if (res.ok) {
        const manifest = (await res.json()) as { icons?: Array<{ src?: string; sizes?: string }> }
        for (const icon of manifest.icons ?? []) {
          if (!icon.src) continue
          const url = resolve(icon.src, manifestHref)
          if (!url) continue
          out.push({ url, size: parseSizes(icon.sizes) || sizeFromUrl(url), source: 'manifest' })
        }
      }
    } catch {
      /* a missing manifest is not an error */
    }
  }

  return out
}

/** Conventional paths as candidates, before anything is fetched. */
export function conventionalCandidates(domain: string): IconCandidate[] {
  return CONVENTIONAL_PATHS.map((path) => ({
    url: `https://${domain}${path}`,
    size: /apple-touch/i.test(path) ? 180 : sizeFromUrl(path),
    source: 'path' as const
  }))
}

/**
 * Best-first ordering. Vector wins, then declared size; an `.ico` is the last
 * resort because it is almost always tiny.
 */
export function rankCandidates(candidates: readonly IconCandidate[]): IconCandidate[] {
  const seen = new Set<string>()
  return candidates
    .filter((c) => {
      if (seen.has(c.url)) return false
      seen.add(c.url)
      return true
    })
    .sort((a, b) => {
      const ico = (c: IconCandidate): number => (/\.ico(\?|$)/i.test(c.url) ? 1 : 0)
      if (ico(a) !== ico(b)) return ico(a) - ico(b)
      return b.size - a.size
    })
}
