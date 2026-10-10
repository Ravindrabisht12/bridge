import { describe, expect, it } from 'vitest'
import type { StageResult } from '@bridge/types'
import { CRITICAL, runStage, shouldAbort } from '../src/stages'

const ctx = { scheduled: true, now: () => new Date('2026-01-01T00:00:00.000Z'), log: () => {} }

describe('stage runner', () => {
  it('records a successful stage', async () => {
    const r = await runStage(
      { name: 'registry', run: async () => ({ fetched: 10, added: 2, changed: 1, removed: 0, error: null }) },
      ctx
    )
    expect(r.stage).toBe('registry')
    expect(r.fetched).toBe(10)
    expect(r.error).toBeNull()
  })

  it('turns a thrown stage into a recorded failure, not a crashed run', async () => {
    const r = await runStage(
      { name: 'icons', run: async () => { throw new Error('vendor timed out') } },
      ctx
    )
    expect(r.error).toBe('vendor timed out')
    expect(r.fetched).toBe(0)
  })
})

describe('abort policy', () => {
  const result = (stage: StageResult['stage'], error: string | null): StageResult => ({
    stage, startedAt: '', finishedAt: '', fetched: 0, added: 0, changed: 0, removed: 0, error
  })

  it('aborts when the registry pull failed — there is nothing to publish', () => {
    expect(shouldAbort([result('registry', 'HTTP 503')])?.stage).toBe('registry')
  })

  it('does not abort when only icons failed', () => {
    // A missing icon is a monogram. It is not a reason to skip a week of
    // catalogue updates.
    expect(shouldAbort([result('registry', null), result('icons', 'timeout')])).toBeNull()
  })

  it('does not abort when only download counts failed', () => {
    expect(shouldAbort([result('downloads', 'npm rate limited')])).toBeNull()
  })

  it('treats exactly registry and publish as critical', () => {
    expect([...CRITICAL].sort()).toEqual(['publish', 'registry'])
  })
})
