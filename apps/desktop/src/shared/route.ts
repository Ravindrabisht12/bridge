/**
 * Route parsing, kept free of the DOM so it can be tested directly.
 *
 * Hash routing rather than the History API: a packaged renderer loads from
 * `file://`, where pushing `/servers` yields a URL that cannot be reloaded —
 * which is the exact problem routing is here to solve.
 */

export const TABS = ['home', 'overview', 'security', 'trace', 'tools', 'servers', 'library', 'policy', 'settings'] as const
export type Tab = (typeof TABS)[number]

export const DEFAULT_TAB: Tab = 'home'

export interface Route {
  tab: Tab
  /** Second path segment: the selected catalogue key or server id. */
  param: string | null
}

const isTab = (value: string): value is Tab => (TABS as readonly string[]).includes(value)

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#\/?/, '')
  if (!path) return { tab: DEFAULT_TAB, param: null }

  const [head, ...rest] = path.split('/')
  const tab = head && isTab(head) ? head : DEFAULT_TAB
  // Catalogue keys contain slashes (`io.github.owner/name`), so rejoin.
  const raw = rest.join('/')
  return { tab, param: raw ? safeDecode(raw) : null }
}

export function toHash(route: Route): string {
  return route.param ? `#/${route.tab}/${encodeURIComponent(route.param)}` : `#/${route.tab}`
}
