import { describe, expect, it } from 'vitest'
import { isProcessAlive, selectDeadSessions } from '../db/repo'

const row = (id: string, pid: number) => ({ id, pid })

describe('stale session reaping', () => {
  const alive = (pid: number): boolean => pid === 100

  it('selects only sessions whose process is gone', () => {
    const dead = selectDeadSessions([row('a', 100), row('b', 200)], alive, 999)
    expect(dead.map((d) => d.id)).toEqual(['b'])
  })

  it('never reaps a live session', () => {
    expect(selectDeadSessions([row('a', 100)], alive, 999)).toEqual([])
  })

  it('never reaps its own row', () => {
    // pid 42 is "dead" per the predicate, but it is us — leave it alone.
    expect(selectDeadSessions([row('self', 42)], alive, 42)).toEqual([])
  })

  it('ignores rows with no usable pid', () => {
    expect(selectDeadSessions([row('a', 0), row('b', -1)], alive, 999)).toEqual([])
  })

  it('treats the current process as alive for real', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
  })

  it('treats an impossible pid as dead', () => {
    // Above pid_max on macOS and Linux, so it can never name a process.
    expect(isProcessAlive(4194303)).toBe(false)
  })
})

describe('server identity', () => {
  it('derives the same id for the same client and name', async () => {
    const { serverIdFor } = await import('../db/repo')
    expect(serverIdFor('claude-desktop', 'trello')).toBe(serverIdFor('claude-desktop', 'trello'))
  })

  it('separates servers by name and by client', async () => {
    const { serverIdFor } = await import('../db/repo')
    expect(serverIdFor('claude-desktop', 'trello')).not.toBe(serverIdFor('claude-desktop', 'whatsapp'))
    expect(serverIdFor('claude-desktop', 'trello')).not.toBe(serverIdFor('cursor', 'trello'))
  })

  it('cannot be confused by a name containing the separator', async () => {
    const { serverIdFor } = await import('../db/repo')
    expect(serverIdFor('a', 'b c')).not.toBe(serverIdFor('a b', 'c'))
  })

  it('produces a config-safe id', async () => {
    const { serverIdFor } = await import('../db/repo')
    expect(serverIdFor('claude-desktop', 'my server/with spaces')).toMatch(/^srv_[0-9a-f]{20}$/)
  })
})
