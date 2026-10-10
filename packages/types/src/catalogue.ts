/**
 * The catalogue contract.
 *
 * One definition, imported by all three sides: the worker writes it, the API
 * serves it, the desktop app merges it. If this file and the OpenAPI document
 * disagree, `apps/api` has a test that fails — see `openapi.contract.test.ts`.
 *
 * Naming follows the wire, not the database: these are the shapes that cross
 * the network, so they use the JSON casing the API emits rather than the
 * snake_case of the Postgres columns behind it.
 */

/** How a server is packaged for local execution. */
export interface CataloguePackage {
  registryType: string
  registryBaseUrl?: string
  identifier: string
  version?: string
  runtimeHint?: string
  transport?: { type?: string }
  environmentVariables?: CatalogueVariable[]
  runtimeArguments?: CatalogueArgument[]
  packageArguments?: CatalogueArgument[]
}

/** A remote endpoint, for servers that are hosted rather than run locally. */
export interface CatalogueRemote {
  type: string
  url: string
  headers?: CatalogueVariable[]
}

export interface CatalogueVariable {
  name: string
  description?: string
  isRequired?: boolean
  isSecret?: boolean
  format?: string
  default?: string
}

export interface CatalogueArgument {
  type?: 'positional' | 'named'
  name?: string
  value?: string
  valueHint?: string
  description?: string
  isRequired?: boolean
  isRepeated?: boolean
}

/**
 * How we know an entry is published by the vendor it claims.
 *
 * `mcp-oauth` and `mcp-open` both mean a probe reached the endpoint on the
 * vendor's own domain — an OAuth wall counts as proof the endpoint is real.
 * `unverified` is the honest default and must never be rendered as a seal.
 */
export type Evidence = 'mcp-oauth' | 'mcp-open' | 'manual' | 'unverified'

/** What a probe saw. `auth-required` is a success: the endpoint exists. */
export type ProbeOutcome = 'ok' | 'auth-required' | 'refused' | 'timeout' | 'error'

export type PricingTier = 'free' | 'freemium' | 'paid' | 'unknown'

/** A catalogue entry as the API serves it. */
export interface CatalogueEntry {
  /** Reverse-DNS registry name, or a `bridge:` id for entries we added. */
  key: string
  namespace: string | null
  title: string
  description: string
  version: string | null
  repositoryUrl: string | null
  websiteUrl: string | null
  status: string
  packages: CataloguePackage[]
  remotes: CatalogueRemote[]

  /* ---- the editorial layer: this is what the raw registry does not have --- */

  /** True only when a probe confirmed the endpoint on `vendorDomain`. */
  isFirstParty: boolean
  /** The domain that makes it first-party. Null when unverified. */
  vendorDomain: string | null
  /** Resolved once server-side; a URL on our own CDN, never a vendor's host. */
  iconUrl: string | null
  category: string | null
  pricingTier: PricingTier
  evidence: Evidence
  /** Lower sorts first. Null means unfeatured. */
  featuredRank: number | null

  /* ---------------------------- signals ----------------------------------- */

  /** Weekly downloads from npm or PyPI. Null when the package has neither. */
  downloads: number | null
  downloadsSource: 'npm' | 'pypi' | null

  /* ---------------------------- timestamps -------------------------------- */

  publishedAt: string | null
  /** ISO 8601. Also the delta cursor's ordering key. */
  updatedAt: string
  /** When a probe last confirmed this. Null when never probed. */
  verifiedAt: string | null
}

/* ============================== requests ================================= */

export interface SearchQuery {
  q: string
  /** Restrict to the curated, vendor-verified set. */
  firstPartyOnly?: boolean
  category?: string
  limit?: number
  cursor?: string
}

export interface Page<T> {
  items: T[]
  /** Opaque. Pass back verbatim; never parse it client-side. */
  nextCursor: string | null
  /** Total matches, when the backend can count cheaply. */
  total: number | null
}

/**
 * The delta response.
 *
 * `removed` is an explicit list, never an absence. An entry missing from a page
 * must not mean "delete it" — that is how a truncated response empties a user's
 * catalogue.
 */
export interface CatalogueDelta {
  cursor: string
  hasMore: boolean
  changed: CatalogueEntry[]
  removed: string[]
}

/** Metadata for the bulk snapshot, which is a static file on the CDN. */
export interface SnapshotMeta {
  /** Content-addressed, so a client can tell whether it already has this one. */
  digest: string
  url: string
  bytes: number
  entryCount: number
  /** The cursor a client should use for its first delta after this snapshot. */
  cursor: string
  generatedAt: string
}

export interface AppRelease {
  version: string
  notesUrl: string | null
  notes: string | null
  publishedAt: string
  /** Below this, the client should refuse to run rather than misbehave. */
  minimumSupported: string
  downloads: Array<{ platform: 'mac-arm64' | 'mac-x64' | 'win-x64' | 'linux-x64'; url: string; bytes: number; sha512: string }>
}

/** Every error the API returns has this shape. No bare strings. */
export interface ApiError {
  error: {
    code: 'bad_request' | 'not_found' | 'rate_limited' | 'internal'
    message: string
    /** Present on 429, seconds. */
    retryAfter?: number
  }
}
