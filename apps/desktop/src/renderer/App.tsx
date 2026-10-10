import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApprovalRequest, ApprovalScope, CallRecord, ManagedServer } from '@shared/types'
import { api, onEvent } from './lib/api'
import { applyTheme, readTheme, watchSystemTheme, type Theme } from './lib/theme'
import { useRoute, type Tab } from './lib/router'
import { ApprovalModal } from './components/ApprovalModal'
import type { GrantSpec } from '@shared/action-grant'
import {
  IconBridge,
  IconGrid,
  IconLibrary,
  IconMoon,
  IconPulse,
  IconServer,
  IconSettings,
  IconSun,
} from './components/Icons'
import { LibraryPage } from './pages/LibraryPage'
import { OverviewPage } from './pages/OverviewPage'
import { PoliciesPage } from './pages/PoliciesPage'
import { ServersPage } from './pages/ServersPage'
import { SecurityPage } from './pages/SecurityPage'
import { SettingsPage } from './pages/SettingsPage'
import { ToolsPage } from './pages/ToolsPage'
import { CallsPage } from './pages/CallsPage'
import { HomePage } from './pages/HomePage'

const MAX_LIVE_ROWS = 500

export default function App(): JSX.Element {
  const { route, navigate, setParam } = useRoute()
  const tab = route.tab
  const [calls, setCalls] = useState<CallRecord[]>([])
  const [servers, setServers] = useState<ManagedServer[]>([])
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([])
  const [approvalError, setApprovalError] = useState<string | null>(null)
  const [sessionCount, setSessionCount] = useState(0)
  const [paused, setPaused] = useState(false)
  const [theme, setTheme] = useState<Theme>(readTheme)
  const [filters, setFilters] = useState({ serverId: '', flaggedOnly: false, search: '' })

  const pausedRef = useRef(paused)
  pausedRef.current = paused

  useEffect(() => {
    applyTheme(theme)
    if (theme !== 'system') return
    return watchSystemTheme(() => applyTheme('system'))
  }, [theme])

  const loadServers = useCallback(async () => {
    setServers(await api.invoke('servers:list'))
  }, [])

  const loadCalls = useCallback(async () => {
    setCalls(
      await api.invoke('calls:query', {
        limit: MAX_LIVE_ROWS,
        serverId: filters.serverId || undefined,
        flaggedOnly: filters.flaggedOnly || undefined,
        search: filters.search || undefined
      })
    )
  }, [filters.serverId, filters.flaggedOnly, filters.search])

  useEffect(() => {
    void loadCalls()
  }, [loadCalls])

  useEffect(() => {
    void loadServers()
    void api.invoke('approvals:pending').then(setApprovals)

    const poll = async (): Promise<void> => {
      setSessionCount((await api.invoke('servers:sessions')).length)
    }
    void poll()
    const timer = setInterval(() => void poll(), 5000)
    return () => clearInterval(timer)
  }, [loadServers])

  // Live stream: merge each call event into the list without a refetch.
  useEffect(() => {
    return onEvent((event) => {
      if (event.t === 'approval') {
        setApprovals((prev) => (prev.some((a) => a.id === event.request.id) ? prev : [...prev, event.request]))
        return
      }
      if (event.t === 'approval.resolved') {
        setApprovals((prev) => prev.filter((a) => a.id !== event.id))
        return
      }
      if (event.t !== 'trace') return

      const msg = event.event
      if (msg.t !== 'call.start' && msg.t !== 'call.end') return
      if (pausedRef.current) return

      const call = msg.call
      if (filters.serverId && call.serverId !== filters.serverId) return
      if (filters.flaggedOnly && call.findings.length === 0) return

      setCalls((prev) => {
        const idx = prev.findIndex((c) => c.id === call.id)
        if (idx === -1) return [call, ...prev].slice(0, MAX_LIVE_ROWS)
        const next = [...prev]
        next[idx] = call
        return next
      })
    })
  }, [filters.serverId, filters.flaggedOnly])

  /**
   * A decision that carries a scope can be refused — an invalid condition, a
   * credential pinned into it. The proxy is still holding the call in that
   * case, so the prompt stays open with the reason rather than dismissing and
   * leaving the user to guess whether their permission was created.
   */
  const resolveApproval = useCallback(
    (request: ApprovalRequest) =>
      async (effect: 'allow' | 'deny', scope: ApprovalScope, grant?: GrantSpec): Promise<void> => {
        setApprovalError(null)
        try {
          await api.invoke('approvals:resolve', { id: request.id, effect, scope, grant })
          setApprovals((prev) => prev.filter((a) => a.id !== request.id))
        } catch (err) {
          setApprovalError((err as Error).message || 'That decision could not be applied.')
        }
      },
    []
  )

  const current = approvals[0]

  // A refusal belongs to one prompt; moving to the next one clears it.
  useEffect(() => setApprovalError(null), [current?.id])

  /*
   * Five places: an overview, the servers Bridge connects, the Library to
   * find more, the calls going through them, and settings. The other pages
   * (security, coverage, tools, policies) are still reachable by URL but are not part of the everyday app.
   */
  const NAV: Array<{ id: Tab; label: string; icon: JSX.Element; also?: Tab[] }> = [
    { id: 'home', label: 'Overview', icon: <IconGrid size={15} /> },
    { id: 'servers', label: 'Servers', icon: <IconServer size={15} />, also: ['overview', 'tools'] },
    { id: 'library', label: 'Library', icon: <IconLibrary size={15} /> },
    { id: 'trace', label: 'Calls', icon: <IconPulse size={15} /> },
    { id: 'settings', label: 'Settings', icon: <IconSettings size={15} />, also: ['security', 'policy'] }
  ]

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">
          <IconBridge />
          Bridge
        </div>

        <div className="nav-group">
          {NAV.map((item) => (
            <button
              key={item.id}
              className="nav-item"
              aria-current={tab === item.id || !!item.also?.includes(tab)}
              onClick={() => navigate(item.id)}
            >
              {item.icon}
              {item.label}
              {item.id === 'trace' && approvals.length > 0 && <span className="count alert">{approvals.length}</span>}
            </button>
          ))}
        </div>

        <div className="sidebar-foot">
          <div className="row between">
            <span className="faint">
              <span className={`live-dot ${sessionCount > 0 ? '' : 'idle'}`} />
              {sessionCount > 0 ? `${sessionCount} live` : 'idle'}
            </span>
            <button
              className="btn ghost icon"
              title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            >
              {theme === 'dark' ? <IconSun size={14} /> : <IconMoon size={14} />}
            </button>
          </div>
          {approvals.length > 0 && (
            <div className="tag warn" style={{ marginTop: 8 }}>
              {approvals.length} awaiting approval
            </div>
          )}
        </div>
      </nav>

      <main className="main">
        {tab === 'policy' && <div className="workspace-tabs"><button onClick={() => navigate('security')}>← Security</button><span>Advanced permission rules</span></div>}
        {tab === 'home' && <HomePage calls={calls} servers={servers} onNavigate={(t) => navigate(t)} />}
        {tab === 'overview' && (
          <OverviewPage calls={calls} servers={servers} onNavigate={(t) => navigate(t)} />
        )}
        {tab === 'trace' && (
          <CallsPage
            calls={calls}
            paused={paused}
            onPaused={setPaused}
            search={filters.search}
            onSearch={(search) => setFilters({ ...filters, search })}
          />
        )}
        {tab === 'tools' && <ToolsPage servers={servers} />}
        {tab === 'servers' && <ServersPage servers={servers} onChanged={() => void loadServers()} />}
        {tab === 'library' && (
          <LibraryPage
            servers={servers}
            selectedKey={route.param}
            onSelect={setParam}
            onInstalled={() => void loadServers()}
          />
        )}
        {tab === 'policy' && <PoliciesPage servers={servers} />}
        {tab === 'security' && <SecurityPage onCoverage={() => navigate('overview')} onManage={() => navigate('servers')} onTrace={(id) => { setFilters({ serverId: '', flaggedOnly: false, search: '' }); navigate('trace', id) }} onRules={() => navigate('policy')} />}
        {tab === 'settings' && <SettingsPage theme={theme} onTheme={setTheme} />}
      </main>

      {current && <ApprovalModal request={current} queued={approvals.length} error={approvalError} onResolve={resolveApproval(current)} />}
    </div>
  )
}
