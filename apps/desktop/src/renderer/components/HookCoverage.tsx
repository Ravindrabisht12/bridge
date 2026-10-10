import { useCallback, useEffect, useState } from 'react'
import type { HookStatus } from '@shared/hook'
import type { Settings } from '@shared/types'
import { api } from '../lib/api'

/**
 * Setting up shell coverage.
 *
 * Claude Code's most dangerous capability is running a shell command, and that
 * never passes through an MCP server. Two separate things have to be true for
 * Bridge to decide on it: the hook must be registered in Claude Code, and
 * enforcement must be switched on. They are shown separately because they fail
 * separately — a registered hook with enforcement off defers every decision to
 * Claude Code, which is a valid state and not a broken one.
 *
 * This is configuration, so it lives on the Coverage page rather than on
 * Security, which is for what happened and what needs a decision.
 */
export function HookCoverage(): JSX.Element {
  const [status, setStatus] = useState<HookStatus | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [snippet, setSnippet] = useState<{ settingsPath: string; snippet: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [nextStatus, nextSettings] = await Promise.all([
        api.invoke('hook:status'),
        api.invoke('settings:get')
      ])
      setStatus(nextStatus)
      setSettings(nextSettings)
    } catch {
      setStatus(null)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const act = async (channel: 'hook:install' | 'hook:uninstall', done: string): Promise<void> => {
    setBusy(true)
    setFailed(false)
    setMessage(null)
    try {
      setStatus(await api.invoke(channel))
      setMessage(done)
    } catch (err) {
      setFailed(true)
      setMessage((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const enforce = async (on: boolean): Promise<void> => {
    setBusy(true)
    setFailed(false)
    try {
      setSettings(await api.invoke('settings:set', { claudeCodeHook: on }))
    } catch {
      setFailed(true)
      setMessage('That change was not confirmed. Check the current state before relying on it.')
    } finally {
      setBusy(false)
    }
  }

  const enforcing = !!settings?.claudeCodeHook
  const registered = !!status?.installed
  const live = registered && enforcing
  /** Decision hook present, outcome hook missing: allowed but never explained. */
  const partial = !registered && (status?.events?.includes('PreToolUse') ?? false)

  return (
    <section className="card" aria-label="Native tool coverage">
      <div className="card-head">
        <h3>Claude Code native tools</h3>
        <span className="spacer" />
        <span className={`tag ${live ? 'ok' : partial ? 'warn' : ''}`}>
          {live ? 'Enforcing' : registered ? 'Registered' : partial ? 'Partly installed' : 'Not installed'}
        </span>
      </div>

      <div className="card-body stack" style={{ gap: 12 }}>
        <p className="sub">
          {!status
            ? 'Checking Claude Code…'
            : !status.readable
              ? 'Claude Code’s settings file could not be read.'
              : registered
                ? enforcing
                  ? 'Bridge decides these calls using the same rules, scoped permissions and trace as MCP activity, and records what each one actually returned.'
                  : 'Both hooks are registered but enforcement is off, so Claude Code decides these calls itself.'
                : partial
                  ? // Deciding without learning the outcome is the failure mode
                    // that made a trace answer "was this allowed" and never
                    // "what happened", so it is called out rather than hidden
                    // behind a generic "not installed".
                    'Only the decision hook is registered. Bridge would allow or block these calls but never learn what they did — reinstall to record outcomes too.'
                  : status.stale
                    ? 'A Bridge hook is registered from a different build, so it will never run this one. Reinstall to reconnect it.'
                    : 'Claude Code is not asking Bridge about these calls yet.'}
        </p>

        <label className="preference-row">
          <span>
            <b>Decide native tool calls</b>
            <small>
              Needs both hooks registered below. Bridge fails closed here: a call it cannot
              evaluate is blocked rather than run unsupervised.
            </small>
          </span>
          <input
            type="checkbox"
            role="switch"
            aria-label="Enforce Bridge policy on Claude Code native tools"
            disabled={!settings || busy}
            checked={enforcing}
            onChange={(e) => void enforce(e.target.checked)}
          />
        </label>

        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {registered || status?.stale || partial ? (
            <>
              {(status?.stale || partial) && (
                <button className="btn" disabled={busy} onClick={() => void act('hook:install', 'Hook reconnected to this build. Restart Claude Code.')}>
                  Reinstall hook
                </button>
              )}
              <button
                className="btn ghost"
                disabled={busy}
                onClick={() => void act('hook:uninstall', 'Hook removed from Claude Code’s settings.')}
              >
                Remove hook
              </button>
            </>
          ) : (
            <button
              className="btn"
              disabled={busy || !status?.readable}
              onClick={() => void act('hook:install', 'Hook installed. Restart Claude Code for it to load.')}
            >
              Install hook
            </button>
          )}
          <button
            className="btn ghost"
            disabled={busy}
            onClick={() =>
              void (async () => {
                try {
                  setSnippet(await api.invoke('hook:snippet'))
                } catch {
                  setFailed(true)
                  setMessage('The snippet could not be generated.')
                }
              })()
            }
          >
            Show me the config instead
          </button>
        </div>

        {message && (
          <p role={failed ? 'alert' : 'status'} className={failed ? 'security-error' : 'sub'}>
            {message}
          </p>
        )}

        {status && !status.readable && status.problem && (
          <p role="alert" className="security-error">
            {status.problem} Bridge will not rewrite a file it cannot parse.
          </p>
        )}

        {snippet && (
          <details open>
            <summary>Add this to {snippet.settingsPath}</summary>
            <pre className="code">{snippet.snippet}</pre>
            <p className="faint">
              Bridge keeps a backup beside that file the first time it edits it, and only ever
              touches its own entry. Restart Claude Code after changing hooks.
            </p>
          </details>
        )}

        <p className="faint">
          Claude Code only — no other client exposes an equivalent hook, so their shell and file
          activity stays outside Bridge’s coverage. Bridge records what a command was and what it
          returned; it cannot tell you what that changed on a server, and it cannot undo it.
        </p>
      </div>
    </section>
  )
}
