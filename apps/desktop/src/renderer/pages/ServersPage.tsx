import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ClientStatusDto, ConfigHealth, DiscoveredServerDto } from '@shared/ipc'
import type { CatalogueItem } from '@shared/catalogue'
import type { ManagedServer, SessionRecord, ToolRecord } from '@shared/types'
import { summarizeInventory } from '@shared/toolrisk'
import { clientsNeedingRestart } from '@shared/staleconfig'
import { api } from '../lib/api'
import { compactNumber, dateOf } from '../lib/format'
import { VendorIcon, useVendorIcons, type IconHint } from '../components/VendorIcon'
import { IconAlert, IconChevron, IconInfo, IconPlus, IconServer } from '../components/Icons'

interface Props {
  servers: ManagedServer[]
  onChanged: () => void
}

/** `npx -y "@scope/pkg" --flag` → ['npx', '-y', '@scope/pkg', '--flag'], honouring quotes. */
export function splitCommand(line: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (let m = re.exec(line); m; m = re.exec(line)) out.push(m[1] ?? m[2] ?? m[3] ?? '')
  return out
}

/** `KEY=value` lines; blank lines and `#` comments skipped. */
function parsePairs(text: string): Record<string, string> | string {
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) return `"${line}" is not KEY=value.`
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return out
}

/**
 * The shortest way to put a server behind Bridge: a name, which AI app it is
 * for, and either the command that starts it or the URL it lives at.
 */
function AddServer({ clients, onDone, onCancel }: { clients: ClientStatusDto[]; onDone: () => Promise<void>; onCancel: () => void }): JSX.Element {
  const usable = clients.filter((c) => c.present)
  const [name, setName] = useState('')
  const [client, setClient] = useState(usable[0]?.id ?? '')
  const [launch, setLaunch] = useState('')
  const [pairs, setPairs] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const remote = /^https?:\/\//i.test(launch.trim())

  const submit = async (): Promise<void> => {
    setProblem(null)
    const trimmed = name.trim()
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(trimmed)) return setProblem('Name: letters, digits, "-" and "_" only.')
    if (!client) return setProblem('Pick the AI app this server is for.')
    const parsed = parsePairs(pairs)
    if (typeof parsed === 'string') return setProblem(parsed)
    const extra = Object.keys(parsed).length > 0 ? parsed : undefined
    let target: ManagedServer['target']
    if (remote) {
      target = { kind: 'http', url: launch.trim(), ...(extra ? { headers: extra } : {}) }
    } else {
      const [command, ...args] = splitCommand(launch.trim())
      if (!command) return setProblem('Enter the command that starts the server, or its URL.')
      target = { kind: 'stdio', command, args, ...(extra ? { env: extra } : {}) }
    }
    setSaving(true)
    try {
      const server = await api.invoke('servers:import', { name: trimmed, client: client as ManagedServer['client'], target })
      await api.invoke('servers:install', server.id)
      await onDone()
    } catch (err) {
      setProblem((err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="card">
      <div className="add-server">
        <div className="row">
          <label>Name<input className="input" placeholder="github" value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label>AI app<select className="select" value={client} onChange={(e) => setClient(e.target.value)}>{usable.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
        </div>
        <label>Command or URL<input className="input" placeholder="npx -y @modelcontextprotocol/server-github   or   https://mcp.example.com/mcp" value={launch} onChange={(e) => setLaunch(e.target.value)} /></label>
        <label>{remote ? 'Headers' : 'Environment'} <span className="faint">(optional, one KEY=value per line)</span><textarea className="input" placeholder={remote ? 'Authorization=Bearer …' : 'GITHUB_TOKEN=…'} value={pairs} onChange={(e) => setPairs(e.target.value)} /></label>
        {problem && <div className="form-error">{problem}</div>}
        <div className="row">
          <button className="btn primary" disabled={saving} onClick={() => void submit()}>{saving ? 'Adding…' : 'Add server'}</button>
          <button className="btn ghost" disabled={saving} onClick={onCancel}>Cancel</button>
          <span className="faint" style={{ fontSize: 12 }}>Restart the AI app afterwards so it picks the server up.</span>
        </div>
      </div>
    </div>
  )
}

const describe = (t: ManagedServer['target']): string =>
  t.kind === 'stdio' ? `${t.command} ${t.args.join(' ')}`.trim() : t.url

export function ServersPage({ servers, onChanged }: Props): JSX.Element {
  const [discovered, setDiscovered] = useState<DiscoveredServerDto[]>([])
  const [clients, setClients] = useState<ClientStatusDto[]>([])
  const [sessions, setSessions] = useState<SessionRecord[]>([])
  const [tools, setTools] = useState<ToolRecord[]>([])
  const [health, setHealth] = useState<ConfigHealth[]>([])
  const [links, setLinks] = useState<Array<{ serverId: string; client: string; installed: boolean }>>([])
  const [origins, setOrigins] = useState<Record<string, CatalogueItem>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [advisoriesOpen, setAdvisoriesOpen] = useState(false)
  const [adding, setAdding] = useState(false)

  const refresh = useCallback(async () => {
    const [d, c, s, t, h, l] = await Promise.all([
      api.invoke('servers:discover'),
      api.invoke('clients:status'),
      api.invoke('servers:sessions'),
      api.invoke('servers:tools', undefined),
      api.invoke('config:health'),
      api.invoke('servers:clients')
    ])
    setDiscovered(d)
    setClients(c)
    setSessions(s)
    setTools(t)
    setHealth(h)
    setLinks(l)
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 5000)
    return () => clearInterval(timer)
  }, [refresh])

  // A server installed from the Library knows its catalogue entry, which is
  // where the vendor icon and description live.
  useEffect(() => {
    const wanted = servers.map((s) => s.catalogueKey).filter((k): k is string => !!k && !origins[k])
    if (wanted.length === 0) return
    void Promise.all([...new Set(wanted)].map((k) => api.invoke('catalogue:get', k))).then((found) => {
      const next: Record<string, CatalogueItem> = {}
      for (const item of found) if (item) next[item.key] = item
      if (Object.keys(next).length > 0) setOrigins((prev) => ({ ...prev, ...next }))
    })
  }, [servers, origins])

  const iconHints: IconHint[] = useMemo(
    () => [
      ...servers.map((s) => ({
        key: s.id,
        catalogueKey: s.catalogueKey,
        iconUrl: s.catalogueKey ? origins[s.catalogueKey]?.iconUrl : null,
        endpoint: s.target.kind === 'http' ? s.target.url : null
      })),
      // Servers found in a config are worth resolving too: several are hosted
      // and their URL names the vendor.
      ...discovered.map((d) => ({
        key: `${d.client}:${d.name}`,
        endpoint: d.target.kind === 'http' ? d.target.url : null
      }))
    ],
    [servers, origins, discovered]
  )
  const icons = useVendorIcons(iconHints)

  const run = async (key: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(key)
    setError(null)
    try {
      await fn()
      onChanged()
      await refresh()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const connect = (d: DiscoveredServerDto): Promise<void> =>
    run(`${d.client}:${d.name}`, async () => {
      const server = await api.invoke('servers:import', { name: d.name, client: d.client, target: d.target })
      await api.invoke('servers:install', server.id)
    })

  const unconnected = discovered.filter((d) => !d.wrapped)
  const stale = clientsNeedingRestart(
    clients.map((c) => ({ ...c, configPresent: c.present })),
    sessions
  )
  const broken = health.filter((h) => h.problems.length > 0)
  const isDev = health.some((h) => h.dev)
  const advisoryCount = stale.length + broken.length + (isDev ? 1 : 0)

  const clientLabel = (id: string): string => clients.find((c) => c.id === id)?.label ?? id

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Servers</h1>
          <div className="sub">
            {servers.filter((s) => s.installed).length} going through Bridge · {sessions.length} live
          </div>
        </div>
        <span className="spacer" />
        <button className="btn" onClick={() => void refresh()}>
          Rescan
        </button>
        <button className="btn primary" onClick={() => setAdding(true)}>
          <IconPlus size={13} />
          Add server
        </button>
      </div>

      <div className="content pad stack">
        {adding && <AddServer clients={clients} onCancel={() => setAdding(false)} onDone={async () => { setAdding(false); onChanged(); await refresh() }} />}
        {error && (
          <div className="banner danger">
            <IconAlert />
            <div>{error}</div>
          </div>
        )}

        {advisoryCount > 0 && (
          <div className="advisories">
            <button
              className="advisory-head"
              aria-expanded={advisoriesOpen}
              onClick={() => setAdvisoriesOpen(!advisoriesOpen)}
            >
              <IconChevron size={13} className="chev" />
              <span className="grow">
                <b>
                  {advisoryCount} thing{advisoryCount === 1 ? '' : 's'} to know
                </b>
                {!advisoriesOpen && (
                  <span className="faint">
                    {' '}
                    — {[
                      stale.length > 0 ? `${stale.length} client needs restarting` : null,
                      broken.length > 0 ? `${broken.length} broken config` : null,
                      isDev ? 'development build' : null
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                )}
              </span>
            </button>

            {advisoriesOpen && (
              <div className="advisory-body">
                {stale.map((c) => (
                  <div className="advisory-item warn" key={`stale-${c.id}`}>
                    <IconAlert size={14} />
                    <div>
                      <b>{c.label} needs restarting.</b> It has been running since before Bridge last changed
                      its config, so it is still launching the old commands. Quit it properly — <b>⌘Q</b> on
                      macOS — then reopen it.
                    </div>
                  </div>
                ))}
                {broken.map((h) => (
                  <div className="advisory-item danger" key={`broken-${h.serverId}`}>
                    <IconAlert size={14} />
                    <div>
                      <b>{h.name} points at something that no longer exists.</b> {h.problems[0]} Press Connect
                      on it below to rewrite the entry.
                    </div>
                  </div>
                ))}
                {isDev && (
                  <div className="advisory-item info">
                    <IconInfo size={14} />
                    <div>
                      <b>Running from a development build.</b> Entries point at build artifacts inside the
                      project folder, so reinstalling dependencies or moving the folder will break them. Run{' '}
                      <span className="mono">npm run dist</span> and connect from the installed app for a setup
                      that lasts.
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <div className="section-head">
          <h2>Going through Bridge</h2>
          <span className="count">{servers.length}</span>
        </div>

        {servers.length === 0 ? (
          <div className="card">
            <div className="empty">
              <div className="glyph">
                <IconServer />
              </div>
              <h3>Nothing connected yet</h3>
              <p>Use Add server, pick one from the Library, or connect one already in your AI apps’ configs below.</p>
            </div>
          </div>
        ) : (
          <div className="conn-grid">
            {servers.map((s) => {
              const own = tools.filter((t) => t.serverId === s.id)
              const summary = summarizeInventory(
                own.map((t) => ({ name: t.name, description: t.description, schema: t.schema }))
              )
              const changed = own.filter((t) => t.changedAt).length
              const live = sessions.filter((x) => x.serverId === s.id)
              const wired = links.filter((l) => l.serverId === s.id && l.installed)
              const isBroken = broken.some((h) => h.serverId === s.id)
              const origin = s.catalogueKey ? origins[s.catalogueKey] : undefined
              return (
                <div key={s.id} className="conn-card srv-card" style={{ cursor: 'default' }}>
                  <VendorIcon name={s.name} identity={s.id} src={icons[s.id]} />
                  <div className="conn-body">
                    <div className="conn-name">
                      <span className="label">{s.name}</span>
                      {live.length > 0 && (
                        <span className="tag ok">
                          <span className="dot" /> live
                        </span>
                      )}
                      {isBroken && <span className="tag danger">config broken</span>}
                      {changed > 0 && <span className="tag danger">{changed} changed</span>}
                    </div>
                    <div className="srv-target">{origin?.description || describe(s.target)}</div>
                    <div className="srv-meta">
                      {wired.length > 0 ? (
                        wired.map((l) => (
                          <span key={l.client} className="client-chip">
                            {clientLabel(l.client)}
                          </span>
                        ))
                      ) : (
                        <span className="tag">not connected to any app</span>
                      )}
                      {own.length > 0 && (
                        <span className="faint">
                          {summary.total} tools · ~{compactNumber(summary.tokens)} tok
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    className="btn sm danger"
                    disabled={busy === s.id}
                    onClick={() => void run(s.id, () => api.invoke('servers:remove', s.id))}
                  >
                    Remove
                  </button>
                </div>
              )
            })}
          </div>
        )}

        <div className="section-head" style={{ marginTop: 8 }}>
          <h2>Found in your configs</h2>
          <span className="count">{unconnected.length} not going through Bridge</span>
        </div>

        {unconnected.length === 0 ? (
          <div className="card">
            <div className="row-item">
              <span className="faint">Every server Bridge can see is already connected.</span>
            </div>
          </div>
        ) : (
          <div className="conn-grid">
            {unconnected.map((d) => (
              <div key={`${d.client}:${d.name}`} className="conn-card srv-card" style={{ cursor: 'default' }}>
                <VendorIcon
                  name={d.name}
                  identity={`${d.client}:${d.name}`}
                  src={icons[`${d.client}:${d.name}`]}
                />
                <div className="conn-body">
                  <div className="conn-name">
                    <span className="label">{d.name}</span>
                    <span className="tag">{d.clientLabel}</span>
                  </div>
                  <div className="srv-target">{describe(d.target)}</div>
                </div>
                <button
                  className="btn primary sm"
                  disabled={busy === `${d.client}:${d.name}`}
                  onClick={() => void connect(d)}
                >
                  <IconPlus size={12} />
                  Connect
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="grid cols-2" style={{ marginTop: 8 }}>
          <div className="card">
            <div className="card-head">
              <h3>AI clients</h3>
              <span className="sub">{clients.filter((c) => c.present).length} found on this machine</span>
            </div>
            <div className="card-body flush">
              {clients.map((c) => (
                <div key={c.id} className="row-item">
                  <div className="grow">
                    <div className="row-title">
                      {c.label}
                      {stale.some((x) => x.id === c.id) && <span className="tag warn">restart needed</span>}
                    </div>
                    <div className="row-sub mono truncate">{c.configPath}</div>
                  </div>
                  <span className={`tag ${c.present ? 'info' : ''}`}>
                    {c.present ? `${c.serverCount} servers` : 'not found'}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h3>Live sessions</h3>
              <span className="sub">one proxy per client connection</span>
            </div>
            <div className="card-body flush">
              {sessions.length === 0 ? (
                <div className="row-item">
                  <span className="faint">No AI client is running a connected server right now.</span>
                </div>
              ) : (
                [...groupBy(sessions, (s) => s.serverId)].map(([serverId, group]) => (
                  <div key={serverId} className="row-item">
                    <div className="grow">
                      <div className="row-title">
                        {group[0]?.serverName}
                        <span className="tag ok">
                          <span className="dot" /> {group.length}{' '}
                          {group.length === 1 ? 'connection' : 'connections'}
                        </span>
                      </div>
                      {group.map((s) => (
                        <div key={s.id} className="row-sub">
                          <span className="mono">pid {s.pid}</span> · since {dateOf(s.startedAt)}
                          {s.clientInfo?.name && (
                            <>
                              {' '}
                              · <span className="tag info">{s.clientInfo.title || s.clientInfo.name}</span>
                            </>
                          )}
                        </div>
                      ))}
                      {group.length > 1 && (
                        <div className="row-sub">
                          Normal: a client starts one copy per surface it runs, so one server can show several
                          connections.
                        </div>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

/** Small helper so the session grouping reads as one expression. */
function groupBy<T, K>(items: readonly T[], key: (item: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>()
  for (const item of items) {
    const k = key(item)
    const list = out.get(k) ?? []
    list.push(item)
    out.set(k, list)
  }
  return out
}
