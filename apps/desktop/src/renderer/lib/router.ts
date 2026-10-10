/**
 * The DOM half of routing: listen for `hashchange`, and expose navigation.
 * Parsing lives in `@shared/route` so it can be tested without a window.
 */
import { useCallback, useEffect, useState } from 'react'
import { DEFAULT_TAB, parseHash, toHash, type Route, type Tab } from '@shared/route'

export { DEFAULT_TAB, TABS, parseHash, toHash } from '@shared/route'
export type { Route, Tab } from '@shared/route'

export function useRoute(): {
  route: Route
  navigate: (tab: Tab, param?: string | null) => void
  setParam: (param: string | null) => void
} {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash))

  useEffect(() => {
    const onChange = (): void => setRoute(parseHash(window.location.hash))
    window.addEventListener('hashchange', onChange)
    // Normalise an absent hash so the URL always names the current page.
    if (!window.location.hash) window.location.replace(toHash({ tab: DEFAULT_TAB, param: null }))
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  const navigate = useCallback((tab: Tab, param: string | null = null) => {
    const next = toHash({ tab, param })
    if (window.location.hash !== next) window.location.hash = next
  }, [])

  /**
   * Changes only the selection, with `replaceState` so opening and closing a
   * detail pane does not fill the back stack with near-identical entries.
   */
  const setParam = useCallback((param: string | null) => {
    const current = parseHash(window.location.hash)
    const next = toHash({ tab: current.tab, param })
    if (window.location.hash === next) return
    window.history.replaceState(null, '', next)
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  }, [])

  return { route, navigate, setParam }
}
