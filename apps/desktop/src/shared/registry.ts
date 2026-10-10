/**
 * Bridge's local catalogue row, and the mapping from a registry entry into it.
 *
 * The registry's own response types and the pure transforms over them moved to
 * `@bridge/registry`, because the weekly catalogue worker needs exactly the
 * same parsing and a second copy would drift. They are re-exported here so
 * every existing `@shared/registry` import keeps working unchanged — the seam
 * is which *shape* a thing belongs to: `CatalogEntry` below is this app's
 * SQLite row and has no business in a shared package, while `categorize` and
 * `displayTitle` are opinions about the registry and belong to both sides.
 */
export {
  REGISTRY_BASE,
  CATEGORIES,
  categorize,
  pickIcon,
  displayTitle,
  kindOf,
  officialMeta,
  crawl,
  PAGE_SIZE,
  MAX_PAGES,
  REQUEST_TIMEOUT_MS,
  RegistryTruncatedError
} from '@bridge/registry'
export type {
  PackageRegistryType,
  RemoteTransportType,
  RegistryEnvVar,
  RegistryArgument,
  RegistryPackage,
  RegistryRemote,
  RegistryIcon,
  RegistryServer,
  RegistryOfficialMeta,
  RegistryEntry,
  RegistryListResponse,
  ServerKind,
  RegistryPage,
  CrawlOptions
} from '@bridge/registry'

import { categorize, displayTitle, kindOf, officialMeta, pickIcon } from '@bridge/registry'
import type { RegistryEntry, RegistryPackage, RegistryRemote } from '@bridge/registry'

/* -------------------------- local catalogue shape ------------------------- */

/** A registry entry after it has been flattened into Bridge's database. */
export interface CatalogEntry {
  /** Registry name, e.g. `io.github.delorenj/mcp-server-trello`. */
  name: string
  title: string
  description: string
  version: string
  /** Namespace root, e.g. `io.github.delorenj`. */
  namespace: string
  repositoryUrl: string | null
  websiteUrl: string | null
  status: string
  publishedAt: number | null
  updatedAt: number | null
  /** 'stdio' when it ships a package, 'remote' when it is hosted, 'both'. */
  kind: 'stdio' | 'remote' | 'both' | 'none'
  packages: RegistryPackage[]
  remotes: RegistryRemote[]
  /** Publisher-supplied icon URL, if any. Fetched and cached by the main process. */
  iconUrl: string | null
  /** Weekly downloads from npm/PyPI when the package registry exposes them. */
  downloads: number | null
  downloadsSource: string | null
  /** Derived, not from the registry — see `categorize`. */
  categories: string[]
  syncedAt: number
}

const toMs = (iso?: string): number | null => {
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? null : ms
}


/** Registry data is public input: keep a link only if it is an ordinary web address. */
function webUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const { protocol } = new URL(value)
    return protocol === 'https:' || protocol === 'http:' ? value : null
  } catch {
    return null
  }
}

export function toCatalogEntry(entry: RegistryEntry, syncedAt = Date.now()): CatalogEntry {
  const s = entry.server
  const meta = officialMeta(entry)
  const description = s.description ?? ''
  return {
    name: s.name,
    title: displayTitle(s.name, s.title),
    description,
    version: s.version ?? '',
    namespace: s.name.includes('/') ? s.name.split('/')[0]! : s.name,
    repositoryUrl: webUrl(s.repository?.url),
    websiteUrl: webUrl(s.websiteUrl),
    status: meta.status ?? 'unknown',
    publishedAt: toMs(meta.publishedAt),
    updatedAt: toMs(meta.updatedAt),
    kind: kindOf(s),
    packages: s.packages ?? [],
    remotes: s.remotes ?? [],
    iconUrl: pickIcon(s.icons),
    downloads: null,
    downloadsSource: null,
    categories: categorize(s.name, description),
    syncedAt
  }
}
