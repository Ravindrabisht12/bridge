/**
 * The unified catalogue model.
 *
 * Three layers, deliberately separate, because they have different owners and
 * different trust:
 *
 *   1. `registry`  — mirrored from registry.modelcontextprotocol.io. Read-only.
 *                    Whatever the registry says, verbatim. Overwritten on sync.
 *   2. `overlay`   — the operator's own annotations on a registry entry: tier,
 *                    featured rank, tags, notes. Survives every sync because it
 *                    is stored beside the entry, never inside it.
 *   3. `custom`    — entries the registry has never heard of: a command on this
 *                    machine, a self-hosted URL, a git repo. First-class
 *                    citizens of the catalogue, not a second list.
 *
 * Keeping (1) and (2) apart is the whole point. A sync must be free to replace
 * a registry row wholesale without destroying the operator's curation, and the
 * UI must be able to say *who* asserted a fact — the registry, or you.
 */
import type { RegistryPackage, RegistryRemote } from './registry'

/** Where a catalogue entry came from. */
export type EntrySource = 'registry' | 'custom-local' | 'custom-remote' | 'custom-git'

export const SOURCE_LABEL: Record<EntrySource, string> = {
  registry: 'MCP Registry',
  'custom-local': 'Local command',
  'custom-remote': 'Self-hosted',
  'custom-git': 'Git repository'
}

/**
 * Commercial tier. The registry publishes nothing of the sort, so this is
 * always an assertion by whoever curated the entry — never inferred. `unknown`
 * is the honest default and stays that way until someone sets it.
 */
export type Tier = 'unknown' | 'free' | 'paid' | 'enterprise'

export const TIER_LABEL: Record<Tier, string> = {
  unknown: 'Not stated',
  free: 'Free',
  paid: 'Paid',
  enterprise: 'Enterprise'
}

/** Who asserted a curated field, so the UI never presents opinion as fact. */
export type Provenance = 'registry' | 'operator' | 'derived'

export interface Overlay {
  /** Registry name, or the custom entry's id. */
  key: string
  tier: Tier
  /** Lower sorts first on the front page. Null means not featured. */
  featuredRank: number | null
  tags: string[]
  notes: string | null
  /** Operator's own 0–5 rating. Null when unrated. */
  rating: number | null
  hidden: boolean
  /**
   * What a connection test observed: 'required' after a 401/403, 'open' after a
   * successful handshake. Beats the publisher's declaration, which is empty for
   * every OAuth-protected server.
   */
  authObserved: 'required' | 'open' | null
  updatedAt: number
}

export const emptyOverlay = (key: string): Overlay => ({
  key,
  tier: 'unknown',
  featuredRank: null,
  tags: [],
  notes: null,
  rating: null,
  hidden: false,
  authObserved: null,
  updatedAt: 0
})

/** A custom entry: something the operator added themselves. */
export interface CustomEntry {
  id: string
  source: Exclude<EntrySource, 'registry'>
  title: string
  description: string
  /** For custom-local: the command. For remote: the URL. For git: the repo. */
  command: string | null
  args: string[]
  env: Record<string, string>
  url: string | null
  gitRef: string | null
  /** Directory the command runs in, for local entries. */
  cwd: string | null
  createdAt: number
  updatedAt: number
}

/**
 * What the Library actually renders: a registry entry or a custom one, with the
 * operator's overlay applied and the source recorded.
 */
export interface CatalogueItem {
  /** Registry name for registry entries, custom id otherwise. Unique. */
  key: string
  source: EntrySource
  title: string
  description: string
  /** Publisher namespace for registry entries; null for custom. */
  namespace: string | null
  version: string
  repositoryUrl: string | null
  websiteUrl: string | null
  iconUrl: string | null
  status: string
  publishedAt: number | null
  updatedAt: number | null
  packages: RegistryPackage[]
  remotes: RegistryRemote[]
  /** Real weekly downloads from npm/PyPI. Null when unknown. */
  downloads: number | null
  downloadsSource: string | null
  categories: string[]
  overlay: Overlay
  /** Populated for custom entries so the UI can edit them in place. */
  custom: CustomEntry | null
}

export interface CatalogueQuery {
  search?: string
  category?: string
  /** Where it runs. */
  hosting?: 'local' | 'hosted'
  requirement?: 'standalone' | 'needs-credentials'
  tier?: Tier
  source?: EntrySource
  tag?: string
  featuredOnly?: boolean
  /** Only entries that have been installed from the Library. */
  installedOnly?: boolean
  sort?: 'featured' | 'downloads' | 'rating' | 'newest' | 'updated' | 'name' | 'relevance'
  limit?: number
  offset?: number
  includeHidden?: boolean
}

/**
 * The front page ordering: curated picks first in the operator's chosen order,
 * then everything else by real usage. Deliberately not a single blended
 * "score" — a curated pick and a download count are different kinds of claim
 * and collapsing them into one number hides which is which.
 */
export function frontPageComparator(a: CatalogueItem, b: CatalogueItem): number {
  const ra = a.overlay.featuredRank
  const rb = b.overlay.featuredRank
  if (ra !== null && rb !== null) return ra - rb
  if (ra !== null) return -1
  if (rb !== null) return 1
  return (b.downloads ?? -1) - (a.downloads ?? -1)
}

/** Which fields on an item are the operator's opinion rather than the registry's. */
export function provenanceOf(field: keyof Overlay): Provenance {
  return field === 'key' || field === 'updatedAt' ? 'registry' : 'operator'
}

export const DEFAULT_TAGS = [
  'work',
  'personal',
  'trusted',
  'experimental',
  'needs-review',
  'internal'
] as const
