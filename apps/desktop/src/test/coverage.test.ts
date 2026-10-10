import { describeIntegration } from '../shared/coverage'
import type { ManagedServer } from '../shared/types'
import { describe, expect, it } from 'vitest'
import { describeCoverage, type CoverageConnection } from '../shared/coverage'
const connection: CoverageConnection = { client: 'cursor', name: 'tool', wrapped: true, wrappedServerId: 's', current: true }
const servers = [{ id: 's' }]
const live = [{ serverId: 's', client: 'cursor' as const, endedAt: null }]
describe('coverage claims', () => {
  it('requires routing, a known server and a live matching session for active', () => {
    expect(describeCoverage([connection], servers, live)[0]?.state).toBe('active')
    expect(describeCoverage([connection], servers, [])[0]?.state).toBe('configured')
    expect(describeCoverage([connection], servers, [{ ...live[0]!, endedAt: 1 }])[0]?.state).toBe('configured')
  })
  it('does not let stale activity imply a direct config is monitored', () => {
    expect(describeCoverage([{ ...connection, wrapped: false }], servers, live)[0]?.state).toBe('direct')
  })
  it('identifies unknown ids and stale commands as needing repair', () => {
    expect(describeCoverage([connection], [], live)[0]?.state).toBe('broken')
    expect(describeCoverage([{ ...connection, current: false }], servers, live)[0]?.state).toBe('broken')
  })
  it('does not attribute a session from another configured client', () => {
    expect(describeCoverage([connection], servers, [{ ...live[0]!, client: 'vscode' }])[0]?.state).toBe('configured')
  })
})


describe('integration configuration evidence', () => {
  it('reports credential fields and transport concerns without returning values or URLs', () => {
    const server = { id: 's', name: 'mail', target: { kind: 'http', url: 'http://user:private@example.test/?token=secret-value', headers: { Authorization: 'Bearer private-token' } } } as unknown as ManagedServer
    const evidence = describeIntegration(server)
    expect(evidence.credentialFields).toEqual(['Authorization'])
    expect(evidence.transport).toBe('Unencrypted HTTP')
    const serialized = JSON.stringify(evidence)
    for (const value of ['private-token', 'secret-value', 'user:private']) expect(serialized).not.toContain(value)
  })
  it('does not infer absence of credential use from an empty configuration', () => {
    const evidence = describeIntegration({ id: 's', name: 'mail', target: { kind: 'stdio', command: 'mail', args: [] } } as unknown as ManagedServer)
    expect(evidence.credentialFields).toEqual([])
    expect(evidence.concerns.join(' ')).toContain('Credentials may also be loaded elsewhere')
    expect(evidence.concerns.join(' ')).toContain('does not sandbox')
  })
})
