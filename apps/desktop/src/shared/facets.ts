/**
 * Facets the Library filters on.
 *
 * A note on "paid vs free": the registry has no pricing, licence or tier field
 * — I checked the 2025-12-11 schema for `price`, `pricing`, `paid`, `free`,
 * `tier`, `cost`, `licence` and `subscription`, and none exist. Any Paid/Free
 * badge would therefore be a guess presented as a fact, which is exactly the
 * kind of thing this app exists to argue against.
 *
 * What *is* derivable, and is usually what the question really means, is
 * whether a server can run on its own or needs an account somewhere first.
 * That comes from the required credentials the publisher declares.
 */
import type { RegistryEnvVar, RegistryPackage, RegistryRemote } from './registry'

export type Hosting = 'local' | 'hosted' | 'either'
export type Requirement = 'standalone' | 'needs-credentials'

export interface Facets {
  hosting: Hosting
  requirement: Requirement
  /** Names of the credentials the publisher says are required. */
  credentials: string[]
  /** True when the server runs on the publisher's machines, not yours. */
  sendsDataOffMachine: boolean
}

const required = (list: RegistryEnvVar[] | undefined): string[] =>
  (list ?? []).filter((v) => v.isRequired).map((v) => v.name)

/**
 * Anything with packages and remotes, which is all this needs.
 *
 * It used to take a `CatalogEntry` and read its `kind` field. Unified catalogue
 * items have no `kind`, and the call site cast the difference away — so every
 * hosted server silently reported "runs locally". Deriving from the two arrays
 * that actually exist removes the possibility.
 */
export interface HasTransports {
  packages: RegistryPackage[]
  remotes: RegistryRemote[]
  /** Set when the entry is a curated endpoint whose auth requirement is known. */
  requiresAuth?: boolean
}

export function hostingOf(entry: HasTransports): Hosting {
  const hasPkg = entry.packages.length > 0
  const hasRemote = entry.remotes.length > 0
  if (hasPkg && hasRemote) return 'either'
  if (hasRemote) return 'hosted'
  return 'local'
}

export function facetsOf(entry: HasTransports): Facets {
  const credentials = new Set<string>()

  for (const pkg of entry.packages) {
    for (const name of required(pkg.environmentVariables)) credentials.add(name)
  }
  for (const remote of entry.remotes) {
    for (const name of required(remote.headers)) credentials.add(name)
  }

  const hosting = hostingOf(entry)
  // A curated endpoint that answered with an OAuth challenge needs sign-in even
  // though it declares no credential fields — the flow is interactive, so there
  // is nothing for a publisher to list.
  const needsAuth = credentials.size > 0 || entry.requiresAuth === true

  return {
    hosting,
    requirement: needsAuth ? 'needs-credentials' : 'standalone',
    credentials: [...credentials],
    sendsDataOffMachine: hosting === 'hosted'
  }
}

export const HOSTING_LABEL: Record<Hosting, string> = {
  local: 'Runs on your machine',
  hosted: 'Runs on the publisher’s servers',
  either: 'Local or hosted'
}

export const REQUIREMENT_LABEL: Record<Requirement, string> = {
  standalone: 'No sign-up needed',
  'needs-credentials': 'Needs an account'
}

/**
 * Wording for the account requirement. Deliberately says nothing about cost:
 * the registry does not know, and neither do we.
 */
export function requirementDetail(facets: Facets): string {
  if (facets.requirement === 'standalone') {
    return 'Declares no required credentials, so it should run as soon as it is installed.'
  }
  if (facets.credentials.length === 0) {
    return 'Sign-in happens in the browser the first time it runs; there is no key to paste here.'
  }
  const list = facets.credentials.slice(0, 3).join(', ')
  const more = facets.credentials.length > 3 ? ` and ${facets.credentials.length - 3} more` : ''
  return `Needs ${list}${more}, so you will need an account with the underlying service. The registry does not record whether that account costs anything.`
}
