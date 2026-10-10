import type { Finding } from '@shared/types'

export function FindingBadge({ findings }: { findings: readonly Finding[] }): JSX.Element | null {
  if (findings.length === 0) return null
  const rank = { low: 1, medium: 2, high: 3 } as const
  const top = findings.reduce((a, b) => (rank[b.severity] > rank[a.severity] ? b : a))
  const cls = top.severity === 'high' ? 'danger' : top.severity === 'medium' ? 'warn' : 'ok'
  return (
    <span className={`tag ${cls}`} title={findings.map((f) => f.label).join('\n')}>
      {findings.length === 1 ? top.label : `${findings.length} flags`}
    </span>
  )
}

export function FindingList({ findings }: { findings: readonly Finding[] }): JSX.Element {
  return (
    <>
      {findings.map((f, i) => (
        <div key={i} className={`finding ${f.severity}`}>
          <div className="finding-head">
            <span className="finding-label">{f.label}</span>
            <span className="faint">
              {f.severity} · {f.side}
            </span>
          </div>
          {f.detail && <div className="finding-detail">{f.detail}</div>}
          {f.excerpt && <div className="finding-excerpt">{f.excerpt}</div>}
        </div>
      ))}
    </>
  )
}
