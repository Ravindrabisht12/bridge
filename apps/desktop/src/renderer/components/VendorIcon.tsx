/**
 * A vendor's real icon, shared by every page.
 *
 * The Library resolved icons on its own, so Servers, Tools and the trace all
 * showed coloured letters instead — the same server looked like two different
 * things depending on which page you were on. This centralises both the lookup
 * and the fallback so they agree everywhere.
 */
import { useEffect, useState } from 'react'
import { officialIconData, officialIconDomain, officialIconUrl } from '@shared/official'
import { api } from '../lib/api'

export interface IconHint {
  /** Stable identity for the thing being drawn. Drives the fallback colour. */
  key: string
  /** A direct icon URL, when one is known. */
  iconUrl?: string | null
  /** An endpoint whose host names the vendor. */
  endpoint?: string | null
  /** Catalogue key, so curated overrides apply. */
  catalogueKey?: string | null
}

/** The vendor domain an endpoint belongs to, with MCP subdomains stripped. */
export function domainFromEndpoint(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).host.replace(/^mcp\./, '').replace(/^api\./, '')
  } catch {
    return null
  }
}

/**
 * Resolves icons for a set of things in one pass. Returns a map keyed by the
 * hint's `key`; a missing entry means "draw the monogram".
 */
export function useVendorIcons(hints: readonly IconHint[]): Record<string, string> {
  const [byUrl, setByUrl] = useState<Record<string, string>>({})
  const [byDomain, setByDomain] = useState<Record<string, string>>({})

  /**
   * A curated vendor's mark ships with the app, so it needs no request at all
   * — which is the only reason the Library has icons before a catalogue service
   * is configured. Anything else has to come from the service.
   */
  const builtIn = (h: IconHint): string | null => officialIconData(h.catalogueKey ?? h.key)

  const pending = hints.filter((h) => !builtIn(h))

  // Two fetches, for whatever is left: exact URLs, and domains that need a
  // favicon lookup.
  const urls = pending
    .map((h) => officialIconUrl(h.catalogueKey ?? h.key) ?? h.iconUrl)
    .filter((u): u is string => !!u && byUrl[u] === undefined)

  const domains = pending
    .filter((h) => !(officialIconUrl(h.catalogueKey ?? h.key) ?? h.iconUrl))
    .map((h) => officialIconDomain(h.catalogueKey ?? h.key) ?? domainFromEndpoint(h.endpoint))
    .filter((d): d is string => !!d && byDomain[d] === undefined)

  const urlKey = urls.join('|')
  const domainKey = domains.join('|')

  // Keyed on the joined lists rather than the arrays themselves: a new array
  // identity every render would re-fetch forever.
  useEffect(() => {
    const wanted = urlKey ? urlKey.split('|') : []
    if (wanted.length === 0) return
    void api.invoke('catalog:icons', [...new Set(wanted)]).then((fetched) => {
      setByUrl((prev) => {
        const next = { ...prev }
        // Record misses too, so a URL without an icon is not retried forever.
        for (const u of wanted) next[u] = fetched[u] ?? ''
        return next
      })
    })
  }, [urlKey])

  useEffect(() => {
    const wanted = domainKey ? domainKey.split('|') : []
    if (wanted.length === 0) return
    void api.invoke('catalog:favicons', [...new Set(wanted)]).then((fetched) => {
      setByDomain((prev) => {
        const next = { ...prev }
        for (const d of wanted) next[d] = fetched[d] ?? ''
        return next
      })
    })
  }, [domainKey])

  const out: Record<string, string> = {}
  for (const hint of hints) {
    const shipped = builtIn(hint)
    if (shipped) {
      out[hint.key] = shipped
      continue
    }
    const pinned = officialIconUrl(hint.catalogueKey ?? hint.key) ?? hint.iconUrl
    if (pinned && byUrl[pinned]) {
      out[hint.key] = byUrl[pinned]!
      continue
    }
    const domain = officialIconDomain(hint.catalogueKey ?? hint.key) ?? domainFromEndpoint(hint.endpoint)
    if (domain && byDomain[domain]) out[hint.key] = byDomain[domain]!
  }
  return out
}

/**
 * The icon itself, or a deterministic monogram. `max-width` rather than a fixed
 * size, so a 16px source draws at 16px instead of being upscaled into a blur.
 */
export function VendorIcon({
  name,
  identity,
  src,
  size = 46
}: {
  /** Used for the monogram letter. */
  name: string
  /** Stable string that decides the monogram colour. */
  identity: string
  src?: string
  size?: number
}): JSX.Element {
  const letter = name.replace(/[^A-Za-z0-9]/g, '').charAt(0).toUpperCase() || '?'
  let hash = 0
  for (const ch of identity) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0

  return (
    <span className="conn-icon" aria-hidden="true" style={{ width: size, height: size }}>
      {src ? (
        <img src={src} alt="" style={{ maxWidth: size * 0.65, maxHeight: size * 0.65 }} />
      ) : (
        <span
          className="mono-letter"
          style={{ fontSize: size * 0.42, color: `hsl(${hash % 360} 52% 42%)` }}
        >
          {letter}
        </span>
      )}
    </span>
  )
}
