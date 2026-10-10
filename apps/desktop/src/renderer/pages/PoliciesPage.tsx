import { useEffect, useState } from 'react'
import type { ManagedServer, PolicyEffect, PolicyRule } from '@shared/types'
import { api } from '../lib/api'
import { summarizeRule } from '@shared/rulesummary'
import { dateOf } from '../lib/format'
import { IconAlert, IconInfo, IconShield } from '../components/Icons'

const blank = (): PolicyRule => ({
  id: '',
  enabled: true,
  priority: 50,
  name: '',
  description: '',
  match: { serverId: '*', clientName: '*', tool: '*', method: 'tools/call' },
  effect: 'ask',
  createdAt: Date.now(),
  updatedAt: Date.now()
})

interface Props {
  servers: ManagedServer[]
}

export function PoliciesPage({ servers }: Props): JSX.Element {
  const [rules, setRules] = useState<PolicyRule[]>([])
  const [stats, setStats] = useState<Array<{ ruleId: string; matches: number; lastMatchedAt: number }>>([])
  const [fallback, setFallback] = useState<PolicyEffect>('allow')
  const [editing, setEditing] = useState<PolicyRule | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = async (): Promise<void> => {
    const [list, counts, settings] = await Promise.all([
      api.invoke('rules:list'),
      api.invoke('rules:stats'),
      api.invoke('settings:get')
    ])
    setRules(list)
    setStats(counts)
    setFallback(settings.defaultEffect)
  }

  useEffect(() => {
    void load()
  }, [])

  const save = async (): Promise<void> => {
    if (!editing) return
    if (!editing.name.trim()) {
      setError('Give the rule a name.')
      return
    }
    try {
      await api.invoke('rules:save', editing)
      setEditing(null)
      setError(null)
      await load()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const toggle = async (rule: PolicyRule): Promise<void> => {
    await api.invoke('rules:save', { ...rule, enabled: !rule.enabled })
    await load()
  }

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Policy</h1>
          <div className="sub">rules are checked in priority order — the first match decides</div>
        </div>
        <span className="spacer" />
        <button className="btn" onClick={() => void api.invoke('rules:reset').then(load)}>
          Restore defaults
        </button>
        <button className="btn primary" onClick={() => setEditing(blank())}>
          New rule
        </button>
      </div>

      <div className="content pad stack">
        {error && (
          <div className="banner danger">
            <IconAlert />
            <div>{error}</div>
          </div>
        )}

        <div className="grid cols-4">
          {(['deny', 'ask', 'allow'] as PolicyEffect[]).map((e) => {
            const count = rules.filter((r) => r.enabled && r.effect === e).length
            return (
              <div className="card metric" key={e}>
                <div className="label">{e === 'deny' ? 'Blocked' : e === 'ask' ? 'Asks first' : 'Allowed'}</div>
                <div className={`value eff-${e}`}>{count}</div>
                <div className="foot">{count === 1 ? 'rule' : 'rules'} in force</div>
              </div>
            )
          })}
          <div className="card metric">
            <div className="label">Anything unmatched</div>
            <div className={`value eff-${fallback}`} style={{ fontSize: 19 }}>
              {fallback === 'allow' ? 'Allowed' : fallback === 'ask' ? 'Asks first' : 'Blocked'}
            </div>
            <div className="foot">set on the Settings page</div>
          </div>
        </div>

        <div className="card">
          <div className="order-note">
            <IconInfo size={13} />
            Checked top to bottom. The first rule that matches decides, and the rest are skipped.
          </div>

          {rules.map((rule) => {
            const plain = summarizeRule(rule.match, rule.effect, (id) => servers.find((s) => s.id === id)?.name ?? id)
            const stat = stats.find((s) => s.ruleId === rule.id)
            return (
              <div key={rule.id} className={`rule-row ${rule.enabled ? '' : 'off'}`}>
                <span className={`rule-effect ${rule.effect}`}>{rule.effect}</span>

                <div className="rule-main">
                  <div className="rule-title">{rule.name}</div>
                  <div className="rule-plain">
                    {plain.subject}
                    {plain.conditions.length > 0 && (
                      <span className="cond"> — {plain.conditions.join(', ')}</span>
                    )}
                  </div>
                  {(rule.match.tool && rule.match.tool !== '*') || rule.match.argMatches ? (
                    <div
                      className="rule-pattern"
                      title={[rule.match.tool, rule.match.argMatches].filter(Boolean).join('  •  ')}
                    >
                      {rule.match.tool && rule.match.tool !== '*' ? rule.match.tool : rule.match.argMatches}
                    </div>
                  ) : null}
                </div>

                <div className="rule-actions">
                  <span className="rule-fires">
                    {stat ? (
                      <>
                        <b>{stat.matches}</b> {stat.matches === 1 ? 'match' : 'matches'} · {dateOf(stat.lastMatchedAt).split(',')[0]}
                      </>
                    ) : (
                      'never fired'
                    )}
                  </span>
                  <label className="check" title={rule.enabled ? 'Turn off' : 'Turn on'}>
                    <input type="checkbox" checked={rule.enabled} onChange={() => void toggle(rule)} />
                  </label>
                  <button className="btn sm" onClick={() => setEditing(rule)}>
                    Edit
                  </button>
                  <button
                    className="btn danger sm"
                    onClick={() => void api.invoke('rules:delete', rule.id).then(load)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            )
          })}

          {rules.length === 0 && (
            <div className="empty">
              <div className="glyph">
                <IconShield />
              </div>
              <h3>No rules</h3>
              <p>Every call falls through to the default effect set on the Settings page.</p>
            </div>
          )}
        </div>
      </div>

      {editing && (
        <div className="scrim" role="dialog" aria-modal="true">
          <div className="modal">
            <div className="modal-head">
              <h2>{editing.id ? 'Edit rule' : 'New rule'}</h2>
              <div className="sub">Lower priority numbers are evaluated first.</div>
            </div>
            <div className="modal-body">
            <div className="form">
              <label htmlFor="r-name">Name</label>
              <input
                id="r-name"
                className="input"
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              />

              <label htmlFor="r-effect">Effect</label>
              <select
                id="r-effect"
                className="select"
                value={editing.effect}
                onChange={(e) => setEditing({ ...editing, effect: e.target.value as PolicyEffect })}
              >
                <option value="allow">allow — run silently</option>
                <option value="ask">ask — prompt me first</option>
                <option value="deny">deny — block and tell the model</option>
              </select>

              <label htmlFor="r-priority">Priority</label>
              <input
                id="r-priority"
                className="input"
                type="number"
                value={editing.priority}
                onChange={(e) => setEditing({ ...editing, priority: Number(e.target.value) })}
              />

              <label htmlFor="r-server">Server</label>
              <select
                id="r-server"
                className="select"
                value={editing.match.serverId ?? '*'}
                onChange={(e) => setEditing({ ...editing, match: { ...editing.match, serverId: e.target.value } })}
              >
                <option value="*">Any server</option>
                {servers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>

              <label htmlFor="r-client">Client</label>
              <input
                id="r-client"
                className="input"
                placeholder="* or claude-ai or re:(cowork|chat)"
                value={editing.match.clientName ?? '*'}
                onChange={(e) => setEditing({ ...editing, match: { ...editing.match, clientName: e.target.value } })}
              />
              <div className="hint">
                Matches how the connecting app named itself. Use this to apply a rule to one surface of
                an AI client (Chat vs Cowork) when they identify differently.
              </div>

              <label htmlFor="r-tool">Tool pattern</label>
              <input
                id="r-tool"
                className="input"
                placeholder="* or send_* or re:(delete|drop)"
                value={editing.match.tool ?? '*'}
                onChange={(e) => setEditing({ ...editing, match: { ...editing.match, tool: e.target.value } })}
              />

              <label htmlFor="r-argpath">Argument path</label>
              <input
                id="r-argpath"
                className="input"
                placeholder="optional, e.g. path or message.body"
                value={editing.match.argPath ?? ''}
                onChange={(e) =>
                  setEditing({ ...editing, match: { ...editing.match, argPath: e.target.value || undefined } })
                }
              />

              <label htmlFor="r-argre">Argument regex</label>
              <input
                id="r-argre"
                className="input"
                placeholder="optional, e.g. \.env|id_rsa"
                value={editing.match.argMatches ?? ''}
                onChange={(e) =>
                  setEditing({ ...editing, match: { ...editing.match, argMatches: e.target.value || undefined } })
                }
              />

              <label htmlFor="r-desc">Note</label>
              <input
                id="r-desc"
                className="input"
                value={editing.description ?? ''}
                onChange={(e) => setEditing({ ...editing, description: e.target.value })}
              />
            </div>
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <span className="spacer" />
              <button className="btn primary" onClick={() => void save()}>
                Save rule
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
