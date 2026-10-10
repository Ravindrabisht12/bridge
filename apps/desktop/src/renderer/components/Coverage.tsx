import { useState } from 'react'
import type { CoverageReport, CoverageState } from '@shared/coverage'
const LABELS: Record<CoverageState, string> = { active: 'Proxy active', configured: 'Awaiting session', direct: 'Not routed', broken: 'Needs repair' }

export function Coverage({ report, error, onManage }: { report: CoverageReport | null; error: boolean; onManage: () => void }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const visible = expanded ? report?.rows : report?.rows.slice(0, 4)
  return (
    <section className="card" aria-label="Monitoring coverage">
      <div className="card-head">
        <h3>Monitoring coverage</h3>
        <span className="spacer" />
        <button className="btn sm" onClick={onManage}>Manage connections</button>
      </div>
      <div className="card-body stack" style={{ gap: 12 }}>
        <div className="sub">Bridge inspects MCP calls routed through its proxy. Claude Code’s shell and file tools are covered separately, by the hook below. A browser session, a direct API call inside a script and unconnected integrations are outside this coverage.</div>
        {error ? <div role="status" className="tag warn">Coverage unavailable — monitoring is not confirmed.</div>
          : !report ? <div role="status">Checking configured connections…</div>
          : <>
            {report.unreadableClients.length > 0 && <div className="tag warn">Could not read configuration: {report.unreadableClients.join(', ')}. Coverage is unknown for these clients.</div>}
            {report.rows.length > 0 && <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>{(Object.keys(LABELS) as CoverageState[]).map((state) =>
              <span key={state} className="tag"><b>{report.rows.filter((row) => row.state === state).length}</b> {LABELS[state]}</span>
            )}</div>}
            {report.rows.length === 0 ? <div>No supported MCP connections were found in readable client configs. This does not mean no agents or tools are running.</div> :
              <table className="table">
                <thead><tr><th>Client / server</th><th>Observed state</th><th>What this means</th></tr></thead>
                <tbody>{visible?.map((row) => <tr key={`${row.client}:${row.name}`}>
                  <td>{row.client}<div className="sub">{row.name}</div></td>
                  <td><span className={`tag ${row.state === 'active' ? 'info' : row.state === 'configured' ? '' : 'warn'}`}>{LABELS[row.state]}</span></td>
                  <td className="sub">{row.detail}</td>
                </tr>)}</tbody>
              </table>}
            {report.rows.length > 4 && <button className="btn sm" style={{ alignSelf: 'flex-start' }} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? 'Show fewer connections' : `Show all ${report.rows.length} connections`}</button>}
            <details>
              <summary>Credential configuration and integration concerns</summary>
              <div className="sub">These are observed configuration facts, not a certification that a tool is safe. Configured credentials are available to the integration; Bridge cannot prove which credential it used for a particular call.</div>
              {report.integrations?.map((integration) => <div key={integration.serverId} style={{ marginTop: 12 }}>
                <b>{integration.name}</b> · {integration.transport}
                <div>Credential-like fields: {integration.credentialFields.join(', ') || 'None detected in managed configuration'}</div>
                <ul>{integration.concerns.map((concern) => <li key={concern}>{concern}</li>)}</ul>
              </div>)}
            </details>
            <div className="faint">Checked {new Date(report.checkedAt).toLocaleTimeString()}. Client identity is configuration/session attribution, not proof of who is operating it. Other client configurations may not be discovered.</div>
          </>}
      </div>
    </section>
  )
}
