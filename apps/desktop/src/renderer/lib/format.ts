import type { CallRecord, Finding, Severity } from '@shared/types'

export function timeOf(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour12: false })
}

export function dateOf(ms: number): string {
  return new Date(ms).toLocaleString()
}

export function duration(ms: number | null): string {
  if (ms === null || ms === undefined) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

export function bytes(n: number | null): string {
  if (!n) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function compactNumber(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

export function topSeverity(findings: readonly Finding[]): Severity | null {
  const rank: Record<Severity, number> = { low: 1, medium: 2, high: 3 }
  let best: Severity | null = null
  for (const f of findings) if (!best || rank[f.severity] > rank[best]) best = f.severity
  return best
}

export function summarizeArgs(call: CallRecord): string {
  const args = call.args
  if (!args || typeof args !== 'object') return ''
  const entries = Object.entries(args as Record<string, unknown>)
  if (entries.length === 0) return ''
  return entries
    .slice(0, 3)
    .map(([k, v]) => {
      const text = typeof v === 'string' ? v : JSON.stringify(v)
      const clipped = (text ?? '').length > 42 ? `${text.slice(0, 42)}…` : text
      return `${k}: ${clipped}`
    })
    .join('  ')
}

export function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}
