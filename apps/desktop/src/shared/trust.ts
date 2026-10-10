/**
 * Trust assessment for a catalogue entry.
 *
 * Every signal here is one the registry or a package host actually publishes.
 * There is deliberately no invented score: the registry carries no ratings, no
 * stars and no reviews, and a number that looks authoritative but is made up is
 * worse than no number at all — it launders a guess into a recommendation.
 *
 * What a badge says is "here is what is verifiable about who published this",
 * never "this server is safe to run". Running any MCP server is running that
 * author's code against your data.
 */
import type { CatalogEntry } from './registry'
import { assessFirstParty } from './firstparty'

export type TrustLevel = 'verified' | 'community' | 'unverified' | 'flagged'

export interface TrustSignal {
  id: string
  label: string
  /** positive = reassuring, negative = a reason for caution, neutral = context. */
  tone: 'positive' | 'neutral' | 'negative'
}

export interface TrustAssessment {
  level: TrustLevel
  /** Short label for a badge. */
  label: string
  signals: TrustSignal[]
  /** True when the entry needs an explicit warning before install. */
  warn: boolean
}

const DAY = 86_400_000

/**
 * The registry verifies namespace ownership: `io.github.<user>` is proven by
 * GitHub authentication, and a reverse-DNS namespace by a DNS record. That is a
 * statement about *who* published, which is the strongest thing available.
 */
export function namespaceVerification(namespace: string): { verified: boolean; how: string | null } {
  if (/^io\.github\.[^.]+$/i.test(namespace)) return { verified: true, how: 'GitHub account' }
  if (/^io\.gitlab\.[^.]+$/i.test(namespace)) return { verified: true, how: 'GitLab account' }
  // Anything else namespaced as reverse DNS is domain-verified by the registry.
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(namespace)) return { verified: true, how: 'DNS domain' }
  return { verified: false, how: null }
}

export function assessTrust(entry: CatalogEntry, now = Date.now()): TrustAssessment {
  const signals: TrustSignal[] = []
  const ns = namespaceVerification(entry.namespace)

  if (ns.verified) {
    signals.push({
      id: 'namespace',
      label: `Publisher verified via ${ns.how} (${entry.namespace})`,
      tone: 'positive'
    })
  } else {
    signals.push({ id: 'namespace', label: 'Publisher namespace not verifiable', tone: 'negative' })
  }

  if (entry.status === 'deprecated') {
    signals.push({ id: 'status', label: 'Marked deprecated by its publisher', tone: 'negative' })
  } else if (entry.status === 'deleted') {
    signals.push({ id: 'status', label: 'Withdrawn from the registry', tone: 'negative' })
  } else if (entry.status === 'active') {
    signals.push({ id: 'status', label: 'Active in the registry', tone: 'positive' })
  }

  const fp = assessFirstParty(entry.namespace, entry.remotes.map((r) => r.url))
  if (fp.firstParty) {
    signals.push({
      id: 'first-party',
      label: `Served from the publisher's own domain (${fp.matchedHost})`,
      tone: 'positive'
    })
  }

  if (entry.repositoryUrl) {
    signals.push({ id: 'source', label: 'Source code published', tone: 'positive' })
  } else {
    signals.push({ id: 'source', label: 'No source repository listed', tone: 'negative' })
  }

  if (entry.downloads !== null) {
    const where = entry.downloadsSource ?? 'package registry'
    signals.push({
      id: 'downloads',
      label: `${entry.downloads.toLocaleString()} downloads last week on ${where}`,
      tone: entry.downloads >= 1000 ? 'positive' : 'neutral'
    })
  }

  if (entry.updatedAt !== null) {
    const ageDays = Math.floor((now - entry.updatedAt) / DAY)
    if (ageDays > 365) {
      signals.push({ id: 'freshness', label: `Not updated for ${Math.floor(ageDays / 30)} months`, tone: 'negative' })
    } else {
      signals.push({
        id: 'freshness',
        label: ageDays <= 1 ? 'Updated today' : `Updated ${ageDays} days ago`,
        tone: 'neutral'
      })
    }
  }

  if (entry.publishedAt !== null && now - entry.publishedAt < 14 * DAY) {
    signals.push({ id: 'new', label: 'Published in the last two weeks', tone: 'neutral' })
  }

  // Level is a summary of the signals above, in strict precedence order.
  let level: TrustLevel
  if (entry.status === 'deprecated' || entry.status === 'deleted') {
    level = 'flagged'
  } else if (!ns.verified) {
    level = 'unverified'
  } else if (fp.firstParty) {
    // The vendor proved the domain and serves from it: nothing stronger is
    // available, and a hosted server has no repository or download count.
    level = 'verified'
  } else if (entry.repositoryUrl && (entry.downloads === null || entry.downloads >= 1000)) {
    level = 'verified'
  } else {
    level = 'community'
  }

  const LABELS: Record<TrustLevel, string> = {
    verified: 'Verified publisher',
    community: 'Community',
    unverified: 'Unverified',
    flagged: 'Not recommended'
  }

  return {
    level,
    label: LABELS[level],
    signals,
    warn: level === 'unverified' || level === 'flagged'
  }
}

/** Ranking for the "most used" sort. Entries with no data sort last. */
export function popularityRank(entry: CatalogEntry): number {
  return entry.downloads ?? -1
}
