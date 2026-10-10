import { describe, expect, it } from 'vitest'
import { overviewVerdict, type VerdictInput } from '@shared/verdict'

const base: VerdictInput = {
  sessions: 2,
  connectedServers: 3,
  tools: 49,
  denied: 0,
  flagged: 0,
  changedTools: 0
}

describe('overviewVerdict', () => {
  it('limits its no-findings statement to recorded activity', () => {
    const v = overviewVerdict(base)
    expect(v.tone).toBe('ok')
    expect(v.headline).toBe('No findings in recorded activity')
    expect(v.detail).toContain('2 live sessions')
    expect(v.chips).toHaveLength(0)
  })

  it('does not call an empty install "all clear"', () => {
    const v = overviewVerdict({ ...base, sessions: 0, connectedServers: 0, tools: 0 })
    expect(v.tone).toBe('idle')
    expect(v.headline).toBe('Nothing is being watched yet')
  })

  it('separates "nothing connected" from "connected but nothing running"', () => {
    const v = overviewVerdict({ ...base, sessions: 0 })
    expect(v.tone).toBe('idle')
    expect(v.headline).toBe('No client is connected right now')
    expect(v.detail).toContain('3 servers')
  })

  it('leads with blocked calls over everything else', () => {
    const v = overviewVerdict({ ...base, denied: 4, flagged: 9, changedTools: 2 })
    expect(v.tone).toBe('danger')
    expect(v.headline).toBe('4 calls blocked by policy')
    expect(v.detail).toContain('49 tools exposed')
  })

  it('drops the chip the headline already says', () => {
    const v = overviewVerdict({ ...base, denied: 4, flagged: 9, changedTools: 2 })
    expect(v.chips.map((c) => c.label)).toEqual(['definitions changed', 'results flagged'])
  })

  it('leaves a lone problem with no chips at all', () => {
    expect(overviewVerdict({ ...base, flagged: 3 }).chips).toEqual([])
    expect(overviewVerdict({ ...base, denied: 1 }).chips).toEqual([])
    expect(overviewVerdict({ ...base, changedTools: 1 }).chips).toEqual([])
  })

  it('leads with changed definitions when nothing was blocked', () => {
    const v = overviewVerdict({ ...base, changedTools: 1 })
    expect(v.tone).toBe('danger')
    expect(v.headline).toBe('1 tool definition has changed')
  })

  it('pluralises changed definitions', () => {
    expect(overviewVerdict({ ...base, changedTools: 3 }).headline).toBe('3 tool definitions have changed')
  })

  it('falls back to findings', () => {
    const v = overviewVerdict({ ...base, flagged: 1 })
    expect(v.tone).toBe('warn')
    expect(v.headline).toBe('1 result carried a finding')
  })

  it('points each remaining chip at the page that explains it', () => {
    const v = overviewVerdict({ ...base, denied: 2, flagged: 3, changedTools: 1 })
    expect(v.chips.map((c) => [c.goto, c.count, c.label])).toEqual([
      ['tools', 1, 'definition changed'],
      ['trace', 3, 'results flagged']
    ])
  })

  it('shows no chips when there is nothing to chase', () => {
    expect(overviewVerdict(base).chips).toEqual([])
    expect(overviewVerdict({ ...base, sessions: 0 }).chips).toEqual([])
  })

  it('uses singular forms throughout for a count of one', () => {
    const v = overviewVerdict({ sessions: 1, connectedServers: 1, tools: 1, denied: 0, flagged: 0, changedTools: 0 })
    expect(v.detail).toContain('1 live session · configured for 1 server · 1 tool exposed to the model')
    expect(v.detail).toContain('not a guarantee')
  })
})
