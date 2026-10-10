import { describe, expect, it } from 'vitest'
import { securitySignals } from '../shared/security-signals'
import type { CallRecord } from '../shared/types'
const now = 2_000_000
const call = (id: string, sessionId = 's', startedAt = now): CallRecord => ({ id, sessionId, startedAt, status: 'denied', findings: [], client: 'cursor', serverName: 'test', tool: 'send_email' }) as unknown as CallRecord

describe('security triage', () => {
  it('groups repeated denied attempts within one session', () => {
    expect(securitySignals([call('1'), call('2'), call('3')], now)).toMatchObject([{ title: 'Repeated blocked attempts', callIds: ['1', '2', '3'] }])
  })
  it('does not combine unrelated sessions or duplicate call events', () => {
    expect(securitySignals([call('1'), call('1'), call('2', 'other')], now)).toEqual([])
  })
  it('excludes old and future timestamps from the observed window', () => {
    expect(securitySignals([call('1'), call('2', 's', now - 900_001), call('3', 's', now + 1)], now)).toEqual([])
  })
  it('includes high findings without copying raw arguments into the incident summary', () => {
    const record = { ...call('1'), args: { password: 'never-in-summary' }, findings: [{ severity: 'high', type: 'secret', label: 'Possible token', side: 'args' }] } as CallRecord
    const signals = securitySignals([record], now)
    expect(signals[0]?.title).toBe('Possible token')
    expect(JSON.stringify(signals)).not.toContain('never-in-summary')
    expect(signals[0]?.evidence).toContain('not proof of compromise')
  })
})
