import { useCallback, useEffect, useMemo, useState } from 'react'
import { CATEGORIES } from '@shared/registry'
import {
  DEFAULT_TAGS,
  SOURCE_LABEL,
  TIER_LABEL,
  type CatalogueItem,
  type EntrySource,
  type Tier
} from '@shared/catalogue'
import { commandLine, type InstallPlan } from '@shared/install'
import type { ProbeResult } from '@shared/probe'
import type { SyncProgress } from '@shared/syncprogress'
import { assessTrust } from '@shared/trust'
import { HOSTING_LABEL, facetsOf, requirementDetail } from '@shared/facets'
import { assessFirstParty } from '@shared/firstparty'
import {
  OFFICIAL_TAG,
  officialCategory,
  officialIconData,
  officialIconDomain,
  officialIconUrl,
  officialRequiresAuth,
  officialVendor
} from '@shared/official'
import type { ClientStatusDto } from '@shared/ipc'
import type { ManagedServer } from '@shared/types'
import { api } from '../lib/api'
import { compactNumber, dateOf } from '../lib/format'
import {
  IconAlert,
  IconCheck,
  IconClose,
  IconCopy,
  IconExternal,
  IconInfo,
  IconPlus,
  IconSearch,
  IconServer,
  IconVerified
} from '../components/Icons'

const PAGE_SIZE = 50

type Sort = 'featured' | 'downloads' | 'rating' | 'newest' | 'updated' | 'name'

const SORTS: Array<{ id: Sort; label: string }> = [
  { id: 'featured', label: 'Top picks' },
  { id: 'downloads', label: 'Most used' },
  { id: 'rating', label: 'My rating' },
  { id: 'newest', label: 'Newest' },
  { id: 'updated', label: 'Recently updated' },
  { id: 'name', label: 'A–Z' }
]

const TIERS: Tier[] = ['free', 'paid', 'enterprise', 'unknown']
const SOURCES: EntrySource[] = ['registry', 'custom-local', 'custom-remote', 'custom-git']

const TIER_CLASS: Record<Tier, string> = {
  free: 'ok',
  paid: 'info',
  enterprise: 'accent',
  unknown: ''
}

interface Props {
  servers: ManagedServer[]
  /** Catalogue key from the URL, so a refresh keeps the open entry. */
  selectedKey: string | null
  onSelect: (key: string | null) => void
  onInstalled: () => void
}

export function LibraryPage({ servers, selectedKey, onSelect, onInstalled }: Props): JSX.Element {
  const [items, setItems] = useState<CatalogueItem[]>([])
  const [total, setTotal] = useState(0)
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('')
  const [hosting, setHosting] = useState<'' | 'local' | 'hosted'>('')
  const [requirement, setRequirement] = useState<'' | 'standalone' | 'needs-credentials'>('')
  const [tier, setTier] = useState<'' | Tier>('')
  const [source, setSource] = useState<'' | EntrySource>('')
  const [tag, setTag] = useState('')
  // Default to the curated first-party directory: 27,000 unvetted servers is
  // not a useful place to start, and the whole point of the directory is that
  // someone checked these.
  const [scope, setScope] = useState<'official' | 'installed' | 'all'>('official')
  const [page, setPage] = useState(0)
  const [favicons, setFavicons] = useState<Record<string, string>>({})
  const [sort, setSort] = useState<Sort>('featured')
  const [tags, setTags] = useState<string[]>([])
  const [icons, setIcons] = useState<Record<string, string>>({})
  const [facets, setFacets] = useState<{ total: number; custom: number; featured: number } | null>(null)
  const [progress, setProgress] = useState<SyncProgress | null>(null)
  const [remoteSearch, setRemoteSearch] = useState<{ busy: boolean; note: string | null }>({ busy: false, note: null })
  const [selected, setSelected] = useState<CatalogueItem | null>(null)
  const [editing, setEditing] = useState<'new' | CatalogueItem | null>(null)
  const [filtersOpen, setFiltersOpen] = useState(false)

  const load = useCallback(async () => {
    const [res, f, t] = await Promise.all([
      api.invoke('catalogue:query', {
        search: search.trim() || undefined,
        category: category || undefined,
        hosting: hosting || undefined,
        requirement: requirement || undefined,
        tier: tier || undefined,
        source: source || undefined,
        tag: scope === 'official' ? OFFICIAL_TAG : tag || undefined,
        installedOnly: scope === 'installed' || undefined,
        sort: search.trim() ? 'relevance' : sort,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE
      }),
      api.invoke('catalogue:facets'),
      api.invoke('catalogue:tags')
    ])
    setItems(res.items)
    setTotal(res.total)
    setFacets(f)
    setTags(t)
  }, [search, category, hosting, requirement, tier, source, tag, sort, scope, page])

  useEffect(() => {
    const t = setTimeout(() => void load(), 180)
    return () => clearTimeout(t)
  }, [load])

  // The URL is the source of truth for what is open, so a refresh restores it
  // even when the entry is not on the current page of results.
  useEffect(() => {
    if (!selectedKey) {
      setSelected(null)
      return
    }
    if (selected?.key === selectedKey) return
    const onPage = items.find((i) => i.key === selectedKey)
    if (onPage) {
      setSelected(onPage)
      return
    }
    void api.invoke('catalogue:get', selectedKey).then((found) => {
      if (found) setSelected(found)
      else onSelect(null)
    })
  }, [selectedKey, items, selected, onSelect])

  // Changing a filter while on page 7 would otherwise show an empty page.
  useEffect(() => {
    setPage(0)
    setRemoteSearch({ busy: false, note: null })
  }, [search, category, hosting, requirement, tier, source, tag, sort, scope])

  // Icons come from the main process as data URIs, so browsing never beacons
  // the viewer's IP to a publisher's domain.
  useEffect(() => {
    const urls = items
      .filter((i) => !officialIconData(i.key))
      .map((i) => officialIconUrl(i.key) ?? i.iconUrl)
      .filter((u): u is string => !!u && !icons[u])
    if (urls.length === 0) return
    void api.invoke('catalog:icons', urls).then((fetched) => {
      if (Object.keys(fetched).length > 0) setIcons((prev) => ({ ...prev, ...fetched }))
    })
  }, [items, icons])

  /**
   * Most first-party entries publish no icon, which left the very servers that
   * should look most trustworthy showing a blank monogram. Fall back to the
   * vendor's own favicon, fetched by the main process like every other icon.
   */
  useEffect(() => {
    const domains = items
      .filter((i) => !i.iconUrl && !officialIconUrl(i.key) && !officialIconData(i.key))
      .map((i) => {
        const override = officialIconDomain(i.key)
        if (override) return override
        const url = i.remotes[0]?.url
        if (!url) return null
        try {
          return new URL(url).host.replace(/^mcp\./, '').replace(/^api\./, '')
        } catch {
          return null
        }
      })
      .filter((d): d is string => !!d && favicons[d] === undefined)
    if (domains.length === 0) return
    void api.invoke('catalog:favicons', [...new Set(domains)]).then((fetched) => {
      // Record misses too, so a domain without a favicon is not retried forever.
      setFavicons((prev) => {
        const next = { ...prev }
        for (const d of domains) next[d] = fetched[d] ?? ''
        return next
      })
    })
  }, [items, favicons])

  useEffect(() => {
    return window.bridge.onSync((p) => {
      const sp = p as SyncProgress
      setProgress(sp)
      if (sp.phase === 'done' || sp.phase === 'error') {
        void load()
        setTimeout(() => setProgress(null), 4000)
      }
    })
  }, [load])

  /**
   * Where a given entry's icon comes from. Bundled official entries name their
   * own icon domain, because several vendors serve MCP from a domain that does
   * not host the brand's favicon (Google from googleapis.com, GitHub from
   * githubcopilot.com).
   */
  /** Facets for a catalogue item, including auth we know from the directory. */
  const facetsFor = (it: CatalogueItem): ReturnType<typeof facetsOf> =>
    facetsOf({ packages: it.packages, remotes: it.remotes, requiresAuth: officialRequiresAuth(it.key) })

  const iconDomainFor = (it: CatalogueItem): string | null => {
    const override = officialIconDomain(it.key)
    if (override) return override
    const url = it.remotes[0]?.url
    if (!url) return null
    try {
      return new URL(url).host.replace(/^mcp\./, '').replace(/^api\./, '')
    } catch {
      return null
    }
  }

  const iconFor = (it: CatalogueItem): string | undefined => {
    // Ships with the app, so the curated set has icons with no service
    // configured and no request made.
    const shipped = officialIconData(it.key)
    if (shipped) return shipped
    const pinned = officialIconUrl(it.key)
    if (pinned && icons[pinned]) return icons[pinned]
    if (it.iconUrl && icons[it.iconUrl]) return icons[it.iconUrl]
    const domain = iconDomainFor(it)
    return domain ? favicons[domain] || undefined : undefined
  }

  // Keyed by catalogue origin, not by name: a server renamed on install would
  // otherwise stop reporting as installed.
  const installedKeys = useMemo(
    () => new Set(servers.map((s) => s.catalogueKey).filter((k): k is string => !!k)),
    [servers]
  )
  // Category and search stay on the bar; everything else is folded away, so
  // the button has to say how much is hidden behind it.
  const extraFilters = [hosting, requirement, tier, source, tag].filter(Boolean).length

  const clearFilters = (): void => {
    setHosting('')
    setRequirement('')
    setTier('')
    setSource('')
    setTag('')
  }

  const empty = facets?.total === 0

  /**
   * Pulls just the entries matching the current term. Remote search costs about
   * 15 seconds, which is fine as a deliberate action and unusable per keystroke
   * — which is why it is a button rather than automatic.
   */
  const lookUpRemotely = async (): Promise<void> => {
    const term = search.trim()
    if (!term) return
    setRemoteSearch({ busy: true, note: null })
    const res = await api.invoke('catalogue:search', term)
    await load()
    setRemoteSearch({
      busy: false,
      note: res.error
        ? `The registry did not answer: ${res.error}`
        : res.found === 0
          ? 'The registry has nothing under that name either.'
          : `Found ${res.found} and added them to your catalogue.`
    })
  }

  const refresh = (): void => {
    void load()
    onInstalled()
  }

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Library</h1>
          <div className="sub">
            {facets
              ? `${facets.total.toLocaleString()} servers · ${facets.custom} yours · ${facets.featured} featured`
              : 'your catalogue of MCP servers'}
          </div>
        </div>
        <span className="spacer" />
        <div className="search">
          <IconSearch size={13} />
          <input
            className="input"
            placeholder="Search the catalogue…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="segmented">
          <button aria-pressed={scope === 'official'} onClick={() => setScope('official')}>
            Official
          </button>
          <button aria-pressed={scope === 'installed'} onClick={() => setScope('installed')}>
            Installed
          </button>
          <button aria-pressed={scope === 'all'} onClick={() => setScope('all')}>
            Everything
          </button>
        </div>
        <button className="btn primary" onClick={() => setEditing('new')}>
          Add your own
        </button>
        <button className="btn" disabled={!!progress} onClick={() => void api.invoke('catalog:sync', false)}>
          {progress ? 'Syncing…' : 'Sync'}
        </button>
      </div>

      <div className="split">
        <div className="pane">
          <div className="pad stack">
            {progress && (
              <div className="banner">
                <IconInfo />
                <div>
                  {progress.phase === 'servers' && `Fetching servers… ${progress.fetched} so far.`}
                  {progress.phase === 'downloads' &&
                    `Fetching usage data… ${progress.fetched}${progress.total ? ` of ${progress.total}` : ''}.`}
                  {progress.phase === 'done' && `Sync finished — ${progress.fetched} entries updated.`}
                  {progress.phase === 'error' && `Sync failed: ${progress.message}`}
                </div>
              </div>
            )}

            {empty && !progress && (
              <div className="card">
                <div className="empty">
                  <div className="glyph">
                    <IconServer />
                  </div>
                  <h3>Catalogue is empty</h3>
                  <p>
                    The curated directory of first-party servers is built in and needs no download. The full public
                    registry is about 27,500 entries and a few minutes, so Bridge only fetches it when you ask.
                  </p>
                  <div className="row" style={{ justifyContent: 'center' }}>
                    <button className="btn primary" onClick={() => void api.invoke('catalog:sync', true)}>
                      Download the registry
                    </button>
                    <button className="btn" onClick={() => setEditing('new')}>
                      Add one manually
                    </button>
                  </div>
                </div>
              </div>
            )}

            {!empty && (
              <>
                <div className="row wrap" style={{ gap: 8 }}>
                  <select className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
                    <option value="">All categories</option>
                    {CATEGORIES.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                    <option value="other">Uncategorised</option>
                  </select>

                  <div className="filter-wrap">
                    <button
                      className={`btn filter-btn ${filtersOpen || extraFilters > 0 ? 'active' : ''}`}
                      aria-expanded={filtersOpen}
                      onClick={() => setFiltersOpen((v) => !v)}
                    >
                      Filters
                      {extraFilters > 0 && <span className="badge">{extraFilters}</span>}
                    </button>

                    {filtersOpen && (
                      <>
                        <div className="filter-scrim" onClick={() => setFiltersOpen(false)} />
                        <div className="filter-pop">
                          <div className="field">
                            <label htmlFor="f-host">Runs</label>
                            <div className="segmented" id="f-host">
                              <button aria-pressed={hosting === ''} onClick={() => setHosting('')}>
                                Anywhere
                              </button>
                              <button aria-pressed={hosting === 'local'} onClick={() => setHosting('local')}>
                                My machine
                              </button>
                              <button aria-pressed={hosting === 'hosted'} onClick={() => setHosting('hosted')}>
                                Hosted
                              </button>
                            </div>
                          </div>

                          <div className="field">
                            <label htmlFor="f-setup">Setup</label>
                            <div className="segmented" id="f-setup">
                              <button aria-pressed={requirement === ''} onClick={() => setRequirement('')}>
                                Any
                              </button>
                              <button
                                aria-pressed={requirement === 'standalone'}
                                onClick={() => setRequirement('standalone')}
                              >
                                No sign-up
                              </button>
                              <button
                                aria-pressed={requirement === 'needs-credentials'}
                                onClick={() => setRequirement('needs-credentials')}
                              >
                                Account
                              </button>
                            </div>
                          </div>

                          <div className="field">
                            <label htmlFor="f-price">Pricing</label>
                            <select
                              id="f-price"
                              className="select"
                              value={tier}
                              onChange={(e) => setTier(e.target.value as Tier | '')}
                            >
                              <option value="">Any pricing</option>
                              {TIERS.map((t) => (
                                <option key={t} value={t}>
                                  {TIER_LABEL[t]}
                                </option>
                              ))}
                            </select>
                          </div>

                          <div className="field">
                            <label htmlFor="f-source">Source</label>
                            <select
                              id="f-source"
                              className="select"
                              value={source}
                              onChange={(e) => setSource(e.target.value as EntrySource | '')}
                            >
                              <option value="">Any source</option>
                              {SOURCES.map((sc) => (
                                <option key={sc} value={sc}>
                                  {SOURCE_LABEL[sc]}
                                </option>
                              ))}
                            </select>
                          </div>

                          {tags.length > 0 && (
                            <div className="field">
                              <label htmlFor="f-tag">Tag</label>
                              <select
                                id="f-tag"
                                className="select"
                                value={tag}
                                onChange={(e) => setTag(e.target.value)}
                              >
                                <option value="">Any tag</option>
                                {tags.map((t) => (
                                  <option key={t} value={t}>
                                    {t}
                                  </option>
                                ))}
                              </select>
                            </div>
                          )}

                          <div className="pop-foot">
                            <button className="btn sm" disabled={extraFilters === 0} onClick={clearFilters}>
                              Clear
                            </button>
                            <span className="spacer" />
                            <span className="faint">{total.toLocaleString()} matches</span>
                          </div>
                        </div>
                      </>
                    )}
                  </div>

                  <span className="spacer" />
                  <span className="faint">{total.toLocaleString()} matches</span>
                  <select
                    className="select"
                    value={sort}
                    onChange={(e) => setSort(e.target.value as Sort)}
                    disabled={!!search.trim()}
                  >
                    {SORTS.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="faint">
                  {scope === 'installed' ? (
                    <>
                      Servers you have installed from the Library. Open one to change which apps it is wired
                      into, or to remove it.
                    </>
                  ) : scope === 'official' ? (
                    <>
                      Showing servers published by the vendor themselves, each confirmed by probing the
                      vendor&apos;s own domain — no community rebuilds. Switch to <b>Everything</b> for the full
                      registry, or add your own.
                    </>
                  ) : (
                    <>
                      The whole registry, most of it unvetted. Pricing and ratings are <b>yours</b> — the registry
                      publishes neither. &ldquo;Most used&rdquo; is real weekly download data from npm and PyPI.
                    </>
                  )}
                </div>

                <div className="conn-grid">
                  {items.map((it) => {
                    const installed = installedKeys.has(it.key)
                    const official =
                      it.overlay.tags.includes(OFFICIAL_TAG) ||
                      assessFirstParty(it.namespace, it.remotes.map((r) => r.url)).firstParty
                    const f = facetsFor(it)
                    return (
                      <div
                        key={it.key}
                        className="conn-card"
                        aria-selected={selected?.key === it.key}
                        onClick={() => onSelect(it.key)}
                      >
                        <ConnIcon item={it} src={iconFor(it)} />
                        <div className="conn-body">
                          <div className="conn-name">
                            <span className="label">{it.title}</span>
                            {official && (
                              <span className="verified" title="Published by the vendor, on their own verified domain">
                                <IconVerified />
                              </span>
                            )}
                          </div>
                          <div className="conn-desc">{it.description || 'No description provided.'}</div>
                          <div className="conn-meta">
                            {it.overlay.tier !== 'unknown' && (
                              <span className={`tag ${TIER_CLASS[it.overlay.tier]}`}>{TIER_LABEL[it.overlay.tier]}</span>
                            )}
                            {f.hosting === 'hosted' && <span className="tag">hosted</span>}
                            {f.hosting === 'local' && <span className="tag">runs locally</span>}
                            {f.requirement === 'standalone' && <span className="tag ok">no sign-up</span>}
                            {it.downloads !== null && (
                              <span className="faint">{compactNumber(it.downloads)}/wk</span>
                            )}
                          </div>
                        </div>
                        <button
                          className={`conn-action ${installed ? 'installed' : ''}`}
                          title={installed ? 'Already installed' : 'Set up this connector'}
                          aria-label={installed ? `${it.title} is installed` : `Add ${it.title}`}
                          onClick={(e) => {
                            e.stopPropagation()
                            onSelect(it.key)
                          }}
                        >
                          {installed ? <IconCheck size={15} /> : <IconPlus size={15} />}
                        </button>
                      </div>
                    )
                  })}
                </div>

                {total > PAGE_SIZE && (
                  <div className="card">
                    <div className="pager">
                      <button className="btn sm" disabled={page === 0} onClick={() => setPage(page - 1)}>
                        Previous
                      </button>
                      <span className="page-num">
                        {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total.toLocaleString()}
                      </span>
                      <button
                        className="btn sm"
                        disabled={(page + 1) * PAGE_SIZE >= total}
                        onClick={() => setPage(page + 1)}
                      >
                        Next
                      </button>
                      <span className="spacer" />
                      <span className="faint">
                        page {page + 1} of {Math.ceil(total / PAGE_SIZE).toLocaleString()}
                      </span>
                    </div>
                  </div>
                )}

                {items.length === 0 && (
                  <div className="card">
                    <div className="empty">
                      <h3>Nothing matches</h3>
                      {search.trim() ? (
                        <>
                          <p>
                            Nothing in your catalogue matches &ldquo;{search.trim()}&rdquo;. The public registry
                            holds about 27,500 servers; Bridge can look this one term up rather than downloading
                            all of them.
                          </p>
                          <button
                            className="btn primary"
                            disabled={remoteSearch.busy}
                            onClick={() => void lookUpRemotely()}
                          >
                            {remoteSearch.busy ? 'Searching the registry…' : 'Search the registry'}
                          </button>
                          {remoteSearch.note && (
                            <p className="hint" style={{ marginTop: 10 }}>
                              {remoteSearch.note}
                            </p>
                          )}
                        </>
                      ) : (
                        <p>Try a different term or clear a filter.</p>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

      </div>

      {selected && (
        <div
          className="scrim"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) onSelect(null)
          }}
        >
          <DetailPanel
            item={selected}
            iconSrc={iconFor(selected)}
            installedKeys={installedKeys}
            servers={servers}
            onClose={() => onSelect(null)}
            onChanged={(next) => {
              setSelected(next)
              void load()
            }}
            onEdit={() => setEditing(selected)}
            onInstalled={() => {
              onSelect(null)
              refresh()
            }}
          />
        </div>
      )}

      {editing && (
        <CustomEntryModal
          entry={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            void load()
          }}
        />
      )}
    </>
  )
}

/**
 * A publisher icon, or a coloured monogram. Most entries have no icon, so the
 * fallback is the common case and has to look deliberate rather than broken.
 */
function ConnIcon({ item, src }: { item: CatalogueItem; src?: string }): JSX.Element {
  const letter = (item.title || item.key).replace(/[^A-Za-z0-9]/g, '').charAt(0).toUpperCase() || '?'
  // Stable hue per entry, so the same server always looks the same.
  let hash = 0
  for (const ch of item.key) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0

  return (
    <span className="conn-icon" aria-hidden="true">
      {src ? (
        <img src={src} alt="" />
      ) : (
        <span
          className="mono-letter"
          style={{ color: `hsl(${hash % 360} 52% 42%)` }}
        >
          {letter}
        </span>
      )}
    </span>
  )
}

/* ------------------------------ detail panel ------------------------------ */

function DetailPanel({
  item,
  iconSrc,
  installedKeys,
  servers,
  onClose,
  onChanged,
  onEdit,
  onInstalled
}: {
  item: CatalogueItem
  iconSrc?: string
  installedKeys: Set<string>
  servers: ManagedServer[]
  onClose: () => void
  onChanged: (next: CatalogueItem) => void
  onEdit: () => void
  onInstalled: () => void
}): JSX.Element {
  const [plan, setPlan] = useState<InstallPlan | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)
  const [prefer, setPrefer] = useState<'local' | 'remote'>(
    item.packages.length === 0 && item.remotes.length > 0 ? 'remote' : 'local'
  )
  const [values, setValues] = useState<Record<string, string>>({})
  const [name, setName] = useState('')
  const [clients, setClients] = useState<ClientStatusDto[]>([])
  const [manual, setManual] = useState<Array<{ id: string; label: string; reason: string }>>([])
  const [targets, setTargets] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [links, setLinks] = useState<Array<{ serverId: string; client: string; installed: boolean }>>([])
  const [probe, setProbe] = useState<ProbeResult | null>(null)
  const [authHeader, setAuthHeader] = useState('Authorization')
  const [authValue, setAuthValue] = useState('')
  const [probing, setProbing] = useState(false)

  const facets = facetsOf({
    packages: item.packages,
    remotes: item.remotes,
    requiresAuth: officialRequiresAuth(item.key)
  })
  const trust = item.source === 'registry' ? assessTrust(item as never) : null
  const both = item.packages.length > 0 && item.remotes.length > 0
  const official =
    item.overlay.tags.includes(OFFICIAL_TAG) ||
    assessFirstParty(item.namespace, item.remotes.map((r) => r.url)).firstParty
  const installedServer = servers.find((sv) => sv.catalogueKey === item.key) ?? null
  const isInstalled = installedKeys.has(item.key)
  /** What a test actually saw, this session or a previous one. */
  const observedAuth: 'required' | 'open' | null = probe
    ? probe.ok
      ? 'open'
      : /\b(401|403)\b/.test(probe.error ?? '')
        ? 'required'
        : item.overlay.authObserved
    : item.overlay.authObserved

  /** Publisher domain: the namespace for a registry entry, the host otherwise. */
  const madeBy = (() => {
    const curated = officialVendor(item.key)
    if (curated) return curated
    if (item.namespace) return item.namespace.split('.').reverse().join('.')
    const url = item.remotes[0]?.url
    if (!url) return null
    try {
      return new URL(url).host
    } catch {
      return null
    }
  })()

  // Tools recorded from a previous session, or returned by a fresh probe.
  const [storedTools, setStoredTools] = useState<string[]>([])
  const knownTools = probe?.toolNames.length ? probe.toolNames : storedTools
  const toolsAreComplete = !!probe?.toolNames.length

  const reloadLinks = useCallback(async () => {
    setLinks(await api.invoke('servers:clients'))
  }, [])

  useEffect(() => {
    void (async () => {
      const [c, m] = await Promise.all([api.invoke('clients:status'), api.invoke('clients:manual')])
      setClients(c)
      setManual(m)
      setTargets(c.filter((x) => x.present).map((x) => x.id))
      await reloadLinks()
    })()
  }, [reloadLinks])

  /** Wires this server into one client, or removes it from that client. */
  const toggleClient = async (client: string, on: boolean): Promise<void> => {
    if (!installedServer) return
    setBusy(true)
    setError(null)
    try {
      setLinks(
        await api.invoke('servers:setClient', {
          serverId: installedServer.id,
          client: client as ManagedServer['client'],
          installed: on
        })
      )
      onInstalled()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  /** Stores a token on an installed server and rewrites every client config. */
  const saveToken = async (): Promise<void> => {
    if (!installedServer || installedServer.target.kind !== 'http' || !authValue.trim()) return
    setBusy(true)
    setError(null)
    try {
      await api.invoke('server:update', {
        serverId: installedServer.id,
        target: {
          ...installedServer.target,
          headers: {
            ...installedServer.target.headers,
            [authHeader.trim() || 'Authorization']: authValue.trim()
          }
        }
      })
      setAuthValue('')
      onInstalled()
      setProbe(await api.invoke('server:probe', { serverId: installedServer.id }))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const removeCompletely = async (): Promise<void> => {
    if (!installedServer) return
    setBusy(true)
    try {
      await api.invoke('servers:remove', installedServer.id)
      onInstalled()
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const wiredInto = new Set(
    links.filter((l) => installedServer && l.serverId === installedServer.id && l.installed).map((l) => l.client)
  )

  // A server installed earlier already has its tool list on disk.
  useEffect(() => {
    setStoredTools([])
    if (!installedServer) return
    void api.invoke('servers:tools', installedServer.id).then((all) => {
      if (all.length > 0) setStoredTools(all.map((t) => t.name).slice(0, 60))
    })
  }, [installedServer])

  useEffect(() => {
    setPlanError(null)
    setProbe(null)
    void api.invoke('catalogue:plan', { key: item.key, prefer }).then((r) => {
      if (r.ok) {
        setPlan(r.plan)
        setName(r.plan.suggestedName)
        setValues({})
      } else {
        setPlan(null)
        setPlanError(r.error.reason)
      }
    })
  }, [item.key, prefer])

  const saveOverlay = async (patch: Partial<CatalogueItem['overlay']>): Promise<void> => {
    const overlay = await api.invoke('overlay:save', { key: item.key, ...patch })
    onChanged({ ...item, overlay })
  }

  const runProbe = async (): Promise<void> => {
    setProbing(true)
    setProbe(null)
    try {
      setProbe(
        await api.invoke('server:probe', {
          key: item.key,
          ...(authValue.trim() ? { headers: { [authHeader.trim() || 'Authorization']: authValue.trim() } } : {})
        })
      )
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setProbing(false)
    }
  }

  const missing = (plan?.required ?? []).filter((i) => !values[i.name]?.trim())

  // Escape closes it, which a side panel could get away with not handling but a
  // modal cannot: it is the only thing on screen the user can interact with.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const install = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const res = await api.invoke('catalogue:install', {
        key: item.key,
        serverName: name,
        prefer,
        // A typed header is just another required value keyed by header name.
        values: authValue.trim()
          ? { ...values, [authHeader.trim() || 'Authorization']: authValue.trim() }
          : values,
        headerNames: authValue.trim() ? [authHeader.trim() || 'Authorization'] : [],
        clients: targets as ManagedServer['client'][]
      })
      if (res.failed.length > 0) setError(res.failed.map((f) => `${f.client}: ${f.reason}`).join('; '))
      else onInstalled()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal conn-modal" role="dialog" aria-modal="true" aria-label={item.title}>
      <div className="detail-hero">
        <ConnIcon item={item} src={iconSrc} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2>
            <span className="truncate">{item.title}</span>
            {official && (
              <span className="verified" title="Published by the vendor, on their own verified domain">
                <IconVerified size={17} />
              </span>
            )}
          </h2>
          <div className="tagline">{item.description || 'No description provided.'}</div>
        </div>
        <div className="row" style={{ gap: 6 }}>
          {isInstalled ? (
            <span className="tag ok" style={{ padding: '5px 10px' }}>
              <IconCheck size={12} /> Connected
            </span>
          ) : null}
          <button
            className="btn ghost icon"
            title="Copy the connector URL"
            aria-label="Copy the connector URL"
            onClick={() => {
              const url = item.remotes[0]?.url
              if (url) void navigator.clipboard?.writeText(url)
            }}
          >
            <IconCopy />
          </button>
          <button className="btn ghost icon" onClick={onClose} aria-label="Close">
            <IconClose />
          </button>
        </div>
      </div>

      <div className="modal-body">
        {isInstalled ? (
          <>
            <div className="section">Where it is installed</div>
            <div className="col" style={{ gap: 2 }}>
              {clients.map((c) => (
                <label key={c.id} className="check install-row">
                  <input
                    type="checkbox"
                    disabled={busy || !c.present}
                    checked={wiredInto.has(c.id)}
                    onChange={(e) => void toggleClient(c.id, e.target.checked)}
                  />
                  <span className="grow">{c.label}</span>
                  {wiredInto.has(c.id) ? (
                    <span className="tag ok">connected</span>
                  ) : c.present ? (
                    <span className="faint">not connected</span>
                  ) : (
                    <span className="faint">not installed here</span>
                  )}
                </label>
              ))}
            </div>
            <div className="faint" style={{ marginTop: 8 }}>
              Ticking or unticking rewrites that app&apos;s config. Restart the app afterwards — they read it only
              at startup.
            </div>
            {installedServer?.target.kind === 'http' && (
              <>
                <div className="section">
                  Access token
                  {observedAuth === 'required' && <span className="tag warn" style={{ marginLeft: 8 }}>needed</span>}
                </div>
                <div className="faint" style={{ marginBottom: 8 }}>
                  {observedAuth === 'required'
                    ? 'This server refused an unauthenticated request. Paste a token, or sign in from your AI client if it uses a browser flow.'
                    : 'Only needed if the server asks for one.'}
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <input
                    className="input"
                    style={{ width: 130 }}
                    value={authHeader}
                    onChange={(e) => setAuthHeader(e.target.value)}
                    aria-label="Header name"
                  />
                  <input
                    className="input"
                    style={{ flex: 1 }}
                    type="password"
                    placeholder={
                      installedServer.target.headers?.[authHeader] ? '•••••••• (saved)' : 'Bearer …'
                    }
                    value={authValue}
                    onChange={(e) => setAuthValue(e.target.value)}
                    aria-label="Header value"
                  />
                  <button
                    className="btn"
                    disabled={busy || !authValue.trim()}
                    onClick={() => void saveToken()}
                  >
                    Save
                  </button>
                </div>
              </>
            )}

            <div className="row" style={{ marginTop: 14 }}>
              <button className="btn danger" disabled={busy} onClick={() => void removeCompletely()}>
                Remove completely
              </button>
              <button className="btn" disabled={probing} onClick={() => void runProbe()}>
                {probing ? 'Testing…' : 'Test connection'}
              </button>
            </div>
            {probe && <ProbeNote probe={probe} />}
          </>
        ) : planError ? (
          <>
            <div className="banner danger">
              <IconAlert />
              <div>{planError}</div>
            </div>
          </>
        ) : (
          plan && (
            <>
              {both && (
                <>
                  <div className="section">Run it</div>
                  <div className="segmented">
                    <button aria-pressed={prefer === 'local'} onClick={() => setPrefer('local')}>
                      On my machine
                    </button>
                    <button aria-pressed={prefer === 'remote'} onClick={() => setPrefer('remote')}>
                      Publisher-hosted
                    </button>
                  </div>
                </>
              )}

              <div className="section">What runs</div>
              <pre className="call-code" aria-label="Command that will run">{commandLine(plan.target)}</pre>

              <div className="section">Install into</div>
              <div className="col" style={{ gap: 2 }}>
                {clients.map((c) => (
                  <label key={c.id} className="check install-row">
                    <input
                      type="checkbox"
                      disabled={!c.present}
                      checked={targets.includes(c.id)}
                      onChange={(e) =>
                        setTargets(e.target.checked ? [...targets, c.id] : targets.filter((x) => x !== c.id))
                      }
                    />
                    <span className="grow">{c.label}</span>
                    {!c.present && <span className="faint">not installed here</span>}
                  </label>
                ))}
              </div>
              <div className="row" style={{ gap: 8, marginTop: 6 }}>
                <button
                  className="btn sm"
                  onClick={() => setTargets(clients.filter((c) => c.present).map((c) => c.id))}
                >
                  Select all
                </button>
                <button className="btn sm" onClick={() => setTargets([])}>
                  Clear
                </button>
              </div>
              {manual.map((m) => (
                <div key={m.id} className="faint" style={{ marginTop: 6 }}>
                  {m.label} — {m.reason}
                </div>
              ))}

              {(plan.required.length > 0 || plan.target.kind === 'http') && (
                <>
                  <div className="section">
                    {plan.required.length > 0 ? 'Credentials it needs' : 'Access token'}
                    {plan.required.length === 0 && <span className="faint"> (optional)</span>}
                  </div>
                  {plan.required.map((input) => (
                    <div key={input.name} style={{ marginBottom: 10 }}>
                      <label className="faint" htmlFor={`v-${input.name}`}>
                        {input.name}
                        {input.isSecret ? ' (secret)' : ''}
                      </label>
                      <input
                        id={`v-${input.name}`}
                        className="input"
                        style={{ width: '100%' }}
                        type={input.isSecret ? 'password' : 'text'}
                        placeholder={input.description || input.name}
                        value={values[input.name] ?? ''}
                        onChange={(e) => setValues({ ...values, [input.name]: e.target.value })}
                      />
                    </div>
                  ))}
                  {plan.target.kind === 'http' && plan.required.length === 0 && (
                    <>
                      <div className="row" style={{ gap: 6 }}>
                        <input
                          className="input"
                          style={{ width: 130 }}
                          value={authHeader}
                          onChange={(e) => setAuthHeader(e.target.value)}
                          aria-label="Header name"
                        />
                        <input
                          className="input"
                          style={{ flex: 1 }}
                          type="password"
                          placeholder="Bearer …"
                          value={authValue}
                          onChange={(e) => setAuthValue(e.target.value)}
                          aria-label="Header value"
                        />
                      </div>
                      <div className="faint" style={{ marginTop: 6 }}>
                        Only if the server wants one. Leave blank when it signs you in through the browser.
                      </div>
                    </>
                  )}
                </>
              )}

              <div className="section">Name it</div>
              <input
                className="input"
                style={{ width: '100%' }}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <div className="faint" style={{ marginTop: 4 }}>
                The key written into each app&apos;s config.
              </div>

              {error && (
                <div className="banner danger" style={{ marginTop: 12 }}>
                  <IconAlert />
                  <div>{error}</div>
                </div>
              )}

              <div className="row" style={{ marginTop: 16 }}>
                <button
                  className="btn primary"
                  disabled={busy || targets.length === 0 || missing.length > 0 || !name.trim()}
                  onClick={() => void install()}
                >
                  <IconPlus size={13} />
                  {busy ? 'Installing…' : `Install into ${targets.length || 'no'} app${targets.length === 1 ? '' : 's'}`}
                </button>
                <button className="btn" disabled={probing || missing.length > 0} onClick={() => void runProbe()}>
                  {probing ? 'Testing…' : 'Test first'}
                </button>
              </div>
              {missing.length > 0 && (
                <div className="faint" style={{ marginTop: 6 }}>
                  Still needs {missing.map((m) => m.name).join(', ')}.
                </div>
              )}
              {probe && <ProbeNote probe={probe} />}
            </>
          )
        )}

        <div className="detail-divider" />

        {knownTools.length > 0 && (
          <>
            <div className="section">
              Tools <span className="faint">({knownTools.length})</span>
            </div>
            <div className="tool-pills">
              {knownTools.map((t) => (
                <span key={t} className="tool-pill">
                  {t}
                </span>
              ))}
            </div>
            {!toolsAreComplete && (
              <div className="faint" style={{ marginTop: 6 }}>
                From the last handshake — run the test below for the current list.
              </div>
            )}
          </>
        )}

        <div className="section">Details</div>
        <div className="meta-grid">
          <div className="meta-item">
            <div className="meta-label">Categories</div>
            <div className="meta-value row wrap" style={{ gap: 5 }}>
              {(officialCategory(item.key) ? [officialCategory(item.key)!] : item.categories).map((c) => (
                <span key={c} className="tag">
                  {CATEGORIES.find((x) => x.id === c)?.label ?? c}
                </span>
              ))}
            </div>
          </div>

          <div className="meta-item">
            <div className="meta-label">Connector URL</div>
            <div className="meta-value mono">
              {item.remotes[0]?.url ?? <span className="faint">Runs locally — no URL</span>}
            </div>
          </div>

          <div className="meta-item">
            <div className="meta-label">Made by</div>
            <div className="meta-value">
              {madeBy ? (
                <a className="meta-link" href={`https://${madeBy}`}>
                  {madeBy}
                  <IconExternal size={11} />
                </a>
              ) : (
                <span className="faint">Unstated</span>
              )}
            </div>
          </div>

          <div className="meta-item">
            <div className="meta-label">Sign-in</div>
            <div className="meta-value">
              {observedAuth === 'required'
                ? 'Required — the server refused an unauthenticated request'
                : facets.requirement === 'needs-credentials'
                  ? 'Required'
                  : observedAuth === 'open'
                    ? 'Not required — it answered without credentials'
                    : 'Not stated by the publisher'}
            </div>
          </div>

          <div className="meta-item">
            <div className="meta-label">Runs on</div>
            <div className="meta-value">{HOSTING_LABEL[facets.hosting]}</div>
          </div>

          <div className="meta-item">
            <div className="meta-label">{item.publishedAt ? 'Added' : 'Updated'}</div>
            <div className="meta-value">
              {item.publishedAt ? dateOf(item.publishedAt) : item.updatedAt ? dateOf(item.updatedAt) : '—'}
            </div>
          </div>

          {item.downloads !== null && (
            <div className="meta-item">
              <div className="meta-label">Usage</div>
              <div className="meta-value">
                {item.downloads.toLocaleString()}/week on {item.downloadsSource}
              </div>
            </div>
          )}

          <div className="meta-item">
            <div className="meta-label">Source</div>
            <div className="meta-value">
              {official && item.source !== 'registry' ? 'Official directory' : SOURCE_LABEL[item.source]}
            </div>
          </div>
        </div>

        {(item.repositoryUrl || item.websiteUrl) && (
          <>
            <div className="section">More info</div>
            <div className="col" style={{ gap: 4 }}>
              {item.websiteUrl && (
                <a className="meta-link" href={item.websiteUrl}>
                  Documentation <IconExternal size={11} />
                </a>
              )}
              {item.repositoryUrl && (
                <a className="meta-link" href={item.repositoryUrl}>
                  Source code <IconExternal size={11} />
                </a>
              )}
            </div>
          </>
        )}

        <div className="faint" style={{ marginTop: 12 }}>
          {observedAuth === 'required' && facets.credentials.length === 0
            ? 'The publisher declares no credential fields, but the server refused an unauthenticated request — supply a token below, or connect it in your AI client so it can run the browser sign-in.'
            : requirementDetail(facets)}
        </div>

        {facets.sendsDataOffMachine && (
          <div className="banner warn" style={{ marginTop: 10 }}>
            <IconAlert />
            <div>
              This runs on someone else&apos;s infrastructure, so anything a tool is given travels there. Bridge
              records every call but cannot keep the data local.
            </div>
          </div>
        )}

        {trust && (
          <>
            <div className="section">What is verifiable</div>
            {trust.signals.map((s) => (
              <div key={s.id} className="row" style={{ gap: 7, padding: '3px 0', fontSize: 12.5 }}>
                <span
                  className={`tag ${s.tone === 'positive' ? 'ok' : s.tone === 'negative' ? 'danger' : ''}`}
                  style={{ minWidth: 50, justifyContent: 'center' }}
                >
                  {s.tone === 'positive' ? 'yes' : s.tone === 'negative' ? 'no' : 'note'}
                </span>
                <span className="dim">{s.label}</span>
              </div>
            ))}
          </>
        )}


        {item.custom && (
          <>
            <div className="section">This entry</div>
            <button className="btn" onClick={onEdit}>
              Edit command and settings
            </button>
          </>
        )}

        <div className="section">Your notes</div>
        <div className="form">
          <label htmlFor="ov-tier">Pricing</label>
          <select
            id="ov-tier"
            className="select"
            value={item.overlay.tier}
            onChange={(e) => void saveOverlay({ tier: e.target.value as Tier })}
          >
            {(['unknown', 'free', 'paid', 'enterprise'] as Tier[]).map((t) => (
              <option key={t} value={t}>
                {TIER_LABEL[t]}
              </option>
            ))}
          </select>

          <label htmlFor="ov-rating">Rating</label>
          <select
            id="ov-rating"
            className="select"
            value={item.overlay.rating ?? ''}
            onChange={(e) => void saveOverlay({ rating: e.target.value === '' ? null : Number(e.target.value) })}
          >
            <option value="">Unrated</option>
            {[5, 4, 3, 2, 1].map((n) => (
              <option key={n} value={n}>
                {'\u2605'.repeat(n)}
              </option>
            ))}
          </select>

          <label htmlFor="ov-notes">Note</label>
          <input
            id="ov-notes"
            className="input"
            defaultValue={item.overlay.notes ?? ''}
            placeholder="why you picked it, who owns it…"
            onBlur={(e) => void saveOverlay({ notes: e.target.value || null })}
          />
        </div>
        <div className="row wrap" style={{ gap: 6, marginTop: 10 }}>
          {DEFAULT_TAGS.map((t) => {
            const on = item.overlay.tags.includes(t)
            return (
              <button
                key={t}
                className={`tag ${on ? 'accent' : ''}`}
                style={{ border: 0, cursor: 'pointer' }}
                onClick={() =>
                  void saveOverlay({
                    tags: on ? item.overlay.tags.filter((x) => x !== t) : [...item.overlay.tags, t]
                  })
                }
              >
                {on ? '\u2713 ' : ''}
                {t}
              </button>
            )
          })}
        </div>
        <div className="faint" style={{ marginTop: 8 }}>
          Yours alone. Survives every registry sync and is never sent anywhere.
        </div>

      </div>
    </div>
  )
}

/** The outcome of a connection test, in one consistent block. */
function ProbeNote({ probe }: { probe: ProbeResult }): JSX.Element {
  return (
    <div className={`banner ${probe.ok ? '' : 'danger'}`} style={{ marginTop: 10 }}>
      {probe.ok ? <IconInfo /> : <IconAlert />}
      <div>
        {probe.ok ? (
          <>
            <b>It works.</b> {probe.serverName ?? 'The server'} {probe.serverVersion ?? ''} answered in{' '}
            {probe.durationMs}ms with <b>{probe.toolCount}</b> tools.
          </>
        ) : (
          <>
            <b>It did not start.</b> {probe.error}
            {probe.stderr && (
              <pre className="code" style={{ marginTop: 8, maxHeight: 140 }}>
                {probe.stderr}
              </pre>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/* --------------------------- custom entry editor -------------------------- */

function CustomEntryModal({
  entry,
  onClose,
  onSaved
}: {
  entry: CatalogueItem | null
  onClose: () => void
  onSaved: () => void
}): JSX.Element {
  const existing = entry?.custom ?? null
  const [source, setSource] = useState<Exclude<EntrySource, 'registry'>>(existing?.source ?? 'custom-local')
  const [title, setTitle] = useState(existing?.title ?? '')
  const [description, setDescription] = useState(existing?.description ?? '')
  const [command, setCommand] = useState(existing?.command ?? '')
  const [argsText, setArgsText] = useState((existing?.args ?? []).join(' '))
  const [envText, setEnvText] = useState(
    Object.entries(existing?.env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join('\n')
  )
  const [url, setUrl] = useState(existing?.url ?? '')
  const [cwd, setCwd] = useState(existing?.cwd ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const save = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const env: Record<string, string> = {}
      for (const line of envText.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const eq = trimmed.indexOf('=')
        if (eq <= 0) throw new Error(`"${trimmed}" is not in KEY=value form.`)
        env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
      }
      await api.invoke('custom:save', {
        id: existing?.id ?? '',
        source,
        title,
        description,
        command: source === 'custom-remote' ? null : command || null,
        args: argsText.trim() ? argsText.trim().split(/\s+/) : [],
        env,
        url: source === 'custom-local' ? null : url || null,
        gitRef: null,
        cwd: cwd || null
      })
      onSaved()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!existing) return
    await api.invoke('custom:delete', existing.id)
    onSaved()
  }

  return (
    <div className="scrim" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="modal-head">
          <h2>{existing ? 'Edit your server' : 'Add your own server'}</h2>
          <div className="sub">
            Stored in your catalogue alongside the registry, and installable into any client the same way.
          </div>
        </div>

        <div className="modal-body">
          <div className="section">What kind</div>
          <div className="segmented">
            <button aria-pressed={source === 'custom-local'} onClick={() => setSource('custom-local')}>
              Local command
            </button>
            <button aria-pressed={source === 'custom-remote'} onClick={() => setSource('custom-remote')}>
              Self-hosted URL
            </button>
            <button aria-pressed={source === 'custom-git'} onClick={() => setSource('custom-git')}>
              Git repo
            </button>
          </div>

          <div className="form" style={{ marginTop: 14 }}>
            <label htmlFor="ce-title">Name</label>
            <input id="ce-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} />

            <label htmlFor="ce-desc">Description</label>
            <input
              id="ce-desc"
              className="input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />

            {source === 'custom-remote' ? (
              <>
                <label htmlFor="ce-url">Endpoint URL</label>
                <input
                  id="ce-url"
                  className="input"
                  placeholder="https://mcp.internal.example.com/mcp"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                />
              </>
            ) : (
              <>
                {source === 'custom-git' && (
                  <>
                    <label htmlFor="ce-repo">Repository</label>
                    <input
                      id="ce-repo"
                      className="input"
                      placeholder="https://github.com/you/your-mcp"
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                    />
                    <div className="hint">
                      Bridge records the repository but does not clone or build it. Check it out yourself, then give
                      the command that runs it.
                    </div>
                  </>
                )}
                <label htmlFor="ce-cmd">Command</label>
                <input
                  id="ce-cmd"
                  className="input"
                  placeholder="node"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                />

                <label htmlFor="ce-args">Arguments</label>
                <input
                  id="ce-args"
                  className="input"
                  placeholder="dist/index.js --port 0"
                  value={argsText}
                  onChange={(e) => setArgsText(e.target.value)}
                />

                <label htmlFor="ce-cwd">Working directory</label>
                <input
                  id="ce-cwd"
                  className="input"
                  placeholder="optional"
                  value={cwd}
                  onChange={(e) => setCwd(e.target.value)}
                />
              </>
            )}

            <label htmlFor="ce-env">Environment</label>
            <textarea
              id="ce-env"
              className="input"
              rows={4}
              placeholder={'API_KEY=…\nBASE_URL=…'}
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              style={{ fontFamily: 'var(--mono)', fontSize: 12 }}
            />
            <div className="hint">One KEY=value per line. These are written into each client&apos;s config file.</div>
          </div>

          {error && (
            <div className="banner danger" style={{ marginTop: 12 }}>
              <IconAlert />
              <div>{error}</div>
            </div>
          )}
        </div>

        <div className="modal-foot">
          {existing && (
            <button className="btn danger" onClick={() => void remove()}>
              Delete
            </button>
          )}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !title.trim()} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save to catalogue'}
          </button>
        </div>
      </div>
    </div>
  )
}
