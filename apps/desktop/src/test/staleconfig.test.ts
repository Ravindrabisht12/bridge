import { describe, expect, it } from 'vitest'
import { clientsNeedingRestart, needsRestart } from '@shared/staleconfig'

const client = (over: Partial<Parameters<typeof needsRestart>[0]> = {}) => ({
  id: 'claude-desktop',
  configPresent: true,
  configModifiedAt: 2000,
  ...over
})
const session = (startedAt: number, c = 'claude-desktop') => ({ client: c, startedAt })

describe('stale client config detection', () => {
  it('flags a client that started before the config was written', () => {
    // Started 1000, config rewritten 2000 -> running the old commands.
    expect(needsRestart(client(), [session(1000)])).toBe(true)
  })

  it('does not flag a client started after the config was written', () => {
    expect(needsRestart(client(), [session(3000)])).toBe(false)
  })

  it('uses the oldest session, so one stale connection is enough', () => {
    expect(needsRestart(client(), [session(3000), session(1000)])).toBe(true)
  })

  it('ignores sessions belonging to another client', () => {
    expect(needsRestart(client(), [session(1000, 'cursor')])).toBe(false)
  })

  it('does not flag a client with nothing running', () => {
    expect(needsRestart(client(), [])).toBe(false)
  })

  it('does not flag when there is no config to be stale', () => {
    expect(needsRestart(client({ configPresent: false }), [session(1000)])).toBe(false)
    expect(needsRestart(client({ configModifiedAt: null }), [session(1000)])).toBe(false)
  })

  it('treats an exactly-equal timestamp as not stale', () => {
    expect(needsRestart(client({ configModifiedAt: 1000 }), [session(1000)])).toBe(false)
  })

  it('filters a list of clients', () => {
    const stale = clientsNeedingRestart(
      [client(), client({ id: 'cursor', configModifiedAt: 500 })],
      [session(1000), session(1000, 'cursor')]
    )
    expect(stale.map((c) => c.id)).toEqual(['claude-desktop'])
  })
})
