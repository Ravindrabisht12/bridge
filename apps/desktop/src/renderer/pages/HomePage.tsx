import { useEffect, useState } from 'react'
import type { CallRecord, ManagedServer, SessionRecord, StatsSummary } from '@shared/types'
import { api } from '../lib/api'
import { IconChevron } from '../components/Icons'

interface Props {
  calls: CallRecord[]
  servers: ManagedServer[]
  onNavigate: (tab: 'servers' | 'trace') => void
}

const MARK: Record<CallRecord['status'], { mark: string; tone: string }> = {
  pending: { mark: '…', tone: 'running' },
  permitted: { mark: '…', tone: 'running' },
  'awaiting-approval': { mark: '?', tone: 'waiting' },
  completed: { mark: '✓', tone: 'ok' },
  failed: { mark: '✕', tone: 'failed' },
  denied: { mark: '⊘', tone: 'failed' },
  cancelled: { mark: '–', tone: 'muted' }
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`
  return new Date(ms).toLocaleDateString()
}

/**
 * The first screen: is anything connected, is anything running, and what did
 * the AI do lately. Everything here links to the page with the detail.
 */
export function HomePage({ calls, servers, onNavigate }: Props): JSX.Element {
  const [stats, setStats] = useState<StatsSummary | null>(null)
  const [sessions, setSessions] = useState<SessionRecord[]>([])
  const [labels, setLabels] = useState<Record<string, string>>({})

  useEffect(() => {
    let active = true
    const load = async (): Promise<void> => {
      const [st, se] = await Promise.all([api.invoke('calls:stats'), api.invoke('servers:sessions')])
      if (active) { setStats(st); setSessions(se) }
    }
    void load()
    void api.invoke('clients:status').then((c) => active && setLabels(Object.fromEntries(c.map((x) => [x.id, x.label]))))
    const timer = setInterval(() => void load(), 5000)
    return () => { active = false; clearInterval(timer) }
  }, [calls.length])

  const connected = servers.filter((s) => s.installed)
  const live = new Set(sessions.filter((s) => s.endedAt === null).map((s) => s.serverId))
  const callsBy = new Map((stats?.byServer ?? []).map((s) => [s.serverId, s.calls]))
  const lastBy = new Map<string, number>()
  for (const call of calls) lastBy.set(call.serverId, Math.max(lastBy.get(call.serverId) ?? 0, call.startedAt))
  const recent = calls.slice(0, 8)
  const problems = (stats?.denied ?? 0) + (stats?.failed ?? 0)

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Overview</h1>
          <div className="sub">Your MCP servers and what your AI apps are doing with them.</div>
        </div>
      </div>
      <div className="content home-content">
        <div className="home-stats">
          <button className="home-stat" onClick={() => onNavigate('servers')}>
            <span>Servers through Bridge</span>
            <b>{connected.length}</b>
          </button>
          <button className="home-stat" onClick={() => onNavigate('servers')}>
            <span>Live now</span>
            <b>{live.size}</b>
          </button>
          <button className="home-stat" onClick={() => onNavigate('trace')}>
            <span>Calls, last 24 h</span>
            <b>{stats ? stats.last24h.toLocaleString() : '–'}</b>
          </button>
          <button className={`home-stat ${problems > 0 ? 'warn' : ''}`} onClick={() => onNavigate('trace')}>
            <span>Blocked or failed</span>
            <b>{stats ? problems.toLocaleString() : '–'}</b>
          </button>
        </div>

        <div className="home-columns">
          <section className="home-panel">
            <header>
              <h3>Servers</h3>
              <button className="btn ghost sm" onClick={() => onNavigate('servers')}>Manage</button>
            </header>
            {connected.length === 0 ? (
              <div className="home-empty">
                No server goes through Bridge yet.{' '}
                <button className="link" onClick={() => onNavigate('servers')}>Add or connect one</button>.
              </div>
            ) : (
              <ul className="home-list">
                {connected.map((server) => (
                  <li key={server.id}>
                    <span className={`live-dot ${live.has(server.id) ? '' : 'idle'}`} />
                    <b>{server.name}</b>
                    <span className="faint">{labels[server.client] ?? server.client}</span>
                    <span className="home-right faint">
                      {(callsBy.get(server.id) ?? 0).toLocaleString()} calls
                      {lastBy.has(server.id) ? ` · ${ago(lastBy.get(server.id)!)}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="home-panel">
            <header>
              <h3>Most used tools</h3>
            </header>
            {!stats || stats.byTool.length === 0 ? (
              <div className="home-empty">No tool has been called yet.</div>
            ) : (
              <ul className="home-list">
                {stats.byTool.slice(0, 6).map((tool) => (
                  <li key={tool.tool}>
                    <b className="mono">{tool.tool}</b>
                    <span className="home-right faint">
                      {tool.calls.toLocaleString()} · avg {tool.avgMs < 1000 ? `${tool.avgMs} ms` : `${(tool.avgMs / 1000).toFixed(1)} s`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <section className="home-panel">
          <header>
            <h3>Latest calls</h3>
            <button className="btn ghost sm" onClick={() => onNavigate('trace')}>
              All calls <IconChevron size={11} />
            </button>
          </header>
          {recent.length === 0 ? (
            <div className="home-empty">Nothing yet. Ask your AI app to use one of your servers and the call appears here.</div>
          ) : (
            <ul className="home-list">
              {recent.map((call) => (
                <li key={call.id} className={`call-line ${MARK[call.status].tone}`} onClick={() => onNavigate('trace')}>
                  <span className="call-mark">{MARK[call.status].mark}</span>
                  <span className="faint">{call.serverName} ›</span>
                  <b className="mono">{call.tool ?? call.method}</b>
                  <span className="home-right faint">{ago(call.startedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  )
}
