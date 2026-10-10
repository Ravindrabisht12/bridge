import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import type { CallRecord, ToolRecord } from '@shared/types'
import type { GrantSpec } from '@shared/action-grant'
import { classifyTool } from '@shared/toolrisk'
import { bytes, dateOf, duration, pretty } from '../lib/format'
import { FindingList } from './Findings'
import { IconClose } from './Icons'
import { GrantScope, initialGrantSpec } from './GrantScope'
import { StatusTag } from '../pages/OverviewPage'

interface Props {
  call: CallRecord
  onClose: () => void
}

export function TraceDetail({ call, onClose }: Props): JSX.Element {
  const [permitStatus, setPermitStatus] = useState('')
  const [permitFailed, setPermitFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [open, setOpen] = useState(false)
  const [spec, setSpec] = useState<GrantSpec>(() => initialGrantSpec(call.tool ?? '', call.args))
  const [tools, setTools] = useState<readonly string[]>([])

  useEffect(() => {
    setOpen(false)
    setPermitStatus('')
    setPermitFailed(false)
    setSpec(initialGrantSpec(call.tool ?? '', call.args))
  }, [call.id, call.tool, call.args])

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const records: ToolRecord[] = await api.invoke('servers:tools', call.serverId)
        if (active) setTools(records.filter((record) => record.enabled).map((record) => record.name))
      } catch {
        if (active) setTools([])
      }
    })()
    return () => {
      active = false
    }
  }, [call.serverId])

  const permit = async (): Promise<void> => {
    setSaving(true)
    setPermitFailed(false)
    try {
      await api.invoke('security:grant', { callId: call.id, ...spec })
      setPermitStatus('Permission created. Review or revoke it on Security.')
      setOpen(false)
    } catch (error) {
      setPermitStatus((error as Error).message)
      setPermitFailed(true)
    } finally {
      setSaving(false)
    }
  }

  // A record with a credential or personal-data finding is not a safe basis for
  // a reusable permission, and the main process refuses one anyway.
  const scopeable =
    !!call.tool &&
    call.args !== null &&
    call.args !== undefined &&
    !call.findings.some((finding) => finding.type === 'secret' || finding.type === 'pii')
  const cap = classifyTool(call.tool ?? '')
  return (
    <aside className="drawer">
      <div className="drawer-head">
        <div className="row between">
          <div className="drawer-title">{call.tool ?? call.method}</div>
          <button className="btn ghost icon" onClick={onClose} aria-label="Close detail">
            <IconClose />
          </button>
        </div>
        <div className="drawer-sub row wrap" style={{ gap: 7 }}>
          <span>{call.serverName}</span>
          <span className={`tag cap-${cap.capability}`}>{cap.label}</span>
          <StatusTag status={call.status} />
        </div>
      </div>

      <div className="drawer-body">
        {call.findings.length > 0 && (
          <>
            <div className="section">
              {call.findings.length} {call.findings.length === 1 ? 'finding' : 'findings'}
            </div>
            <FindingList findings={call.findings} />
          </>
        )}

        <div className="section">Facts</div>
        <dl className="kv">
          <dt>When</dt>
          <dd>{dateOf(call.startedAt)}</dd>
          <dt>Decision</dt>
          <dd>
            <span className={call.decision ? `eff-${call.decision}` : ''}>{call.decision ?? '—'}</span>
            {call.decidedBy && <span className="faint"> · by {call.decidedBy}</span>}
          </dd>
          {call.ruleId && (
            <>
              <dt>{call.ruleId.startsWith('permit_') ? 'Scoped permission' : 'Matched rule'}</dt>
              <dd className="mono faint">{call.ruleId}</dd>
            </>
          )}
          {call.status === 'permitted' && (
            <>
              <dt>Outcome</dt>
              <dd>
                Unknown — Bridge permitted this call and never received its result.
                {call.method === 'hook/PreToolUse' && ' Register the outcome hook on MCP · Coverage to record what commands return.'}
              </dd>
            </>
          )}
          <dt>Duration</dt>
          <dd>{duration(call.durationMs)}</dd>
          <dt>Result size</dt>
          <dd>{bytes(call.resultBytes)}</dd>
          <dt>Result token estimate</dt>
          <dd>{call.tokenEstimate ? `~${call.tokenEstimate.toLocaleString()} tokens` : '—'}</dd>
          <dt>Billed cost</dt><dd>Unknown — provider usage unavailable</dd>
          <dt>Credentials used</dt><dd>Unknown — configuration does not prove use</dd>
          <dt>AI client</dt><dd>{call.client} (configured attribution)</dd>
          <dt>Agent / skill</dt><dd>Unknown — no execution attribution received</dd>
          <dt>Chat / task</dt><dd>Unknown — proxy sessions are not chat identifiers</dd>
          <dt>Proxy session</dt>
          <dd className="mono faint truncate">{call.sessionId}</dd>
        </dl>

        <div className="section">Scoped permission</div>
        {scopeable ? (
          <>
            <p className="sub">
              Authorise similar calls without a prompt, bounded by argument, time and count. Anything
              outside the scope still needs a decision. Explicit ask/block rules, credential checks,
              tool drift and pause all remain in force. This is not provider account access.
            </p>
            {open ? (
              <>
                <GrantScope
                  tool={call.tool ?? ''}
                  availableTools={tools}
                  value={spec}
                  onChange={setSpec}
                  disabled={saving}
                />
                <div className="row" style={{ gap: 8, marginTop: 10 }}>
                  <button className="btn primary" disabled={saving} onClick={() => void permit()}>
                    Create permission
                  </button>
                  <button className="btn ghost" disabled={saving} onClick={() => setOpen(false)}>
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <button className="btn" onClick={() => setOpen(true)}>
                Create a scoped permission from this call
              </button>
            )}
          </>
        ) : (
          <p className="sub">
            This record cannot be the basis of a permission: it has no stored arguments, or it
            carried a credential or personal data. Approve calls like it individually.
          </p>
        )}
        {permitStatus && (
          <div role={permitFailed ? 'alert' : 'status'} className={permitFailed ? 'security-error' : 'sub'}>
            {permitStatus}
          </div>
        )}
        <div className="section">Requested arguments</div>
        <pre className="code">{pretty(call.args)}</pre>

        {call.error ? (
          <>
            <div className="section">Error returned</div>
            <pre className="code">{pretty(call.error)}</pre>
          </>
        ) : (
          <>
            <div className="section">Result{call.redacted ? ' (redacted by Bridge)' : ''}</div>
            {call.shaping && (
              <p className="dim">
                {call.shaping.trimmedFromTokens !== undefined &&
                  `The model received a trimmed copy: about ${call.shaping.deliveredTokens?.toLocaleString()} of ${call.shaping.trimmedFromTokens.toLocaleString()} tokens. `}
                {call.shaping.repeatCount !== undefined &&
                  `This was identical call ${call.shaping.repeatCount} in a row with an unchanged result, so Bridge added a note telling the model.`}
              </p>
            )}
            <pre className="code">{call.result === null ? '—' : pretty(call.result)}</pre>
          </>
        )}
      </div>
    </aside>
  )
}
