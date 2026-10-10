import { describe, expect, it } from 'vitest'
import {
  type ActionGrant,
  type GrantConstraint,
  constraintSatisfied,
  describeGrant,
  failedConstraint,
  grantMatches,
  looksLikeIdentifier,
  proposeConstraints,
  validateGrantSpec
} from '../shared/action-grant'
import { looksLikeSecret } from '../scanners/secrets'

/**
 * Claiming a use hits real SQLite, and better-sqlite3 here is built for
 * Electron's ABI rather than this Node. Those checks live in `e2e/driver.js`,
 * which runs under the Electron binary the app actually ships.
 */

const secret = 'sk-ant-' + 'A'.repeat(32)

const grant = (over: Partial<ActionGrant> = {}): ActionGrant => ({
  id: 'permit_1',
  sessionId: null,
  serverId: 'srv_wp',
  tools: ['wp_update_post'],
  constraints: [{ path: 'site', op: 'eq', values: ['blog.example.com'] }],
  label: 'test',
  expiresAt: 10_000,
  remaining: 5,
  revokedAt: null,
  createdAt: 0,
  ...over
})

const ctx = (args: unknown, tool = 'wp_update_post') => ({
  serverId: 'srv_wp',
  sessionId: 'ses_a',
  tool,
  args
})

describe('constraint evaluation', () => {
  it('matches an exact scalar and rejects a different one', () => {
    const c: GrantConstraint = { path: 'site', op: 'eq', values: ['blog.example.com'] }
    expect(constraintSatisfied(c, { site: 'blog.example.com' })).toBe(true)
    expect(constraintSatisfied(c, { site: 'other.example.com' })).toBe(false)
  })

  it('treats an omitted or null argument as failing a pinned condition', () => {
    const c: GrantConstraint = { path: 'site', op: 'eq', values: ['blog.example.com'] }
    expect(constraintSatisfied(c, {})).toBe(false)
    expect(constraintSatisfied(c, { site: null })).toBe(false)
  })

  it('reads a nested path and compares a structure as its JSON text', () => {
    expect(constraintSatisfied({ path: 'target.id', op: 'eq', values: ['7'] }, { target: { id: 7 } })).toBe(true)
    expect(constraintSatisfied({ path: 'ids', op: 'eq', values: ['[1,2]'] }, { ids: [1, 2] })).toBe(true)
    expect(constraintSatisfied({ path: 'ids', op: 'eq', values: ['[1,2]'] }, { ids: [2, 1] })).toBe(false)
  })

  it('supports a value set, a pattern, absence and an explicit free argument', () => {
    expect(constraintSatisfied({ path: 'op', op: 'in', values: ['read', 'update'] }, { op: 'update' })).toBe(true)
    expect(constraintSatisfied({ path: 'op', op: 'in', values: ['read', 'update'] }, { op: 'delete' })).toBe(false)
    expect(constraintSatisfied({ path: 'p', op: 'glob', values: ['/srv/site/*'] }, { p: '/srv/site/a.txt' })).toBe(true)
    expect(constraintSatisfied({ path: 'p', op: 'glob', values: ['/srv/site/*'] }, { p: '/etc/passwd' })).toBe(false)
    expect(constraintSatisfied({ path: 'draft', op: 'absent', values: [] }, {})).toBe(true)
    expect(constraintSatisfied({ path: 'draft', op: 'absent', values: [] }, { draft: false })).toBe(false)
    expect(constraintSatisfied({ path: 'body', op: 'any', values: [] }, { body: 'anything at all' })).toBe(true)
  })

  it('never authorises a call on an op this build does not understand', () => {
    const forged = { path: 'site', op: 'regex-ish' as never, values: ['.*'] }
    expect(constraintSatisfied(forged, { site: 'anything' })).toBe(false)
  })
})

describe('grant matching', () => {
  it('covers a changed payload while pinning the target', () => {
    const g = grant({
      constraints: [
        { path: 'site', op: 'eq', values: ['blog.example.com'] },
        { path: 'content', op: 'any', values: [] }
      ]
    })
    // The exact-digest design failed precisely here: real work varies the body.
    expect(grantMatches(g, ctx({ site: 'blog.example.com', content: 'first draft' }), 0)).toBe(true)
    expect(grantMatches(g, ctx({ site: 'blog.example.com', content: 'quite different' }), 0)).toBe(true)
    expect(grantMatches(g, ctx({ site: 'evil.example.com', content: 'first draft' }), 0)).toBe(false)
  })

  it('refuses an untrusted tool, another server, expiry, exhaustion and revocation', () => {
    const args = { site: 'blog.example.com' }
    expect(grantMatches(grant(), ctx(args, 'wp_delete_site'), 0)).toBe(false)
    expect(grantMatches(grant({ serverId: 'srv_other' }), ctx(args), 0)).toBe(false)
    expect(grantMatches(grant(), ctx(args), 10_001)).toBe(false)
    expect(grantMatches(grant({ remaining: 0 }), ctx(args), 0)).toBe(false)
    expect(grantMatches(grant({ revokedAt: 5 }), ctx(args), 0)).toBe(false)
  })

  it('honours session binding only when it was asked for', () => {
    const args = { site: 'blog.example.com' }
    expect(grantMatches(grant({ sessionId: 'ses_b' }), ctx(args), 0)).toBe(false)
    expect(grantMatches(grant({ sessionId: 'ses_a' }), ctx(args), 0)).toBe(true)
    // Unbound grants survive the client restart that ends a session.
    expect(grantMatches(grant({ sessionId: null }), ctx(args), 0)).toBe(true)
  })

  it('names the condition that failed so a block can explain itself', () => {
    const failed = failedConstraint(grant(), { site: 'evil.example.com' })
    expect(failed?.path).toBe('site')
    expect(failedConstraint(grant(), { site: 'blog.example.com' })).toBeNull()
  })
})

describe('grant bounds', () => {
  const base = {
    minutes: 30,
    maxCalls: 10,
    tools: ['wp_update_post'],
    constraints: [{ path: 'site', op: 'eq' as const, values: ['blog.example.com'] }]
  }

  it('accepts a bounded spec', () => {
    expect(validateGrantSpec(base, looksLikeSecret)).toBeNull()
  })

  it('refuses an unbounded duration or call count', () => {
    expect(validateGrantSpec({ ...base, minutes: 0 }, looksLikeSecret)).not.toBeNull()
    expect(validateGrantSpec({ ...base, minutes: 10_080 }, looksLikeSecret)).not.toBeNull()
    expect(validateGrantSpec({ ...base, maxCalls: 0 }, looksLikeSecret)).not.toBeNull()
    expect(validateGrantSpec({ ...base, maxCalls: 100_000 }, looksLikeSecret)).not.toBeNull()
    expect(validateGrantSpec({ ...base, minutes: 30.5 }, looksLikeSecret)).not.toBeNull()
  })

  it('refuses a credential pinned into a permission record', () => {
    const spec = { ...base, constraints: [{ path: 'token', op: 'eq' as const, values: [secret] }] }
    expect(validateGrantSpec(spec, looksLikeSecret)?.message).toContain('credential')
  })

  it('refuses no tools, duplicate tools and duplicate conditions', () => {
    expect(validateGrantSpec({ ...base, tools: [] }, looksLikeSecret)).not.toBeNull()
    expect(validateGrantSpec({ ...base, tools: ['a', 'a'] }, looksLikeSecret)).not.toBeNull()
    expect(
      validateGrantSpec(
        {
          ...base,
          constraints: [
            { path: 'site', op: 'eq', values: ['a'] },
            { path: 'site', op: 'eq', values: ['b'] }
          ]
        },
        looksLikeSecret
      )
    ).not.toBeNull()
  })

  it('refuses a comparison with nothing to compare against', () => {
    expect(validateGrantSpec({ ...base, constraints: [{ path: 'site', op: 'in', values: [] }] }, looksLikeSecret)).not.toBeNull()
    expect(validateGrantSpec({ ...base, constraints: [{ path: 'site', op: 'eq', values: ['a', 'b'] }] }, looksLikeSecret)).not.toBeNull()
  })
})

describe('proposed scope', () => {
  it('pins identifiers, frees payloads, and never offers a credential', () => {
    const proposed = proposeConstraints(
      { site: 'blog.example.com', id: 42, body: 'x'.repeat(400), meta: { a: 1 }, token: secret },
      looksLikeSecret
    )
    const byPath = Object.fromEntries(proposed.map((c) => [c.path, c]))
    expect(byPath.site).toMatchObject({ op: 'eq', values: ['blog.example.com'] })
    expect(byPath.id).toMatchObject({ op: 'eq', values: ['42'] })
    expect(byPath.body?.op).toBe('any')
    expect(byPath.meta?.op).toBe('any')
    expect(byPath.token?.op).toBe('any')
    expect(JSON.stringify(proposed)).not.toContain(secret)
  })

  it('reads back as the scope the user authorised', () => {
    expect(
      describeGrant({
        tools: ['wp_get_post', 'wp_update_post'],
        constraints: [
          { path: 'site', op: 'eq', values: ['blog.example.com'] },
          { path: 'content', op: 'any', values: [] }
        ],
        minutes: 45,
        maxCalls: 12
      })
    ).toBe('wp_get_post, wp_update_post — site = blog.example.com — 12 calls within 45 min')
  })
})

describe('identifier heuristic', () => {
  it('treats targets as identifiers', () => {
    for (const value of ['blog.example.com', '412', 'draft', '/srv/site/index.php', 'a@b.test', 'Fix the header'])
      expect(looksLikeIdentifier(value)).toBe(true)
  })

  it('treats prose and structures as payload', () => {
    // A pinned payload is the exact-digest failure all over again.
    expect(looksLikeIdentifier('A synthetic body long enough to be treated as a payload not an identifier')).toBe(false)
    expect(looksLikeIdentifier('line one\nline two')).toBe(false)
    expect(looksLikeIdentifier('x'.repeat(81))).toBe(false)
    expect(looksLikeIdentifier('')).toBe(false)
  })

  it('leaves a realistic post edit usefully scoped', () => {
    const proposed = proposeConstraints(
      {
        site: 'blog.example.test',
        post_id: 412,
        status: 'draft',
        content: 'A synthetic body long enough to be treated as a payload rather than an identifier, so it arrives unpinned.'
      },
      looksLikeSecret
    )
    const ops = Object.fromEntries(proposed.map((c) => [c.path, c.op]))
    expect(ops).toEqual({ site: 'eq', post_id: 'eq', status: 'eq', content: 'any' })
  })

  it('keeps one long value from swallowing the summary', () => {
    const line = describeGrant({
      tools: ['t'],
      constraints: [{ path: 'title', op: 'eq', values: ['y'.repeat(200)] }],
      minutes: 30,
      maxCalls: 5
    })
    expect(line).toContain('…')
    expect(line.length).toBeLessThan(140)
  })
})
