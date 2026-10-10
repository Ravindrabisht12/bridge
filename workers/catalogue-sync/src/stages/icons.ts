/**
 * Stage 4: resolve each curated vendor's icon, once, centrally.
 *
 * Degrades. A missing icon is a monogram; it is not a reason to skip a week of
 * catalogue updates.
 *
 * This is the stage that lets the desktop app stop asking vendors for icons.
 * Before the catalogue moved server-side, every install crawled every
 * publisher's homepage to find one — which told dozens of vendors that a Bridge
 * user existed, in an app whose whole premise is that you can see what leaves
 * your machine. Done here it happens once for everyone.
 *
 * Discovery is `@bridge/favicon`, the same ranked search the desktop app used:
 * conventional paths, the page's own `<link rel="icon">` tags and its web
 * manifest, ranked largest-first with real PNG width read from the IHDR chunk.
 * A plain `GET /favicon.ico` is not a substitute — Replicate answers 404 there,
 * several vendors serve HTML, and where it exists it is usually 16px, which is
 * a blur in a 46px slot.
 */
import { createHash } from 'node:crypto'
import { candidatesFromPage, conventionalCandidates, pngWidth, rankCandidates } from '@bridge/favicon'
import { publicFetch } from '../network'
import type { Stage, StageContext } from '../stages'
import type { AssetStorage } from '../storage'
import type { CatalogueStore, IconTarget } from '../store'

/** Rendered in an `<img>`, which has no scripting context, so SVG is safe. */
const TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico'
}

const MAX_BYTES = 256 * 1024
/** Anything this wide renders crisply at 2x in a 46px slot. */
const GOOD_ENOUGH = 128
/** Beyond this the ranking has already offered everything worth trying. */
const MAX_ATTEMPTS = 8

export interface ResolvedIcon {
  url: string
  bytes: Buffer
  mime: string
  width: number
}

async function download(url: string, fetchImpl: typeof fetch): Promise<{ bytes: Buffer; mime: string } | null> {
  const res = await fetchImpl(url, { redirect: 'error' })
  const mime = res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? ''
  if (!res.ok || !TYPES[mime]) return null
  const bytes = Buffer.from(await res.arrayBuffer())
  if (!bytes.length || bytes.length > MAX_BYTES) return null
  return { bytes, mime }
}

/**
 * The ranked search. `.ico` is held back rather than ranked last: it is nearly
 * always tiny, but it is also the only thing some vendors publish, and capping
 * the attempt list without separating the two lost Canva, MongoDB and Asana
 * entirely.
 */
export async function resolveIcon(
  target: IconTarget,
  fetchImpl: typeof fetch = publicFetch
): Promise<ResolvedIcon | null> {
  const pinned = target.iconUrl
  if (pinned) {
    try {
      const got = await download(pinned, fetchImpl)
      if (got) return { url: pinned, ...got, width: measure(got.bytes, got.mime) }
    } catch {
      /* fall through to discovery */
    }
  }

  let discovered: Awaited<ReturnType<typeof candidatesFromPage>> = []
  try {
    discovered = await candidatesFromPage(target.iconDomain, fetchImpl)
  } catch {
    /* a homepage that will not load still has conventional paths */
  }
  const ranked = rankCandidates([...conventionalCandidates(target.iconDomain), ...discovered])
  const isIco = (u: string): boolean => /\.ico(\?|$)/i.test(u)
  const preferred = ranked.filter((c) => !isIco(c.url)).slice(0, MAX_ATTEMPTS)
  const fallbacks = ranked.filter((c) => isIco(c.url))

  let best: ResolvedIcon | null = null
  for (const candidate of preferred) {
    try {
      const got = await download(candidate.url, fetchImpl)
      if (!got) continue
      const width = measure(got.bytes, got.mime, candidate.size)
      if (!best || width > best.width) best = { url: candidate.url, ...got, width }
      if (width >= GOOD_ENOUGH) return best
    } catch {
      continue
    }
  }
  if (best) return best

  for (const candidate of fallbacks) {
    try {
      const got = await download(candidate.url, fetchImpl)
      if (got) return { url: candidate.url, ...got, width: measure(got.bytes, got.mime, candidate.size) }
    } catch {
      continue
    }
  }
  return null
}

/** Measured where possible; the declared size otherwise. */
function measure(bytes: Buffer, mime: string, declared = 0): number {
  if (mime === 'image/svg+xml') return 1024
  try {
    return pngWidth(bytes) || declared
  } catch {
    return declared
  }
}

export interface IconsStageOptions {
  store: CatalogueStore
  storage: AssetStorage
  fetchImpl?: typeof fetch
  concurrency?: number
}

export function iconsStage(opts: IconsStageOptions): Stage {
  return {
    name: 'icons',
    async run(ctx: StageContext) {
      const targets = await opts.store.iconTargets()
      let fetched = 0
      let changed = 0

      const queue = [...targets]
      const worker = async (): Promise<void> => {
        for (let target = queue.shift(); target; target = queue.shift()) {
          fetched++
          try {
            const icon = await resolveIcon(target, opts.fetchImpl)
            if (!icon) {
              ctx.log(`icons: nothing usable for ${target.key}`)
              continue
            }
            // Content-addressed, so two vendors sharing a mark share one object
            // and re-resolving identical bytes is a no-op.
            const key = `icons/${createHash('sha256').update(icon.bytes).digest('hex')}.${TYPES[icon.mime]}`
            if (key === target.iconAsset) continue
            await opts.storage.put(key, icon.bytes, icon.mime)
            await opts.store.setIconAsset(target.key, key)
            changed++
          } catch (err) {
            ctx.log(`icons: ${target.key} failed — ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      }
      // Low: these are other people's servers.
      await Promise.all(Array.from({ length: opts.concurrency ?? 4 }, worker))

      ctx.log(`icons: ${changed} of ${fetched} resolved`)
      return { fetched, added: 0, changed, removed: 0, error: null }
    }
  }
}
