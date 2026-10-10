import type { CallRecord } from './types'

export interface SecuritySignal {
  id: string
  title: string
  evidence: string
  action: string
  callIds: string[]
}

/** Deterministic triage over a bounded observed window, never a breach verdict. */
export function securitySignals(calls: CallRecord[], now: number): SecuritySignal[] {
  const recent = [...new Map(calls.filter((call) => call.startedAt <= now && call.startedAt >= now - 15 * 60_000).map((call) => [call.id, call])).values()]
  const signals: SecuritySignal[] = []
  const bySession = new Map<string, CallRecord[]>()
  for (const call of recent) {
    const own = bySession.get(call.sessionId) ?? []
    own.push(call)
    bySession.set(call.sessionId, own)
    for (const finding of call.findings.filter((item) => item.severity === 'high')) {
      signals.push({ id: `${call.id}:${finding.type}:${finding.label}`, title: finding.label,
        evidence: `${call.client} · ${call.serverName} · ${call.tool ?? call.method} · ${call.status}. Detected on ${finding.side}; this is a scanner signal, not proof of compromise.`,
        action: call.status === 'denied' ? 'Inspect the blocked request and its source.' : 'Review the request and result; pause routed actions if the access was unexpected.', callIds: [call.id] })
    }
  }
  for (const [sessionId, own] of bySession) {
    const denied = own.filter((call) => call.status === 'denied')
    if (denied.length >= 3) signals.push({ id: `denials:${sessionId}`, title: 'Repeated blocked attempts', evidence: `${denied.length} denied calls in one proxy session within 15 minutes. This can also be a client retry or misconfiguration.`, action: 'Review the attempted operations and permission rules before allowing further access.', callIds: denied.map((call) => call.id) })
  }
  return signals
}
