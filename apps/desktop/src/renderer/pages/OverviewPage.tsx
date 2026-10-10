import type { CoverageReport } from '@shared/coverage'
import { Coverage } from '../components/Coverage'
import { HookCoverage } from '../components/HookCoverage'
import { useEffect, useMemo, useState } from 'react'
import type { CallRecord, ManagedServer, SessionRecord, StatsSummary, ToolRecord } from '@shared/types'
import { classifyTool, estimateToolTokens, summarizeInventory, type ToolCapability } from '@shared/toolrisk'
import { overviewVerdict } from '@shared/verdict'
import { api } from '../lib/api'
import { VendorIcon, useVendorIcons, type IconHint } from '../components/VendorIcon'
import { compactNumber, duration, timeOf } from '../lib/format'
import { IconBolt, IconInfo, IconServer, IconTool } from '../components/Icons'

const CAP_COLOR: Record<ToolCapability, string> = {
  execute: 'var(--danger)',
  destructive: 'var(--danger)',
  write: 'var(--warn)',
  read: 'var(--info)',
  unknown: 'var(--ink-3)'
}

const CAP_ORDER: ToolCapability[] = ['execute', 'destructive', 'write', 'read', 'unknown']

/** Execute and destructive share a colour, so the legend must not list both. */
const LEGEND: Array<{ caps: ToolCapability[]; label: string; color: string }> = [
  { caps: ['execute', 'destructive'], label: 'can execute or delete', color: 'var(--danger)' },
  { caps: ['write'], label: 'can write', color: 'var(--warn)' },
  { caps: ['read'], label: 'read only', color: 'var(--info)' },
  { caps: ['unknown'], label: 'unclassified', color: 'var(--ink-3)' }
]

interface Props {
  calls: CallRecord[]
  servers: ManagedServer[]
  onNavigate: (tab: 'trace' | 'tools' | 'servers') => void
}

export function OverviewPage({ calls, servers, onNavigate }: Props): JSX.Element {
  const [coverage, setCoverage] = useState<CoverageReport | null>(null)
  const [coverageError, setCoverageError] = useState(false)
  const [tools, setTools] = useState<ToolRecord[]>([])
  const [sessions, setSessions] = useState<SessionRecord[]>([])
  const [stats, setStats] = useState<StatsSummary | null>(null)

  useEffect(() => {
    let active = true
    const load = async (): Promise<void> => {
      try {
        const report = await api.invoke('security:coverage')
        if (active) { setCoverage(report); setCoverageError(false) }
      } catch { if (active) setCoverageError(true) }
      const [t, s, st] = await Promise.all([
        api.invoke('servers:tools', undefined),
        api.invoke('servers:sessions'),
        api.invoke('calls:stats')
      ])
      setTools(t)
      setSessions(s)
      setStats(st)
    }
    void load()
    const timer = setInterval(() => void load(), 5000)
    return () => { active = false; clearInterval(timer) }
  }, [])

  const inventory = useMemo(
    () => summarizeInventory(tools.map((t) => ({ name: t.name, description: t.description, schema: t.schema }))),
    [tools]
  )

  const perServer = useMemo(() => {
    const liveIds = new Set(sessions.map((s) => s.serverId))
    return servers
      .map((server) => {
        const own = tools.filter((t) => t.serverId === server.id)
        const summary = summarizeInventory(
          own.map((t) => ({ name: t.name, description: t.description, schema: t.schema }))
        )
        return {
          server,
          live: liveIds.has(server.id),
          changed: own.filter((t) => t.changedAt).length,
          ...summary
        }
      })
      .sort((a, b) => b.tokens - a.tokens)
  }, [servers, tools, sessions])

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

  const changedTools = tools.filter((t) => t.changedAt)
  const connected = servers.filter((s) => s.installed).length
  const recent = calls.slice(0, 7)

  const verdict = overviewVerdict({
    sessions: sessions.length,
    connectedServers: connected,
    tools: inventory.total,
    denied: stats?.denied ?? 0,
    flagged: stats?.flagged ?? 0,
    changedTools: changedTools.length
  })

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Coverage</h1>
          <div className="sub">What Bridge can see and decide, and how to extend it</div>
        </div>
      </div>

      <div className="content pad stack">
        <Coverage report={coverage} error={coverageError} onManage={() => onNavigate('servers')} />
        <HookCoverage />
        <div className={`hero ${verdict.tone}`}>
          <div className="hero-verdict">
            <span className="hero-dot" />
            <div style={{ minWidth: 0 }}>
              <div className="hero-headline">{verdict.headline}</div>
              <div className="hero-line">{verdict.detail}</div>
              {verdict.chips.length > 0 && (
                <div className="hero-chips">
                  {verdict.chips.map((chip) => (
                    <button
                      key={chip.label}
                      className={`hero-chip ${chip.tone === 'plain' ? '' : chip.tone}`}
                      onClick={() => onNavigate(chip.goto)}
                    >
                      <b>{chip.count}</b> {chip.label}
                    </button>
                  ))}
                </div>
              )}
              {connected === 0 && (
                <div className="hero-chips">
                  <button className="btn primary sm" onClick={() => onNavigate('servers')}>
                    Find my servers
                  </button>
                </div>
              )}
            </div>
          </div>

          {inventory.total > 0 && (
            <div>
              <div className="mix-title">
                <span>
                  <b>{inventory.riskyCount}</b> of {inventory.total} tools can change something
                </span>
              </div>
              <div className="bar tall">
                {CAP_ORDER.map((cap) =>
                  inventory.byCapability[cap] > 0 ? (
                    <span
                      key={cap}
                      title={`${inventory.byCapability[cap]} ${cap}`}
                      style={{
                        width: `${(inventory.byCapability[cap] / inventory.total) * 100}%`,
                        background: CAP_COLOR[cap]
                      }}
                    />
                  ) : null
                )}
              </div>
              <div className="mix-legend">
                {LEGEND.map((entry) => {
                  const n = entry.caps.reduce((sum, cap) => sum + inventory.byCapability[cap], 0)
                  return n > 0 ? (
                    <span key={entry.label}>
                      <i style={{ background: entry.color }} />
                      <b>{n}</b> {entry.label}
                    </span>
                  ) : null
                })}
              </div>
            </div>
          )}
        </div>

        <div className="grid cols-4">
          <div className="card metric">
            <div className="label">
              <IconServer size={12} /> Live sessions
            </div>
            <div className="value">{sessions.length}</div>
            <div className="foot">
              {connected} {connected === 1 ? 'server' : 'servers'} connected
            </div>
          </div>

          <div className="card metric">
            <div className="label">
              <IconTool size={12} /> Tools exposed
            </div>
            <div className="value">{inventory.total}</div>
            <div className="foot">{inventory.riskyCount} can write, delete or execute</div>
          </div>

          <div className="card metric accent">
            <div className="label">
              <IconBolt size={12} /> Schema size estimate
            </div>
            <div className="value">
              {compactNumber(inventory.tokens)}
              <span className="unit">tok</span>
            </div>
            <div className="foot">advertised schemas; actual loading depends on the client</div>
          </div>

          <div className="card metric">
            <div className="label">Calls (24h)</div>
            <div className="value">{compactNumber(stats?.last24h ?? 0)}</div>
            <div className="foot">{stats?.totalCalls ?? 0} recorded in total</div>
          </div>
        </div>

        <div className="two-col">
          <div className="card">
            <div className="card-head">
              <h3>Exposed surface</h3>
              <span className="sub">what each server puts in front of the model</span>
              <span className="spacer" />
              {perServer.length > 0 && (
                <button className="btn sm" onClick={() => onNavigate('tools')}>
                  Inspect tools
                </button>
              )}
            </div>
            <div className="card-body flush">
              {perServer.length === 0 ? (
                <div className="empty">
                  <div className="glyph">
                    <IconServer />
                  </div>
                  <h3>No servers connected yet</h3>
                  <p>Bridge can see the MCP servers already configured in your AI clients and wrap them.</p>
                  <button className="btn primary" onClick={() => onNavigate('servers')}>
                    Find my servers
                  </button>
                </div>
              ) : (
                perServer.map((row) => (
                  <div key={row.server.id} className="srv-row">
                    <VendorIcon name={row.server.name} identity={row.server.id} src={icons[row.server.id]} size={34} />
                    <div style={{ minWidth: 0 }}>
                      <div className="name">
                        <span className="truncate">{row.server.name}</span>
                        {row.live ? (
                          <span className="tag ok">
                            <span className="dot" /> live
                          </span>
                        ) : (
                          <span className="tag">idle</span>
                        )}
                        {row.changed > 0 && <span className="tag danger">{row.changed} changed</span>}
                      </div>
                      <div className="sub">
                        {row.total} {row.total === 1 ? 'tool' : 'tools'}
                        {row.riskyCount > 0 && ` · ${row.riskyCount} can change something`}
                      </div>
                      {row.total > 0 && (
                      <div className="bar" style={{ marginTop: 7 }}>
                        {CAP_ORDER.map((cap) =>
                          row.byCapability[cap] > 0 ? (
                            <span
                              key={cap}
                              title={`${row.byCapability[cap]} ${cap}`}
                              style={{
                                width: `${(row.byCapability[cap] / row.total) * 100}%`,
                                background: CAP_COLOR[cap]
                              }}
                            />
                          ) : null
                        )}
                      </div>
                      )}
                    </div>
                    <div className="cost">
                      {compactNumber(row.tokens)}
                      <small>tokens</small>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h3>Recent activity</h3>
              <span className="spacer" />
              {recent.length > 0 && (
                <button className="btn sm" onClick={() => onNavigate('trace')}>
                  Live trace
                </button>
              )}
            </div>
            <div className="card-body flush">
              {recent.length === 0 ? (
                <div className="empty">
                  <div className="glyph">
                    <IconInfo />
                  </div>
                  <h3>No tool has run yet</h3>
                  <p>
                    Your client asks each server for its tool list at launch — that already happened, which is how
                    Bridge knows about the {inventory.total} tools. A row appears the moment the model{' '}
                    <em>uses</em> one.
                  </p>
                </div>
              ) : (
                recent.map((call) => {
                  const cap = classifyTool(call.tool ?? '').capability
                  return (
                    <div key={call.id} className="feed-item" onClick={() => onNavigate('trace')}>
                      <span className={`feed-dot ${cap}`}>
                        <IconTool size={13} />
                      </span>
                      <div style={{ minWidth: 0 }}>
                        <div className="feed-tool">{call.tool}</div>
                        <div className="feed-sub">
                          {call.serverName} · {timeOf(call.startedAt)} · {duration(call.durationMs)}
                        </div>
                      </div>
                      <StatusTag status={call.status} />
                    </div>
                  )
                })
              )}
            </div>
          </div>
        </div>

        {tools.length > 0 && (
          <div className="card">
            <div className="card-head">
              <h3>Most expensive tool definitions</h3>
              <span className="sub">estimated schema sizes; clients may load tools on demand</span>
            </div>
            <div className="card-body flush">
              <table className="table">
                <thead>
                  <tr>
                    <th>Tool</th>
                    <th style={{ width: 110 }}>Capability</th>
                    <th>What it does</th>
                    <th className="num" style={{ width: 96 }}>
                      Context
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {[...tools]
                    .sort((a, b) => estimateToolTokens(b) - estimateToolTokens(a))
                    .slice(0, 5)
                    .map((tool) => (
                      <tr key={`${tool.serverId}:${tool.name}`} onClick={() => onNavigate('tools')}>
                        <td className="t-tool">{tool.name}</td>
                        <td>
                          <span className={`tag cap-${classifyTool(tool.name, tool.description).capability}`}>
                            {classifyTool(tool.name, tool.description).capability}
                          </span>
                        </td>
                        <td className="t-args truncate">{tool.description}</td>
                        <td className="num">~{estimateToolTokens(tool)} tok</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </>
  )
}

export function StatusTag({ status }: { status: CallRecord['status'] }): JSX.Element {
  const map: Record<CallRecord['status'], { cls: string; text: string }> = {
    completed: { cls: 'ok', text: 'ok' },
    // Bridge let it run and never heard back. Not a success, not a failure.
    permitted: { cls: 'info', text: 'permitted' },
    pending: { cls: 'info', text: 'running' },
    'awaiting-approval': { cls: 'warn', text: 'asking' },
    denied: { cls: 'danger', text: 'blocked' },
    failed: { cls: 'warn', text: 'failed' },
    cancelled: { cls: '', text: 'cancelled' }
  }
  const { cls, text } = map[status]
  return <span className={`tag ${cls}`}>{text}</span>
}
