import { useEffect, useMemo, useState } from 'react'
import type { CallRecord, ManagedServer } from '@shared/types'
import { classifyTool } from '@shared/toolrisk'
import { api } from '../lib/api'
import { VendorIcon, useVendorIcons, type IconHint } from '../components/VendorIcon'
import { compactNumber, duration, summarizeArgs, timeOf, topSeverity } from '../lib/format'
import { IconExport, IconPause, IconPlay, IconPulse, IconSearch } from '../components/Icons'
import { TraceDetail } from '../components/TraceDetail'
import { StatusTag } from './OverviewPage'

interface Props {
  initialCallId?: string | null
  calls: CallRecord[]
  servers: ManagedServer[]
  toolCount: number
  filters: { serverId: string; flaggedOnly: boolean; search: string }
  onFilters: (f: Props['filters']) => void
  paused: boolean
  onPaused: (p: boolean) => void
  onNavigate: (tab: 'tools' | 'servers') => void
}

export function TracePage({
  initialCallId,
  calls,
  servers,
  toolCount,
  filters,
  onFilters,
  paused,
  onPaused,
  onNavigate
}: Props): JSX.Element {
  const [layout, setLayout] = useState<'timeline' | 'table'>('timeline')
  const [sessionId, setSessionId] = useState('')
  const sessionIds = [...new Set(calls.map((call) => call.sessionId))]
  const visibleCalls = calls.filter((call) => !sessionId || call.sessionId === sessionId).sort((a, b) => sessionId ? a.startedAt - b.startedAt : b.startedAt - a.startedAt)
  const [selectedId, setSelectedId] = useState<string | null>(initialCallId ?? null)
  useEffect(() => setSelectedId(initialCallId ?? null), [initialCallId])
  const selected = useMemo(() => calls.find((c) => c.id === selectedId) ?? null, [calls, selectedId])

  // The same vendor icons the rest of the app uses, so a server is recognisable
  // at a glance rather than by reading its name.
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

  const exportTrace = async (): Promise<void> => {
    const result = await api.invoke('calls:export', {
      serverId: filters.serverId || undefined,
      flaggedOnly: filters.flaggedOnly || undefined,
      search: filters.search || undefined
    })
    if (result) alert(`Exported ${result.count} calls to ${result.path}`)
  }

  const flagged = calls.filter((c) => c.findings.length > 0).length

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Trace</h1>
          <div className="sub">
            {calls.length} {calls.length === 1 ? 'call' : 'calls'}
            {flagged > 0 && <> · {flagged} flagged</>}
          </div>
        </div>
        <span className="spacer" />
        <div className="search">
          <IconSearch size={13} />
          <input
            className="input"
            placeholder="Filter tool or argument…"
            value={filters.search}
            onChange={(e) => onFilters({ ...filters, search: e.target.value })}
          />
        </div>
        <select
          className="select"
          value={filters.serverId}
          onChange={(e) => onFilters({ ...filters, serverId: e.target.value })}
        >
          <option value="">All servers</option>
          {servers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <label className="check">
          <input
            type="checkbox"
            checked={filters.flaggedOnly}
            onChange={(e) => onFilters({ ...filters, flaggedOnly: e.target.checked })}
          />
          Flagged only
        </label>
        <button className="btn" onClick={() => onPaused(!paused)}>
          {paused ? <IconPlay size={13} /> : <IconPause size={13} />}
          {paused ? 'Resume display' : 'Pause display'}
        </button>
        <button className="btn" onClick={() => void exportTrace()}>
          <IconExport size={13} />
          Export
        </button>
      </div>

      <div className="trace-context">
        <div className="trace-context-bar"><div><span className="security-eyebrow">ACTIVITY EXPLORER</span><h2>{sessionId ? 'Follow the execution.' : 'Every observed action, in view.'}</h2></div><div className="segmented"><button aria-pressed={layout === 'timeline'} onClick={() => setLayout('timeline')}>Timeline</button><button aria-pressed={layout === 'table'} onClick={() => setLayout('table')}>Table</button></div></div>
        <div className="trace-context-stats"><div><b>{visibleCalls.length}</b><span>Recorded actions</span></div><div><b>{new Set(visibleCalls.map((call) => call.tool)).size}</b><span>Distinct tools</span></div><div><b>{visibleCalls.filter((call) => call.status === 'denied').length}</b><span>Blocked</span></div><div><b>Unavailable</b><span>Provider-reported cost</span></div></div>
        <div className="trace-context-bar"><label className="sub">Proxy session <select className="select" value={sessionId} onChange={(e) => { setSessionId(e.target.value); setSelectedId(null) }}><option value="">All observed sessions</option>{sessionIds.map((id) => <option key={id} value={id}>{id}</option>)}</select></label><details className="trace-attribution"><summary>What this trace can tell you</summary><p>A proxy session is not a chat. Agent, skill, actual credential use and billed cost need client/provider telemetry. Tokens estimate result text size. Export uses server/search filters, not the session selection.</p></details></div>
      </div>
      <div className={`split ${selected ? 'open' : ''}`}>
        <div className="pane">
          {visibleCalls.length === 0 ? (
            <div className="empty">
              <div className="glyph">
                <IconPulse />
              </div>
              <h3>Nothing has run yet</h3>
              <p>
                Your AI client already started its servers and collected{' '}
                <b>{toolCount} tool definitions</b> — Bridge saw that part. But a row only appears here when the
                model actually <em>calls</em> one.
              </p>
              <p className="hint">
                Ask your assistant to do something that needs a tool, and it will show up the instant it happens.
              </p>
              <div className="row" style={{ justifyContent: 'center', marginTop: 14 }}>
                <button className="btn" onClick={() => onNavigate('tools')}>
                  See what tools exist
                </button>
                <button className="btn" onClick={() => onNavigate('servers')}>
                  Check connections
                </button>
              </div>
            </div>
          ) : layout === 'timeline' ? <div className="trace-timeline" aria-label="Action timeline">
            <div className="trace-order">{sessionId ? 'EARLIEST FIRST · SELECTED PROXY SESSION' : 'LATEST FIRST · OBSERVED SESSIONS'}</div>
            {visibleCalls.map((call) => <button key={call.id} className={`trace-step ${selectedId === call.id ? 'selected' : ''}`} aria-pressed={selectedId === call.id} onClick={() => setSelectedId(call.id === selectedId ? null : call.id)}>
              <span className={`trace-step-dot ${call.status === 'denied' || call.findings.length ? 'attention' : ''}`} />
              <span className="trace-step-time">{timeOf(call.startedAt)}</span>
              <span className="trace-step-card"><span className="trace-step-heading"><VendorIcon name={call.serverName} identity={call.serverId} src={icons[call.serverId]} size={25} /><span><b>{call.tool ?? call.method}</b><small>{call.client} <span aria-hidden="true">→</span> {call.serverName}</small></span><span className="spacer" /><StatusTag status={call.status} /></span><span className="trace-step-args">{summarizeArgs(call) || 'No argument preview available'}</span><span className="trace-step-footer"><span>{duration(call.durationMs)} duration</span><span>{call.decidedBy ? `Decision: ${call.decidedBy}` : 'Decision pending'}</span><span>{call.findings.length ? `${call.findings.length} findings` : 'No recorded findings'}</span><span className="spacer" /><span>Inspect ↗</span></span></span>
            </button>)}
          </div> : (
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 3, padding: 0 }} />
                  <th style={{ width: 66 }}>Time</th>
                  <th style={{ width: 120 }}>Server</th>
                  <th style={{ width: 200 }}>Tool</th>
                  <th>Arguments</th>
                  <th style={{ width: 130 }}>Findings</th>
                  <th style={{ width: 70 }} className="num">
                    Time
                  </th>
                  <th style={{ width: 68 }} className="num">
                    Tokens
                  </th>
                  <th style={{ width: 88 }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {visibleCalls.map((call) => {
                  const severity = topSeverity(call.findings)
                  const cap = classifyTool(call.tool ?? '').capability
                  return (
                    <tr
                      key={call.id}
                      aria-selected={call.id === selectedId}
                      onClick={() => setSelectedId(call.id === selectedId ? null : call.id)}
                    >
                      <td className="risk-cell">
                        <span className={`risk-bar ${severity ?? ''}`} />
                      </td>
                      <td className="t-time">{timeOf(call.startedAt)}</td>
                      <td>
                        <span className="row" style={{ gap: 7, minWidth: 0 }}>
                          <VendorIcon
                            name={call.serverName}
                            identity={call.serverId}
                            src={icons[call.serverId]}
                            size={18}
                          />
                          <span className="dim truncate">{call.serverName}</span>
                        </span>
                      </td>
                      <td className="t-tool truncate">
                        {call.tool ?? call.method}
                        <span className={`tag cap-${cap}`} style={{ marginLeft: 7 }}>
                          {cap}
                        </span>
                      </td>
                      <td className="t-args truncate">{summarizeArgs(call)}</td>
                      <td>
                        {call.findings.length === 0 ? (
                          <span className="faint">—</span>
                        ) : (
                          <span className={`tag ${severity === 'high' ? 'danger' : severity === 'medium' ? 'warn' : 'ok'}`}>
                            {call.findings.length === 1 ? call.findings[0]?.label : `${call.findings.length} flags`}
                          </span>
                        )}
                      </td>
                      <td className="num">{duration(call.durationMs)}</td>
                      <td className="num">{call.tokenEstimate ? compactNumber(call.tokenEstimate) : '—'}</td>
                      <td>
                        <StatusTag status={call.status} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
        {selected && <TraceDetail key={selected.id} call={selected} onClose={() => setSelectedId(null)} />}
      </div>
    </>
  )
}
