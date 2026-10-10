import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ManagedServer, ToolRecord } from '@shared/types'
import { classifyTool, estimateToolTokens, summarizeInventory, type ToolCapability } from '@shared/toolrisk'
import { api } from '../lib/api'
import { VendorIcon, useVendorIcons, type IconHint } from '../components/VendorIcon'
import { compactNumber, dateOf, pretty } from '../lib/format'
import { IconAlert, IconClose, IconInfo, IconSearch, IconTool } from '../components/Icons'

const CAPS: Array<ToolCapability | 'all'> = ['all', 'execute', 'destructive', 'write', 'read', 'unknown']

interface Props {
  servers: ManagedServer[]
}

export function ToolsPage({ servers }: Props): JSX.Element {
  const [tools, setTools] = useState<ToolRecord[]>([])
  const [search, setSearch] = useState('')
  const [cap, setCap] = useState<ToolCapability | 'all'>('all')
  const [serverId, setServerId] = useState('')
  const [selected, setSelected] = useState<ToolRecord | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    setTools(await api.invoke('servers:tools', undefined))
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const setEnabled = async (targets: ToolRecord[], enabled: boolean): Promise<void> => {
    if (targets.length === 0) return
    setBusy(true)
    try {
      // Preferences are per server, so group before writing.
      const byServer = new Map<string, string[]>()
      for (const t of targets) {
        const list = byServer.get(t.serverId) ?? []
        list.push(t.name)
        byServer.set(t.serverId, list)
      }
      for (const [sid, names] of byServer) {
        await api.invoke('tools:setEnabled', { serverId: sid, names, enabled })
      }
      await load()
      setNotice(
        `${enabled ? 'Enabled' : 'Hid'} ${targets.length} ${targets.length === 1 ? 'tool' : 'tools'}. ` +
          'Live sessions were told to re-read the list; restart your AI client if it does not pick it up.'
      )
    } finally {
      setBusy(false)
    }
  }

  const decorated = useMemo(
    () =>
      tools.map((tool) => ({
        // Treat a missing flag as enabled — a tool is hidden only when a
        // preference explicitly says so.
        tool: { ...tool, enabled: tool.enabled !== false },
        info: classifyTool(tool.name, tool.description),
        tokens: estimateToolTokens(tool)
      })),
    [tools]
  )

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return decorated
      .filter(({ tool, info }) => {
        if (serverId && tool.serverId !== serverId) return false
        if (cap !== 'all' && info.capability !== cap) return false
        if (needle && !`${tool.name} ${tool.description}`.toLowerCase().includes(needle)) return false
        return true
      })
      .sort((a, b) => b.info.weight - a.info.weight || b.tokens - a.tokens)
  }, [decorated, search, cap, serverId])

  const scope = serverId ? decorated.filter((d) => d.tool.serverId === serverId) : decorated
  const active = scope.filter((d) => d.tool.enabled)
  const hidden = scope.filter((d) => !d.tool.enabled)
  const activeTokens = active.reduce((n, d) => n + d.tokens, 0)
  const savedTokens = hidden.reduce((n, d) => n + d.tokens, 0)
  const summary = summarizeInventory(
    active.map(({ tool }) => ({ name: tool.name, description: tool.description, schema: tool.schema }))
  )

  const nameOf = (id: string): string => servers.find((s) => s.id === id)?.name ?? id

  // Same icon treatment as everywhere else, so a server looks like itself.
  const iconHints: IconHint[] = useMemo(
    () =>
      servers.map((s) => ({
        key: s.id,
        catalogueKey: s.catalogueKey,
        endpoint: s.target.kind === 'http' ? s.target.url : null
      })),
    [servers]
  )
  const icons = useVendorIcons(iconHints)
  const visibleRows = rows.map((r) => r.tool)

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Tools</h1>
          <div className="sub">switch off what you don&apos;t want the model to see</div>
        </div>
        <span className="spacer" />
        <div className="search">
          <IconSearch size={13} />
          <input className="input" placeholder="Search tools…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <select className="select" value={serverId} onChange={(e) => setServerId(e.target.value)}>
          <option value="">All servers</option>
          {servers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>

      <div className={`split ${selected ? 'open' : ''}`}>
        <div className="pane">
          <div className="pad stack">
            {notice && (
              <div className="banner">
                <IconInfo />
                <div className="grow">{notice}</div>
                <button className="btn ghost icon" onClick={() => setNotice(null)} aria-label="Dismiss">
                  <IconClose size={13} />
                </button>
              </div>
            )}

            <div className="grid metrics">
              <div className="card metric">
                <div className="label">Active tools</div>
                <div className="value">
                  {active.length}
                  <span className="unit">of {scope.length}</span>
                </div>
                <div className="foot">{summary.riskyCount} can write, delete or execute</div>
              </div>
              <div className="card metric accent">
                <div className="label">Context in use</div>
                <div className="value">
                  {compactNumber(activeTokens)}
                  <span className="unit">tok</span>
                </div>
                <div className="foot">loaded into every conversation</div>
              </div>
              <div className={`card metric ${savedTokens > 0 ? 'warn' : ''}`}>
                <div className="label">Context reclaimed</div>
                <div className="value">
                  {compactNumber(savedTokens)}
                  <span className="unit">tok</span>
                </div>
                <div className="foot">{hidden.length} tools hidden from the model</div>
              </div>
            </div>

            <div className="row wrap between">
              <div className="segmented">
                {CAPS.map((c) => (
                  <button key={c} aria-pressed={cap === c} onClick={() => setCap(c)}>
                    {c === 'all' ? 'All' : c}
                  </button>
                ))}
              </div>
              <div className="row wrap">
                <span className="faint">{rows.length} shown</span>
                <button
                  className="btn sm"
                  disabled={busy || visibleRows.every((t) => t.enabled)}
                  onClick={() => void setEnabled(visibleRows.filter((t) => !t.enabled), true)}
                >
                  Enable these
                </button>
                <button
                  className="btn sm danger"
                  disabled={busy || visibleRows.every((t) => !t.enabled)}
                  onClick={() => void setEnabled(visibleRows.filter((t) => t.enabled), false)}
                >
                  Hide these
                </button>
              </div>
            </div>

            {tools.length === 0 ? (
              <div className="card">
                <div className="empty">
                  <div className="glyph">
                    <IconTool />
                  </div>
                  <h3>No tool inventory yet</h3>
                  <p>
                    Bridge records a server&apos;s tools the first time the AI client asks for them, which happens as
                    soon as the client starts.
                  </p>
                  <p className="hint">Connect a server, then restart your AI client.</p>
                </div>
              </div>
            ) : (
              <div className="card">
                <table className="table">
                  <thead>
                    <tr>
                      <th style={{ width: 46 }}>On</th>
                      <th>Tool</th>
                      <th style={{ width: 110 }}>Capability</th>
                      <th style={{ width: 120 }}>Server</th>
                      <th>Description</th>
                      <th style={{ width: 88 }} className="num">
                        Context
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(({ tool, info, tokens }) => (
                      <tr
                        key={`${tool.serverId}:${tool.name}`}
                        aria-selected={selected?.name === tool.name && selected?.serverId === tool.serverId}
                        onClick={() => setSelected(tool)}
                        style={tool.enabled ? undefined : { opacity: 0.5 }}
                      >
                        <td onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={tool.enabled}
                            disabled={busy}
                            aria-label={`${tool.enabled ? 'Hide' : 'Enable'} ${tool.name}`}
                            onChange={() => void setEnabled([tool], !tool.enabled)}
                            style={{ accentColor: 'var(--accent)', width: 14, height: 14 }}
                          />
                        </td>
                        <td className="t-tool">
                          {tool.name}
                          {!tool.enabled && (
                            <span className="tag" style={{ marginLeft: 7 }}>
                              hidden
                            </span>
                          )}
                          {tool.changedAt && (
                            <span className="tag danger" style={{ marginLeft: 7 }}>
                              changed
                            </span>
                          )}
                        </td>
                        <td>
                          <span className={`tag cap-${info.capability}`}>{info.capability}</span>
                        </td>
                        <td>
                          <span className="row" style={{ gap: 7, minWidth: 0 }}>
                            <VendorIcon
                              name={nameOf(tool.serverId)}
                              identity={tool.serverId}
                              src={icons[tool.serverId]}
                              size={20}
                            />
                            <span className="dim truncate">{nameOf(tool.serverId)}</span>
                          </span>
                        </td>
                        <td className="t-args truncate">{tool.description || <span className="faint">—</span>}</td>
                        <td className="num">~{tokens}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {rows.length === 0 && <div className="empty">No tools match those filters.</div>}
              </div>
            )}
          </div>
        </div>

        {selected && (
          <aside className="drawer">
            <div className="drawer-head">
              <div className="row between">
                <div className="drawer-title">{selected.name}</div>
                <button className="btn ghost icon" onClick={() => setSelected(null)} aria-label="Close">
                  <IconClose />
                </button>
              </div>
              <div className="drawer-sub row wrap" style={{ gap: 7 }}>
                <span>{nameOf(selected.serverId)}</span>
                <span className={`tag cap-${classifyTool(selected.name, selected.description).capability}`}>
                  {classifyTool(selected.name, selected.description).label}
                </span>
                <span className={`tag ${selected.enabled ? 'ok' : ''}`}>{selected.enabled ? 'visible' : 'hidden'}</span>
              </div>
            </div>
            <div className="drawer-body">
              <button
                className={`btn ${selected.enabled ? 'danger' : 'primary'}`}
                disabled={busy}
                onClick={() => void setEnabled([selected], !selected.enabled).then(load)}
              >
                {selected.enabled ? 'Hide from the model' : 'Make visible again'}
              </button>

              {selected.changedAt && (
                <div className="banner danger" style={{ marginTop: 16 }}>
                  <IconAlert />
                  <div>
                    This definition changed on {dateOf(selected.changedAt)} (revision {selected.revision}). The next
                    call to it will ask for approval again.
                  </div>
                </div>
              )}

              <div className="section">Description</div>
              <p className="dim" style={{ margin: 0, fontSize: 12.5, lineHeight: 1.6 }}>
                {selected.description || 'No description provided by the server.'}
              </p>

              <div className="section">Facts</div>
              <dl className="kv">
                <dt>Context cost</dt>
                <dd>~{estimateToolTokens(selected).toLocaleString()} tokens</dd>
                <dt>Revision</dt>
                <dd>{selected.revision}</dd>
                <dt>Fingerprint</dt>
                <dd className="mono faint">{selected.fingerprint}</dd>
                <dt>First seen</dt>
                <dd>{dateOf(selected.firstSeenAt)}</dd>
                <dt>Last seen</dt>
                <dd>{dateOf(selected.lastSeenAt)}</dd>
              </dl>

              <div className="section">Input schema</div>
              <pre className="code">{selected.schema ? pretty(selected.schema) : 'No schema declared.'}</pre>
            </div>
          </aside>
        )}
      </div>
    </>
  )
}
