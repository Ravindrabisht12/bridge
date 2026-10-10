import { useMemo } from 'react'
import {
  type ConstraintOp,
  type GrantConstraint,
  type GrantSpec,
  GRANT_LIMITS,
  describeGrant,
  proposeConstraints
} from '@shared/action-grant'
import { looksLikeSecret } from '../../scanners/secrets'

const OP_LABELS: Array<{ value: ConstraintOp; label: string; hint: string }> = [
  { value: 'eq', label: 'Exactly', hint: 'Only this value.' },
  { value: 'in', label: 'One of', hint: 'Any of these values. Comma separated.' },
  { value: 'glob', label: 'Matching', hint: 'A * / ? pattern. * spans separators, so write the whole scope.' },
  { value: 'absent', label: 'Not set', hint: 'The argument must be absent.' },
  { value: 'any', label: 'Any value', hint: 'Unconstrained — this argument is not part of the scope.' }
]

const DURATIONS = [15, 30, 60, 240, 480]
const CALL_LIMITS = [5, 10, 25, 50, 100]

/** A spec to start from: pin the identifiers, leave the payload free. */
export function initialGrantSpec(tool: string, args: unknown): GrantSpec {
  return {
    minutes: 30,
    maxCalls: 10,
    tools: [tool],
    constraints: proposeConstraints(args, looksLikeSecret),
    bindSession: false
  }
}

interface Props {
  /** The tool the decision is about. It cannot be removed from the grant. */
  tool: string
  /** Other tools on the same server, offered so one grant can cover a task. */
  availableTools: readonly string[]
  value: GrantSpec
  onChange: (next: GrantSpec) => void
  disabled?: boolean
}

/**
 * The scope editor.
 *
 * The whole point of a grant is that a user can read it back and recognise what
 * they authorised, so this shows the plain-language summary at all times and
 * keeps the pinned conditions visually distinct from the free ones. Long text
 * and structured arguments arrive unpinned: pinning a message body would
 * recreate the exact-match permission that never matched real work.
 */
export function GrantScope({ tool, availableTools, value, onChange, disabled }: Props): JSX.Element {
  const summary = useMemo(() => describeGrant(value), [value])
  const pinned = value.constraints.filter((constraint) => constraint.op !== 'any').length

  const setConstraint = (path: string, patch: Partial<GrantConstraint>): void => {
    onChange({
      ...value,
      constraints: value.constraints.map((constraint) =>
        constraint.path === path ? { ...constraint, ...patch } : constraint
      )
    })
  }

  const toggleTool = (name: string): void => {
    if (name === tool) return
    const has = value.tools.includes(name)
    const tools = has ? value.tools.filter((item) => item !== name) : [...value.tools, name]
    if (tools.length > GRANT_LIMITS.maxTools) return
    onChange({ ...value, tools })
  }

  const others = availableTools.filter((name) => name !== tool).slice(0, 24)

  return (
    <div className="grant-scope">
      <div className="grant-summary" aria-live="polite">
        <span className="grant-summary-eyebrow">THE AGENT WILL BE ABLE TO</span>
        <b>{summary}</b>
        {pinned === 0 && (
          <span className="grant-summary-warn">
            No argument is pinned, so this covers any arguments to these tools. Pin at least one
            identifier to keep the scope narrow.
          </span>
        )}
      </div>

      <div className="grant-row">
        <label>
          <span>For</span>
          <select
            className="select"
            aria-label="Permission duration in minutes"
            disabled={disabled}
            value={value.minutes}
            onChange={(e) => onChange({ ...value, minutes: Number(e.target.value) })}
          >
            {DURATIONS.map((minutes) => (
              <option key={minutes} value={minutes}>
                {minutes < 60 ? `${minutes} minutes` : `${minutes / 60} hours`}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Up to</span>
          <select
            className="select"
            aria-label="Maximum number of calls"
            disabled={disabled}
            value={value.maxCalls}
            onChange={(e) => onChange({ ...value, maxCalls: Number(e.target.value) })}
          >
            {CALL_LIMITS.map((calls) => (
              <option key={calls} value={calls}>
                {calls} calls
              </option>
            ))}
          </select>
        </label>
        <label className="grant-bind">
          <input
            type="checkbox"
            disabled={disabled}
            checked={value.bindSession ?? false}
            onChange={(e) => onChange({ ...value, bindSession: e.target.checked })}
          />
          <span>
            End if the client restarts
            <small>Off by default: a task usually outlives the process running it.</small>
          </span>
        </label>
      </div>

      {others.length > 0 && (
        <>
          <div className="section">Tools this covers</div>
          <div className="grant-tools">
            <span className="tag ok" title="The tool this decision is about">
              {tool}
            </span>
            {others.map((name) => (
              <button
                key={name}
                type="button"
                className="grant-tool"
                aria-pressed={value.tools.includes(name)}
                disabled={disabled}
                onClick={() => toggleTool(name)}
              >
                {name}
              </button>
            ))}
          </div>
        </>
      )}

      {value.constraints.length > 0 && (
        <>
          <div className="section">Conditions on the arguments</div>
          <div className="grant-constraints">
            {value.constraints.map((constraint) => {
              const op = OP_LABELS.find((entry) => entry.value === constraint.op)
              const needsValues =
                constraint.op === 'eq' || constraint.op === 'in' || constraint.op === 'glob'
              const secret = constraint.values.some((item) => looksLikeSecret(item))
              return (
                <div
                  key={constraint.path}
                  className={`grant-constraint ${constraint.op === 'any' ? 'free' : 'pinned'}`}
                >
                  <code>{constraint.path}</code>
                  <select
                    className="select sm"
                    aria-label={`Condition for ${constraint.path}`}
                    disabled={disabled}
                    value={constraint.op}
                    onChange={(e) =>
                      setConstraint(constraint.path, { op: e.target.value as ConstraintOp })
                    }
                  >
                    {OP_LABELS.map((entry) => (
                      <option key={entry.value} value={entry.value}>
                        {entry.label}
                      </option>
                    ))}
                  </select>
                  {needsValues ? (
                    <input
                      className="input sm"
                      aria-label={`Values for ${constraint.path}`}
                      disabled={disabled}
                      value={constraint.values.join(', ')}
                      placeholder={constraint.op === 'glob' ? 'e.g. /srv/site/*' : 'value'}
                      onChange={(e) => {
                        const parts = e.target.value
                          .split(',')
                          .map((part) => part.trim())
                          .filter(Boolean)
                        setConstraint(constraint.path, {
                          values: constraint.op === 'eq' ? [e.target.value] : parts
                        })
                      }}
                    />
                  ) : (
                    <span className="grant-constraint-note">{op?.hint}</span>
                  )}
                  {secret && (
                    <span className="tag danger" role="alert">
                      Looks like a credential — cannot be pinned
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
