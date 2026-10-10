/**
 * "Is this the vendor's own server?" — derived, not asserted.
 *
 * The registry verifies namespace ownership by DNS, so `com.atlassian` proves
 * control of atlassian.com. If such an entry also serves from a host under that
 * same domain, the vendor is publishing their own endpoint under their own
 * verified name. That is about as strong as first-party gets without a trust
 * root, and crucially it is *checkable* rather than curated.
 *
 * It says nothing about how well known a vendor is. `app.seatcanvas` serving
 * seatcanvas.app is every bit as first-party as Atlassian serving
 * mcp.atlassian.com — it is just smaller. Fame is a separate, curated axis
 * (see `seed.ts`); conflating the two would smuggle an editorial judgement in
 * under a factual-sounding label.
 */

/** Code-host namespaces describe an author, not a vendor domain. */
const CODE_HOSTS = [/^io\.github\./i, /^io\.gitlab\./i, /^com\.github\./i]

/**
 * A reverse-DNS namespace read back as a domain: `com.atlassian` ->
 * `atlassian.com`, `com.figma.mcp` -> `mcp.figma.com`.
 */
export function namespaceToDomain(namespace: string): string | null {
  if (!namespace || !namespace.includes('.')) return null
  if (CODE_HOSTS.some((re) => re.test(namespace))) return null
  const labels = namespace.split('.').filter(Boolean)
  if (labels.length < 2) return null
  return labels.reverse().join('.').toLowerCase()
}

export function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase().replace(/:\d+$/, '')
  } catch {
    return null
  }
}

/**
 * True when two hostnames belong to the same domain in either direction. The
 * namespace may be more specific than the endpoint (`com.figma.mcp` ->
 * `mcp.figma.com` against `figma.com`) or less (`com.atlassian` ->
 * `atlassian.com` against `mcp.atlassian.com`).
 */
export function sameDomain(a: string, b: string): boolean {
  if (a === b) return true
  return a.endsWith(`.${b}`) || b.endsWith(`.${a}`)
}

export interface FirstPartyVerdict {
  firstParty: boolean
  /** The domain the namespace proves, when it proves one. */
  domain: string | null
  /** The endpoint host that matched, for display. */
  matchedHost: string | null
}

/**
 * Checkable only for hosted servers: a package on npm carries no domain to
 * compare against, so a locally-run server returns `firstParty: false` rather
 * than a guess based on a package scope.
 */
export function assessFirstParty(namespace: string | null, remoteUrls: readonly string[]): FirstPartyVerdict {
  const domain = namespace ? namespaceToDomain(namespace) : null
  if (!domain) return { firstParty: false, domain: null, matchedHost: null }

  for (const url of remoteUrls) {
    const host = hostOf(url)
    if (host && sameDomain(host, domain)) {
      return { firstParty: true, domain, matchedHost: host }
    }
  }
  return { firstParty: false, domain, matchedHost: null }
}
