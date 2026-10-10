import { useEffect, useState } from 'react'
import type { ApprovalRequest, ApprovalScope, ToolRecord } from '@shared/types'
import type { GrantSpec } from '@shared/action-grant'
import { classifyTool } from '@shared/toolrisk'
import { pretty } from '../lib/format'
import { api } from '../lib/api'
import { FindingList } from './Findings'
import { IconShield } from './Icons'
import { GrantScope, initialGrantSpec } from './GrantScope'

interface Props {
  request: ApprovalRequest
  queued: number
  onResolve: (effect: 'allow' | 'deny', scope: ApprovalScope, grant?: GrantSpec) => void
  /** Set when the last attempt to save a scope was refused. */
  error?: string | null
}

const SCOPES: Array<{ value: ApprovalScope; label: string }> = [
  { value: 'once', label: 'Just this time' },
  { value: 'session', label: 'This session' },
  { value: 'always', label: 'Always' }
]

export function ApprovalModal({ request, queued, onResolve, error }: Props): JSX.Element {
  const [scope, setScope] = useState<ApprovalScope>('once')
  const [withGrant, setWithGrant] = useState(false)
  const [spec, setSpec] = useState<GrantSpec>(() => initialGrantSpec(request.tool, request.args))
  const [tools, setTools] = useState<readonly string[]>([])
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, Math.round((request.requestedAt + request.timeoutMs - Date.now()) / 1000))
  )

  useEffect(() => {
    setScope('once')
    setWithGrant(false)
    setSpec(initialGrantSpec(request.tool, request.args))
  }, [request.id, request.tool, request.args])

  // The other tools on this server, so one decision can cover a whole task.
  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const records: ToolRecord[] = await api.invoke('servers:tools', request.serverId)
        if (active) setTools(records.filter((record) => record.enabled).map((record) => record.name))
      } catch {
        if (active) setTools([])
      }
    })()
    return () => {
      active = false
    }
  }, [request.serverId])

  useEffect(() => {
    const tick = setInterval(() => {
      setRemaining(Math.max(0, Math.round((request.requestedAt + request.timeoutMs - Date.now()) / 1000)))
    }, 1000)
    return () => clearInterval(tick)
  }, [request.id, request.requestedAt, request.timeoutMs])

  // Escape blocks. Enter is deliberately unbound — allowing must be a real click.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onResolve('deny', 'once')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onResolve])

  const cap = classifyTool(request.tool)
  // A credential gate is an individual decision by definition; it cannot mint a
  // permission that outlives this one call.
  const canGrant = !request.onceOnly

  return (
    <div className="scrim" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="modal-head">
          <div className="row" style={{ gap: 8 }}>
            <IconShield />
            <h2>Approve this tool call?</h2>
          </div>
          <div className="sub">
            <b className="mono">{request.tool}</b> from {request.serverName}
            {queued > 1 && <> · {queued - 1} more waiting</>}
          </div>
          <div className="row" style={{ gap: 6, marginTop: 8 }}>
            <span className={`tag cap-${cap.capability}`}>{cap.label}</span>
            {request.findings.length > 0 && (
              <span className="tag danger">
                {request.findings.length} {request.findings.length === 1 ? 'finding' : 'findings'}
              </span>
            )}
          </div>
        </div>

        <div className="modal-body">
          {error && (
            <div role="alert" className="security-error">
              {error}
            </div>
          )}

          {request.findings.length > 0 && (
            <>
              <div className="section">Why you are being asked</div>
              <FindingList findings={request.findings} />
            </>
          )}

          {/* With a scope open, the conditions below show these same values in
              the form that actually matters, so the raw block folds away rather
              than pushing the decision off screen. */}
          {withGrant ? (
            <details className="modal-args">
              <summary>Arguments it will send</summary>
              <pre className="code">{pretty(request.args)}</pre>
            </details>
          ) : (
            <>
              <div className="section">Arguments it will send</div>
              <pre className="code">{pretty(request.args)}</pre>
            </>
          )}

          {canGrant ? (
            <>
              <div className="section">Give it a scope</div>
              <label className="grant-toggle">
                <input
                  type="checkbox"
                  checked={withGrant}
                  onChange={(e) => setWithGrant(e.target.checked)}
                />
                <span>
                  <b>Allow this and similar calls inside a limited scope</b>
                  <small>
                    Bounded by argument, time and count, revocable at any point. Anything outside
                    the scope still needs a decision.
                  </small>
                </span>
              </label>

              {withGrant ? (
                <GrantScope
                  tool={request.tool}
                  availableTools={tools}
                  value={spec}
                  onChange={setSpec}
                />
              ) : (
                <>
                  <div className="section">Remember this decision</div>
                  <div className="segmented">
                    {SCOPES.map((s) => (
                      <button key={s.value} aria-pressed={scope === s.value} onClick={() => setScope(s.value)}>
                        {s.label}
                      </button>
                    ))}
                  </div>
                  {scope === 'always' && (
                    <div className="faint" style={{ marginTop: 8 }}>
                      This becomes an unbounded rule with no expiry. A scope above is narrower and
                      can be revoked; use this only for a tool you always want allowed.
                    </div>
                  )}
                </>
              )}
            </>
          ) : (
            <div className="faint" style={{ marginTop: 8 }}>
              Approval applies only to this exact pending call. A credential-shaped argument cannot
              create a reusable permission, so another call — even to the same recipient — needs a
              fresh decision. Detected credentials are masked. The initiating task and human
              identity are not verified.
            </div>
          )}
        </div>

        <div className="modal-foot">
          <button
            className="btn danger"
            onClick={() => onResolve('deny', request.onceOnly ? 'once' : scope)}
          >
            Block
          </button>
          <span className="spacer" />
          <span className="faint mono">{remaining > 0 ? `blocks in ${remaining}s` : 'expired'}</span>
          <button
            className="btn primary"
            onClick={() =>
              onResolve(
                'allow',
                request.onceOnly ? 'once' : withGrant ? 'once' : scope,
                canGrant && withGrant ? spec : undefined
              )
            }
          >
            {canGrant && withGrant ? 'Allow with this scope' : 'Allow'}
          </button>
        </div>
      </div>
    </div>
  )
}
