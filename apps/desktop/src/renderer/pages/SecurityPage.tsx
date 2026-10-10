import { summarizeArgs, timeOf } from '../lib/format'
import { IconShield, IconPulse } from '../components/Icons'
import { type ActionGrant, describeConstraint } from '@shared/action-grant'
import { useEffect, useState } from 'react'
import type { CoverageReport } from '@shared/coverage'
import type { CallRecord, Settings } from '@shared/types'
import { api, onEvent } from '../lib/api'
import { securitySignals } from '@shared/security-signals'
import type { HookStatus } from '@shared/hook'

export function SecurityPage({ onManage, onCoverage, onTrace, onRules }: { onManage: () => void; onCoverage: () => void; onTrace: (callId?: string) => void; onRules: () => void }): JSX.Element {
  const [view, setView] = useState<'activity' | 'investigate' | 'permissions'>('activity')
  const [selectedSignal, setSelectedSignal] = useState<string | null>(null)
  const [grants, setGrants] = useState<ActionGrant[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)
  const [report, setReport] = useState<CoverageReport | null>(null)
  const [hook, setHook] = useState<HookStatus | null>(null)
  const [calls, setCalls] = useState<CallRecord[]>([])
  const [error, setError] = useState(false)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(false)
  /*
   * Two refreshes, on two different clocks.
   *
   * Activity is the half a user watches while an agent works, so it follows the
   * live event stream — a five-second poll meant a blocked call sat invisible
   * for up to five seconds while Trace already showed it. Coverage stays on a
   * timer because reading it walks every AI client's config file and Claude
   * Code's settings; doing that per tool call would put filesystem work on the
   * hot path of an agent's loop.
   *
   * An event is a signal to re-read, never the data itself. The proxy writes a
   * call to SQLite before it announces it, and the copy on the control socket
   * has redacted payloads while the stored row does not — merging the event
   * would quietly downgrade an argument preview the database can render fully.
   */
  useEffect(() => {
    let active = true
    let queued: ReturnType<typeof setTimeout> | null = null

    /** Two indexed SQLite reads. Cheap enough to run on a burst of activity. */
    const refreshActivity = async (): Promise<void> => {
      try {
        const [nextCalls, nextGrants] = await Promise.all([
          api.invoke('calls:query', { limit: 500 }), api.invoke('security:grants')
        ])
        if (!active) return
        setCalls(nextCalls); setGrants(nextGrants); setUpdatedAt(Date.now()); setError(false)
      } catch { if (active) setError(true) }
    }

    /** Touches client configs and Claude Code's settings; stays on the timer. */
    const refreshCoverage = async (): Promise<void> => {
      try {
        const [nextSettings, nextReport, nextHook] = await Promise.all([
          api.invoke('settings:get'), api.invoke('security:coverage'), api.invoke('hook:status')
        ])
        if (!active) return
        setSettings(nextSettings); setReport(nextReport); setHook(nextHook)
      } catch { if (active) setError(true) }
    }

    void refreshActivity()
    void refreshCoverage()
    const timer = setInterval(() => { void refreshActivity(); void refreshCoverage() }, 5000)

    // Coalesced: one re-read per burst, not one per call in a busy agent loop.
    const stop = onEvent((event) => {
      const relevant =
        event.t === 'approval' ||
        event.t === 'approval.resolved' ||
        (event.t === 'trace' && (event.event.t === 'call.start' || event.event.t === 'call.end'))
      if (!relevant) return
      if (queued) clearTimeout(queued)
      queued = setTimeout(() => { queued = null; void refreshActivity() }, 120)
    })

    return () => {
      active = false
      clearInterval(timer)
      if (queued) clearTimeout(queued)
      stop()
    }
  }, [])
  const patch = async (change: Partial<Settings>): Promise<void> => {
    setSaving(true)
    setSaveError(false)
    try { setSettings(await api.invoke('settings:set', change)) }
    catch { setSaveError(true) }
    finally { setSaving(false) }
  }
  const now = Date.now()
  const signals = securitySignals(calls, now)
  const recent = calls.filter((call) => call.startedAt >= now - 900_000)
  const activeGrants = grants.filter((grant) => !grant.revokedAt && grant.expiresAt > now && grant.remaining > 0)
  const activeConnections = report?.rows.filter((row) => row.state === 'active').length ?? 0
  const hookLive = !!hook?.installed && !!settings?.claudeCodeHook
  // Account activity is never collected, so this can never read as complete.
  const coverageLabel = !activeConnections && !hookLive ? 'None' : 'Partial'
  const blocked = recent.filter((call) => call.status === 'denied').length
  const completed = recent.filter((call) => call.status === 'completed').length
  const pending = recent.filter((call) => call.status === 'awaiting-approval').length
  /** Whether anything at all is routed through Bridge right now. */
  const watching = activeConnections > 0 || hookLive
  /* Naming what is actually covered. "MCP coverage only" was printed even with
     nothing connected, which read as a reassurance the rail contradicted. */
  const coverageChip = !watching
    ? 'Nothing routed through Bridge'
    : activeConnections && hookLive
      ? 'MCP + Claude Code tools'
      : hookLive
        ? 'Claude Code tools only'
        : 'MCP coverage only'

  /*
   * The hero is the only summary on this page.
   *
   * It used to compete with a coverage nudge and three metric cards, each
   * repeating a number that was already on screen — the investigations and
   * permissions counts sit on their own tabs, and the blocked count was in this
   * very sentence. Saying it once and saying it precisely is worth more than
   * saying it three times.
   */
  /*
   * Recorded activity outranks coverage state.
   *
   * A client can close — ending its proxy session — while its calls from the
   * last fifteen minutes are still listed below. Leading with "not watching
   * anything" there would contradict the list on the same screen, so the
   * coverage-gap headline only speaks when there is genuinely nothing to say.
   */
  const headline = error
    ? 'Visibility needs attention.'
    : settings?.pauseToolCalls
      ? 'New tool calls are paused.'
      : signals.length
        ? `${signals.length} ${signals.length === 1 ? 'signal needs' : 'signals need'} your review.`
        : pending
          ? `${pending} ${pending === 1 ? 'call is' : 'calls are'} waiting on you.`
          : recent.length
            ? `${recent.length} tool ${recent.length === 1 ? 'call' : 'calls'} in the last 15 minutes.`
            : watching
              ? 'No recent AI tool activity observed.'
              : 'Bridge is not watching anything yet.'

  const summary = error
    ? 'The view may be stale, so the state below is not confirmed.'
    : signals.length
      ? 'High-severity findings or repeated blocked attempts. Open Investigations to see which actions triggered them.'
      : recent.length
        ? `${blocked} blocked · ${completed} completed${activeGrants.length ? ` · ${activeGrants.length} active ${activeGrants.length === 1 ? 'permission' : 'permissions'}` : ''}.${watching ? '' : ' No connection is routed through Bridge now, so nothing new can be observed.'} Select an action below to inspect its arguments and decision.`
        : watching
          ? 'Coverage is on but nothing has run. Ask your AI client to use a connected tool and its actions appear here.'
          : 'No MCP connection is routed through Bridge and the Claude Code hook is not enforcing, so no AI tool activity can be observed or decided.'
  return <>
    <div className="topbar"><div><h1>Security</h1><div className="sub">See what ran, what was blocked, and what needs your decision.</div></div><span className="spacer" /><span className="security-freshness"><span className={`live-dot ${error || !activeConnections ? 'idle' : ''}`} />{error ? 'Refresh unavailable' : updatedAt ? `Live · updated ${new Date(updatedAt).toLocaleTimeString()}` : 'Connecting…'}</span></div>
    <div className="content security-workspace">
      {error && <div role="alert" className="security-error">Security data could not refresh. The view may be stale.</div>}
      {saveError && <div role="alert" className="security-error">Change not confirmed. Check the current state before relying on it.</div>}
      <section className="security-banner">
        <div className="security-banner-copy">
          <span className="security-eyebrow">AI ACTIVITY CONTROL</span>
          <h2>{headline}</h2>
          <p>{summary}</p>
          <div className="security-banner-status"><IconShield size={15} /><span>{settings ? settings.pauseToolCalls ? 'Routed tool calls paused' : 'Routed tool calls enabled' : 'Loading controls…'}</span><span className="security-status-divider" />{coverageChip}</div>
          {!watching && !error && !recent.length && <button className="btn sm" onClick={onCoverage}>Set up coverage →</button>}
        </div>
        <div className="security-banner-action"><button className="security-pause" aria-label={settings?.pauseToolCalls ? 'Resume tool calls' : 'Pause tool calls'} disabled={!settings || saving || error} onClick={() => void patch({ pauseToolCalls: !settings?.pauseToolCalls })}>{settings?.pauseToolCalls ? 'Resume tool calls' : 'Pause tool calls'} <span aria-hidden="true">{settings?.pauseToolCalls ? '→' : 'Ⅱ'}</span></button><small>New routed calls and pending approvals.<br />Already dispatched actions may finish.</small></div>
      </section>
      <div className="security-columns">
        <section className="security-panel security-investigations">
          <div className="security-panel-head"><div className="security-tabs" aria-label="Security views"><button aria-pressed={view === 'activity'} onClick={() => setView('activity')}>Activity <span>{recent.length}</span></button><button aria-pressed={view === 'investigate'} onClick={() => setView('investigate')}>Investigations <span>{signals.length}</span></button><button aria-pressed={view === 'permissions'} onClick={() => setView('permissions')}>Permissions <span>{activeGrants.length}</span></button></div><button className="btn ghost sm" onClick={() => onTrace()}>Open trace ↗</button></div>
          {view === 'activity' ? <div>{!recent.length ? <div className="security-empty"><h3>No recorded actions in the last 15 minutes</h3><p>After connecting a tool, ask your AI client to use it. This list will show which client called which tool and whether Bridge allowed it.</p><button className="btn" onClick={onManage}>Connect a tool</button></div> : recent.slice(0, 12).map((call) => <button className="security-activity-row" key={call.id} onClick={() => onTrace(call.id)}><span className={`activity-outcome ${call.status === 'denied' ? 'blocked' : call.status === 'awaiting-approval' ? 'pending' : ''}`}>{call.status === 'denied' ? 'Blocked' : call.status === 'completed' ? 'Completed' : call.status === 'awaiting-approval' ? 'Needs approval' : call.status === 'permitted' ? 'Permitted' : call.status}</span><span className="security-activity-main"><b>{call.client} → {call.tool ?? call.method}</b><small>{call.serverName} · {summarizeArgs(call) || 'No argument preview'}</small></span><time>{timeOf(call.startedAt)}</time><span aria-hidden="true">↗</span></button>)}<div className="security-panel-note">Most recent 12 actions in this window · click an action for its evidence</div></div> : view === 'investigate' ? <>
            {signals.length === 0 ? <div className="security-empty"><div className="security-empty-icon"><IconPulse size={28} /></div><h3>{error ? 'Investigation data unavailable' : recent.length ? 'No signals in this window' : 'Your next investigation starts here'}</h3><p>{recent.length ? 'No high-severity findings or repeated denials in the recent records. This does not establish that your system is safe.' : 'Once a connected tool runs, Bridge can surface credential findings, changed tool definitions and repeated blocked attempts.'}</p><button className="btn" onClick={onManage}>Review connected tools →</button></div> : <div className="security-incident-list">{signals.map((signal) => <article key={signal.id} className={`security-incident ${selectedSignal === signal.id ? 'expanded' : ''}`}><button className="security-incident-trigger" aria-expanded={selectedSignal === signal.id} onClick={() => setSelectedSignal(selectedSignal === signal.id ? null : signal.id)}><span className="security-incident-mark">!</span><span><b>{signal.title}</b><small>{signal.callIds.length} recorded {signal.callIds.length === 1 ? 'action' : 'actions'} · review suggested</small></span><span className="spacer" /><span aria-hidden="true">{selectedSignal === signal.id ? '−' : '+'}</span></button>{selectedSignal === signal.id && <div className="security-incident-evidence"><span className="security-eyebrow">OBSERVED EVIDENCE</span><p>{signal.evidence}</p><span className="security-eyebrow">NEXT ACTION</span><p>{signal.action}</p><button className="btn sm" onClick={() => onTrace(signal.callIds[0])}>Inspect recorded calls ↗</button></div>}</article>)}</div>}
            <div className="security-panel-note">15-minute window · up to 500 recent calls · signals are not confirmed breaches</div>
          </> : <div className="security-permissions">{grants.length === 0 ? <div className="security-empty"><div className="security-empty-icon"><IconShield size={28} /></div><h3>Access with an expiry date</h3><p>When you approve a call, tick “allow inside a limited scope” to authorise the rest of the task without a prompt for each step. Scopes are bounded by argument, time and count, and you revoke them here.</p><button className="btn" onClick={() => onTrace()}>Choose a recorded call →</button></div> : <>{grants.map((grant) => {
            const live = !grant.revokedAt && grant.expiresAt > now && grant.remaining > 0
            const state = grant.revokedAt ? 'Revoked' : grant.expiresAt <= now ? 'Expired' : 'Used up'
            const pinned = grant.constraints.filter((constraint) => constraint.op !== 'any')
            return <div className={`security-permission ${live ? '' : 'spent'}`} key={grant.id}>
              <div>
                <b>{grant.tools.join(', ')}</b>
                <small>{live ? `${grant.remaining} ${grant.remaining === 1 ? 'call' : 'calls'} left · expires ${new Date(grant.expiresAt).toLocaleTimeString()}` : state}</small>
                <small>{pinned.length ? pinned.map(describeConstraint).join(' · ') : 'Any arguments to these tools'}</small>
                <small className="mono">{grant.sessionId ? `Bound to session ${grant.sessionId}` : 'Survives a client restart'}</small>
              </div>
              {live && <button className="btn sm danger" onClick={() => void (async () => { try { await api.invoke('security:revoke', grant.id); setGrants(await api.invoke('security:grants')) } catch { setSaveError(true) } })()}>Revoke</button>}
            </div>
          })}<div className="security-panel-note">Each permission is bounded by argument, time and remaining uses · revoking stops the next call, not one already sent</div></>}</div>}
        </section>
        <aside className="security-rail">
          {/*
            Two controls, both about the decision in front of the user. Setting
            coverage up is configuration and lives on MCP · Coverage; this only
            reports what is covered right now and links there.
          */}
          <section className="security-panel"><div className="security-panel-head"><h3>Permission mode</h3><IconShield size={16} /></div><div className="security-rail-body"><label className="security-mode"><span><b>Review before execution</b><small>Ask unless a scoped permission covers the call</small></span><input type="checkbox" role="switch" aria-label="Require approval unless a scoped permission applies" disabled={!settings || saving || error} checked={settings?.strictActionApproval ?? true} onChange={(e) => void patch({ strictActionApproval: e.target.checked })} /></label><button className="btn ghost sm" onClick={onRules}>Advanced permission rules →</button></div></section>
          <button className="security-panel security-coverage" onClick={onCoverage} aria-label="Open coverage settings">
            <span className="security-panel-head"><h3>Coverage</h3><span className="tag">{coverageLabel}</span></span>
            <span className="security-coverage-row"><span className={`security-source-dot ${activeConnections ? 'available' : ''}`} /><b>MCP tools</b><span>{error ? 'unavailable' : activeConnections ? `${activeConnections} connected` : 'none connected'}</span></span>
            <span className="security-coverage-row"><span className={`security-source-dot ${hookLive ? 'available' : ''}`} /><b>Shell &amp; files</b><span>{hookLive ? 'enforcing' : hook?.installed ? 'not enforcing' : 'not set up'}</span></span>
            <span className="security-coverage-row"><span className="security-source-dot" /><b>Accounts</b><span>not connected</span></span>
            <span className="security-coverage-foot">Set up coverage →</span>
          </button>
        </aside>
      </div>
    </div>
  </>
}
