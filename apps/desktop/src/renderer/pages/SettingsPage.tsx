import { useEffect, useState } from 'react'
import type { Settings } from '@shared/types'
import type { ClientStatusDto } from '@shared/ipc'
import { api } from '../lib/api'
import type { Theme } from '../lib/theme'

interface Props { theme: Theme; onTheme: (theme: Theme) => void }
type Section = 'general' | 'privacy' | 'advanced'

export function SettingsPage({ theme, onTheme }: Props): JSX.Element {
  const [section, setSection] = useState<Section>('general')
  const [settings, setSettings] = useState<Settings | null>(null)
  const [info, setInfo] = useState<{ version: string; home: string; socket: string; proxyPath: string } | null>(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [source, setSource] = useState('')
  const [clients, setClients] = useState<ClientStatusDto[]>([])
  useEffect(() => {
    let active = true
    void Promise.all([api.invoke('settings:get'), api.invoke('app:info'), api.invoke('clients:status')]).then(([next, details, found]) => {
      if (active) { setSettings(next); setSource(next.catalogueSourceUrl); setInfo(details); setClients(found) }
    }).catch(() => { if (active) { setError(true); setNotice('Settings could not load. Reopen this page to retry.') } })
    return () => { active = false }
  }, [])
  const run = async (operation: () => Promise<unknown>, message: string): Promise<void> => {
    setBusy(true); setNotice(''); setError(false)
    try { await operation(); setNotice(message) } catch { setError(true); setNotice('The change was not confirmed. Please try again.') }
    finally { setBusy(false) }
  }
  // Unlike other settings this rewrites a client's config, and the reason it
  // can fail (a foreign "bridge" entry, an unreadable file) is worth showing.
  const setGateway = (client: ClientStatusDto, enabled: boolean): void => {
    setBusy(true); setNotice(''); setError(false)
    api.invoke('gateway:set', { client: client.id, enabled })
      .then((next) => { setSettings(next); setNotice(`${client.label} updated. Restart it to pick up the change.`) })
      .catch((err: Error) => { setError(true); setNotice(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')) })
      .finally(() => setBusy(false))
  }
  const patch = (change: Partial<Settings>): void => { void run(async () => setSettings(await api.invoke('settings:set', change)), 'Saved') }
  const toggle = (key: 'launchAtLogin' | 'scanInjection' | 'scanSecrets' | 'askOnToolChange' | 'redactOnFinding' | 'annotateRepeats', label: string, detail: string): JSX.Element => <label className="preference-row"><span><b>{label}</b><small>{detail}</small></span><input type="checkbox" disabled={busy} checked={settings?.[key] ?? false} onChange={(e) => patch({ [key]: e.target.checked })} /></label>
  return <>
    <div className="topbar"><div><h1>Settings</h1><div className="sub">Choose what Bridge stores and how it behaves.</div></div></div>
    <nav className="workspace-tabs" aria-label="Settings sections">{(['general', 'privacy', 'advanced'] as const).map((name) => <button key={name} aria-current={section === name ? 'page' : undefined} onClick={() => { setSection(name); setConfirmDelete(false) }}>{name === 'general' ? 'General' : name === 'privacy' ? 'Privacy & history' : 'Advanced'}</button>)}</nav>
    <div className="content preferences-content">
      {notice && <div role={error ? 'alert' : 'status'} className={`preference-notice ${error ? 'failed' : ''}`}>{notice}</div>}
      {!settings ? <p>{error ? 'Settings unavailable.' : 'Loading settings…'}</p> : <>
        {section === 'general' && <>
          <header className="preference-heading"><h2>Make yourself at home.</h2><p>Appearance and startup. Security permissions live on the Security page.</p></header>
          <section className="preference-group"><div className="preference-row"><span><b>Appearance</b><small>Use a theme that suits your workspace.</small></span><div className="segmented">{(['light', 'dark', 'system'] as const).map((choice) => <button key={choice} aria-pressed={theme === choice} onClick={() => onTheme(choice)}>{choice[0]!.toUpperCase() + choice.slice(1)}</button>)}</div></div>{toggle('launchAtLogin', 'Start at login', 'Open Bridge when you sign in to your computer.')}</section>
          <div className="preference-foot">Bridge {info?.version ?? ''} · Local desktop app</div>
        </>}
        {section === 'privacy' && <>
          <header className="preference-heading"><h2>Your recorded data.</h2><p>Control future trace storage and delete existing history.</p></header>
          <section className="preference-group"><div className="preference-row"><span><b>What to save</b><small>Metadata keeps tool names, timing, decisions and findings. Payloads may contain personal or business data.</small></span><select aria-label="What to save" className="select" disabled={busy} value={settings.storePayloads ? 'payloads' : 'metadata'} onChange={(e) => patch({ storePayloads: e.target.value === 'payloads' })}><option value="metadata">Metadata only</option><option value="payloads">Metadata + request / response</option></select></div><div className="preference-row"><span><b>History retention</b><small>Older records are removed by scheduled cleanup.</small></span><select aria-label="History retention" className="select" disabled={busy} value={settings.retentionDays} onChange={(e) => patch({ retentionDays: Number(e.target.value) })}>{[7,30,90,0].map((days) => <option key={days} value={days}>{days ? `${days} days` : 'Keep until deleted'}</option>)}</select></div><div className="preference-explanation">Changing storage mode affects future records. Existing payloads remain until deleted or removed by retention cleanup. Metadata can also reveal sensitive activity.</div></section>
          <section className="preference-group"><h3>Where the data goes</h3><dl className="privacy-facts"><dt>Trace history</dt><dd>Stored in Bridge’s local database. Detected secrets are masked; detection can miss values.</dd><dt>Tool requests</dt><dd>Sent to the connected server when allowed. That provider has its own data practices.</dd><dt>Library searches</dt><dd>Sent to your configured catalogue service when remote search is used.</dd><dt>Credential storage</dt><dd>Configured credentials are not yet protected by an encrypted Bridge vault.</dd></dl></section>
          <section className="preference-group"><div className="preference-row"><span><b>Delete recorded calls</b><small>Removes call records and their stored payloads. Logs, exported files and credentials are separate.</small></span><button className="btn danger" disabled={busy} onClick={() => setConfirmDelete(true)}>Delete history…</button></div>{confirmDelete && <div className="preference-confirm"><p>Delete all locally recorded calls? This cannot be undone.</p><button className="btn danger" disabled={busy} onClick={() => void run(async () => { await api.invoke('calls:purge', 0); setConfirmDelete(false) }, 'Recorded calls deleted')}>Delete recorded calls</button><button className="btn ghost" disabled={busy} onClick={() => setConfirmDelete(false)}>Cancel</button></div>}</section>
        </>}
        {section === 'advanced' && <>
          <header className="preference-heading"><h2>Advanced controls.</h2><p>Inspection, fallback policy and troubleshooting. These settings affect routed MCP calls.</p></header>
          <details className="preference-group"><summary>Inspection</summary>{toggle('scanInjection', 'Flag prompt-injection patterns', 'Look for suspicious instructions in tool results.')}{toggle('scanSecrets', 'Scan for credentials', 'Inspect arguments and results. Separate credential gates can still run when this is off.')}{toggle('askOnToolChange', 'Review changed tool definitions', 'Ask again when a tool definition changes.')}{toggle('redactOnFinding', 'Filter flagged result content', 'Apply supported redaction before results reach the model. This may change output.')}<div className="preference-explanation">Heuristic findings are investigation signals, not proof of a breach.</div></details>
          <details className="preference-group"><summary>Context for the model</summary><div className="preference-row"><span><b>Trim large results</b><small>Cut tool results above this size before they reach the model. The trace keeps what the server sent.</small></span><select aria-label="Trim large results" className="select" disabled={busy} value={settings.maxResultTokens} onChange={(e) => patch({ maxResultTokens: Number(e.target.value) })}><option value={0}>Never</option><option value={10000}>Above ~10k tokens</option><option value={25000}>Above ~25k tokens</option><option value={50000}>Above ~50k tokens</option></select></div>{toggle('annotateRepeats', 'Point out repeated calls', 'After three identical calls with an identical result, add a note telling the model it is going in circles.')}<div className="preference-explanation">Both change what the model sees. Each call that was changed says so in its trace.</div></details>
          <details className="preference-group"><summary>One Bridge entry per client</summary><div className="preference-explanation">Replace a client's separate server entries with a single “bridge” entry that runs them all. Policy, approvals and the trace work the same. Servers that rely on MCP resources, prompts or sampling should stay as separate entries.</div><div className="preference-row"><span><b>How tools are shown</b><small>Search lists two tools, search_tools and call_tool, and the model looks up what it needs, so dozens of servers cost almost no context.</small></span><select aria-label="How tools are shown" className="select" disabled={busy} value={settings.gatewayToolMode} onChange={(e) => patch({ gatewayToolMode: e.target.value as Settings['gatewayToolMode'] })}><option value="auto">Search above 40 tools</option><option value="search">Always search</option><option value="all">List every tool</option></select></div>{clients.filter((c) => c.present && c.gatewayCapable).map((client) => <label key={client.id} className="preference-row"><span><b>{client.label}</b><small>{settings.gatewayClients.includes(client.id) ? 'One “bridge” entry runs every server Bridge has connected here.' : `${client.serverCount} separate entr${client.serverCount === 1 ? 'y' : 'ies'} in its config.`}</small></span><input type="checkbox" disabled={busy} checked={settings.gatewayClients.includes(client.id)} onChange={(e) => setGateway(client, e.target.checked)} /></label>)}</details>
          <details className="preference-group"><summary>Approval rules and fallbacks</summary><div className="preference-row"><span><b>Unmatched calls</b><small>Strict mode can still require approval over an allow fallback.</small></span><select aria-label="Unmatched calls" className="select" disabled={busy} value={settings.defaultEffect} onChange={(e) => patch({ defaultEffect: e.target.value as Settings['defaultEffect'] })}><option value="allow">Allow</option><option value="ask">Ask</option><option value="deny">Block</option></select></div><div className="preference-row"><span><b>UI unavailable</b><small>Strict and credential approvals always block without an answer. This fallback applies to ordinary policy mode.</small></span><select aria-label="UI unavailable" className="select" disabled={busy} value={settings.offlineAskFallback} onChange={(e) => patch({ offlineAskFallback: e.target.value as 'allow' | 'deny' })}><option value="deny">Block</option><option value="allow">Allow</option></select></div><div className="preference-row"><span><b>Possible outgoing credentials</b><small>High-confidence findings override allow decisions.</small></span><select aria-label="Outgoing credentials" className="select" disabled={busy} value={settings.credentialAction} onChange={(e) => patch({ credentialAction: e.target.value as Settings['credentialAction'] })}><option value="ask">Ask for this call</option><option value="deny">Block</option><option value="flag">Flag only</option></select></div><div className="preference-row"><span><b>Approval timeout</b></span><select aria-label="Approval timeout" className="select" disabled={busy} value={settings.approvalTimeoutMs} onChange={(e) => patch({ approvalTimeoutMs: Number(e.target.value) })}><option value={30000}>30 seconds</option><option value={120000}>2 minutes</option><option value={300000}>5 minutes</option></select></div></details>
          <details className="preference-group"><summary>Catalogue service</summary><div className="preference-explanation"><label htmlFor="catalogue-source">Service URL</label><div className="row" style={{ gap: 8, marginTop: 8 }}><input id="catalogue-source" className="input" value={source} onChange={(e) => setSource(e.target.value)} /><button className="btn" disabled={busy} onClick={() => patch({ catalogueSourceUrl: source.trim() })}>Save</button></div><p>Leave blank to use the saved library offline.</p><div className="row" style={{ gap: 8 }}><button className="btn" disabled={busy} onClick={() => void run(() => api.invoke('catalogue:reseed'), 'Featured picks restored')}>Restore featured picks</button><button className="btn" disabled={busy} onClick={() => void run(() => api.invoke('catalog:sync', true), 'Catalogue sync request completed')}>Re-sync library</button></div></div></details>
          <details className="preference-group"><summary>Diagnostics</summary><div className="preference-explanation"><dl className="kv"><dt>Version</dt><dd>{info?.version}</dd><dt>Data directory</dt><dd className="mono">{info?.home}</dd><dt>Control socket</dt><dd className="mono">{info?.socket}</dd><dt>Proxy</dt><dd className="mono">{info?.proxyPath}</dd></dl><button className="btn" onClick={() => void run(() => api.invoke('app:revealLogs'), 'Log folder requested')}>Open logs</button></div></details>
        </>}
      </>}
    </div>
  </>
}
