/**
 * The guard is the only thing standing between a registry outage and every
 * user's library being replaced with nothing, so it is tested harder than
 * anything else in the worker.
 */
import { describe, expect, it } from 'vitest'
import { MAX_SHRINK, checkPublish } from '../src/guard'

describe('publish guard', () => {
  it('allows growth', () => {
    expect(checkPublish(27_500, 27_000).ok).toBe(true)
  })

  it('allows a small, plausible drop', () => {
    // Servers do get unpublished. A 1% drop is a Tuesday.
    const v = checkPublish(26_800, 27_000)
    expect(v.ok).toBe(true)
    expect(v.reason).toContain('within limit')
  })

  it('refuses a large drop and says why', () => {
    const v = checkPublish(20_000, 27_000)
    expect(v.ok).toBe(false)
    expect(v.reason).toMatch(/shrank 25\.9%/)
    expect(v.reason).toContain('not publishing')
  })

  it('refuses an empty catalogue outright', () => {
    // The registry answering `[]` during an outage is the exact scenario.
    const v = checkPublish(0, 27_000)
    expect(v.ok).toBe(false)
    expect(v.reason).toBe('refusing to publish an empty catalogue')
  })

  it('refuses an empty catalogue even on a first run', () => {
    expect(checkPublish(0, 0).ok).toBe(false)
  })

  it('allows the first publish, or the job could never bootstrap', () => {
    const v = checkPublish(55, 0)
    expect(v.ok).toBe(true)
    expect(v.reason).toContain('first publish')
  })

  it('sits exactly on the limit without tripping', () => {
    // 5% of 1000 is 50; losing exactly 50 is allowed, 51 is not.
    expect(checkPublish(950, 1000).ok).toBe(true)
    expect(checkPublish(949, 1000).ok).toBe(false)
  })

  it('does not judge a small catalogue by percentage', () => {
    // The curated set is ~55 entries. A proportion is noise at this size, so
    // the rule switches to an absolute one.
    expect(checkPublish(10, 11).ok).toBe(true)
    expect(checkPublish(9, 11).ok).toBe(false)
    expect(checkPublish(2, 15).ok).toBe(false)
  })

  it('refuses a nonsense count instead of trusting arithmetic on it', () => {
    expect(checkPublish(Number.NaN, 100).ok).toBe(false)
    expect(checkPublish(-1, 100).ok).toBe(false)
  })

  it('has a limit low enough to catch a real outage and high enough for churn', () => {
    expect(MAX_SHRINK).toBeGreaterThan(0)
    expect(MAX_SHRINK).toBeLessThanOrEqual(0.1)
  })
})
