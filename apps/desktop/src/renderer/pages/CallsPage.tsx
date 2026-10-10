import { useEffect, useMemo, useState } from 'react'
import type { CallRecord } from '@shared/types'
import { api } from '../lib/api'
import { FindingList } from '../components/Findings'
import { IconChevron, IconPause, IconPlay, IconSearch } from '../components/Icons'

interface Props {
  calls: CallRecord[]
  paused: boolean
  onPaused: (paused: boolean) => void
  search: string
  onSearch: (search: string) => void
}

/** One AI app talking to one server: the unit a reader recognises. */
interface Session {
  id: string
  client: string
  server: string
  calls: CallRecord[]
  lastAt: number
}

const STATUS: Record<CallRecord['status'], { mark: string; tone: string; label: string }> = {
  pending: { mark: '…', tone: 'running', label: 'Running' },
  permitted: { mark: '…', tone: 'running', label: 'Allowed, running' },
  'awaiting-approval': { mark: '?', tone: 'waiting', label: 'Waiting for your approval' },
  completed: { mark: '✓', tone: 'ok', label: 'Done' },
  failed: { mark: '✕', tone: 'failed', label: 'Failed' },
  denied: { mark: '⊘', tone: 'failed', label: 'Blocked' },
  cancelled: { mark: '–', tone: 'muted', label: 'Cancelled' }
}

const time = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const duration = (ms: number | null): string => (ms === null ? '' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`)
const pretty = (value: unknown): string => (value === null || value === undefined ? '—' : typeof value === 'string' ? value : JSON.stringify(value, null, 2))

/** The arguments on one line, the way a call stack shows them: `{"title":"…"}` → `title: "…"`. */
function argPreview(args: unknown): string {
  if (!args || typeof args !== 'object') return ''
  const parts = Object.entries(args as Record<string, unknown>).map(([k, v]) => `${k}: ${typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) ?? ''}`)
  const line = parts.join(', ')
  return line.length > 120 ? `${line.slice(0, 117)}…` : line
}

/** MCP results are a list of content blocks; show their text, and say what else is there. */
function resultText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> })?.content
  if (!Array.isArray(content)) return pretty(result)
  return content.map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : `[${block.type ?? 'unknown'} block]`)).join('\n')
}

function CallRow({ call }: { call: CallRecord }): JSX.Element {
  const [open, setOpen] = useState(false)
  const status = STATUS[call.status]
  return (
    <li className={`call-line ${status.tone}`}>
      <button className="call-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <IconChevron size={11} className={`call-chevron ${open ? 'open' : ''}`} />
        <span className="call-mark" title={status.label}>{status.mark}</span>
        <span className="call-tool">{call.tool ?? call.method}</span>
        <span className="call-args">{argPreview(call.args)}</span>
        {call.findings.length > 0 && <span className="tag warn">{call.findings.length} flagged</span>}
        <span className="call-time">{duration(call.durationMs) || status.label}</span>
      </button>
      {open && (
        <div className="call-body">
          <div className="call-meta">
            {status.label} · {time(call.startedAt)}
            {call.decidedBy && call.decision ? ` · ${call.decision === 'allow' ? 'allowed' : call.decision === 'deny' ? 'blocked' : 'asked'} by ${call.decidedBy}` : ''}
            {call.tokenEstimate !== null ? ` · ~${call.tokenEstimate.toLocaleString()} tokens` : ''}
          </div>
          <div className="call-label">Arguments</div>
          <pre className="call-code">{pretty(call.args)}</pre>
          {call.error ? (
            <>
              <div className="call-label">Error</div>
              <pre className="call-code failed">{call.error.message}</pre>
            </>
          ) : call.result !== null ? (
            <>
              <div className="call-label">Result{call.redacted ? ' (redacted)' : ''}</div>
              {call.shaping?.trimmedFromTokens !== undefined && (
                <div className="call-note">The AI received a trimmed copy: about {call.shaping.deliveredTokens?.toLocaleString()} of {call.shaping.trimmedFromTokens.toLocaleString()} tokens.</div>
              )}
              {call.shaping?.repeatCount !== undefined && (
                <div className="call-note">Identical call {call.shaping.repeatCount} in a row with the same result; Bridge told the AI.</div>
              )}
              <pre className="call-code">{resultText(call.result)}</pre>
            </>
          ) : null}
          {call.findings.length > 0 && <FindingList findings={call.findings} />}
        </div>
      )}
    </li>
  )
}

/**
 * Every tool call, as a call stack: grouped by the AI app and server that made
 * it, newest session first, one line per call that opens to its arguments and
 * result. Live while not paused.
 */
export function CallsPage({ calls, paused, onPaused, search, onSearch }: Props): JSX.Element {
  const [labels, setLabels] = useState<Record<string, string>>({})
  useEffect(() => {
    void api.invoke('clients:status').then((clients) => setLabels(Object.fromEntries(clients.map((c) => [c.id, c.label]))))
  }, [])

  const sessions = useMemo(() => {
    const byId = new Map<string, Session>()
    for (const call of calls) {
      let session = byId.get(call.sessionId)
      if (!session) {
        session = { id: call.sessionId, client: call.client, server: call.serverName, calls: [], lastAt: 0 }
        byId.set(call.sessionId, session)
      }
      session.calls.push(call)
      session.lastAt = Math.max(session.lastAt, call.startedAt)
    }
    for (const session of byId.values()) session.calls.sort((a, b) => a.startedAt - b.startedAt)
    return [...byId.values()].sort((a, b) => b.lastAt - a.lastAt)
  }, [calls])

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Calls</h1>
          <div className="sub">What your AI apps asked their MCP servers to do, and what came back.</div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <label className="search-box">
            <IconSearch size={13} />
            <input className="input" placeholder="Search tools and arguments" value={search} onChange={(e) => onSearch(e.target.value)} />
          </label>
          <button className="btn" onClick={() => onPaused(!paused)} title={paused ? 'Resume live updates' : 'Pause live updates'}>
            {paused ? <IconPlay size={13} /> : <IconPause size={13} />}
            {paused ? 'Resume' : 'Live'}
          </button>
        </div>
      </div>
      <div className="content calls-content">
        {sessions.length === 0 ? (
          <div className="calls-empty">
            <h3>No calls yet</h3>
            <p>Connect a server on the Servers page, restart your AI app, and ask it to use a tool. Each call shows up here as it happens.</p>
          </div>
        ) : (
          sessions.map((session) => (
            <section key={session.id} className="call-session">
              <header>
                <b>{labels[session.client] ?? session.client}</b>
                <span className="faint">→</span>
                <b>{session.server}</b>
                <span className="faint">
                  {session.calls.length} call{session.calls.length === 1 ? '' : 's'} · {time(session.lastAt)}
                </span>
              </header>
              <ol>
                {session.calls.map((call) => (
                  <CallRow key={call.id} call={call} />
                ))}
              </ol>
            </section>
          ))
        )}
      </div>
    </>
  )
}
