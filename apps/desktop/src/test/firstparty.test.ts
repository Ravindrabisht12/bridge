import { describe, expect, it } from 'vitest'
import { assessFirstParty, namespaceToDomain, sameDomain } from '@shared/firstparty'

describe('namespace to domain', () => {
  it('reverses reverse-DNS namespaces', () => {
    expect(namespaceToDomain('com.atlassian')).toBe('atlassian.com')
    expect(namespaceToDomain('com.figma.mcp')).toBe('mcp.figma.com')
    expect(namespaceToDomain('app.linear')).toBe('linear.app')
  })

  it('refuses code-host namespaces, which name an author not a vendor', () => {
    expect(namespaceToDomain('io.github.someone')).toBeNull()
    expect(namespaceToDomain('io.gitlab.someone')).toBeNull()
  })

  it('refuses anything that is not a domain', () => {
    expect(namespaceToDomain('plainname')).toBeNull()
    expect(namespaceToDomain('')).toBeNull()
  })
})

describe('same domain', () => {
  it('matches a subdomain in either direction', () => {
    expect(sameDomain('mcp.atlassian.com', 'atlassian.com')).toBe(true)
    expect(sameDomain('figma.com', 'mcp.figma.com')).toBe(true)
    expect(sameDomain('a.b.com', 'a.b.com')).toBe(true)
  })

  it('does not match a lookalike suffix', () => {
    // "notatlassian.com" must not pass as a subdomain of "atlassian.com".
    expect(sameDomain('notatlassian.com', 'atlassian.com')).toBe(false)
    expect(sameDomain('atlassian.com.evil.net', 'atlassian.com')).toBe(false)
  })
})

describe('first-party assessment', () => {
  it('confirms the real vendor endpoints', () => {
    // Every URL here was probed live and answered 401 (OAuth required).
    const cases: Array<[string, string]> = [
      ['com.atlassian', 'https://mcp.atlassian.com/v1/mcp'],
      ['com.figma.mcp', 'https://mcp.figma.com/mcp'],
      ['com.notion', 'https://mcp.notion.com/mcp'],
      ['app.linear', 'https://mcp.linear.app/mcp'],
      ['com.stripe', 'https://mcp.stripe.com'],
      ['com.supabase', 'https://mcp.supabase.com/mcp']
    ]
    for (const [ns, url] of cases) {
      expect(assessFirstParty(ns, [url]).firstParty, `${ns} -> ${url}`).toBe(true)
    }
  })

  it('is about ownership, not fame — a small vendor is equally first-party', () => {
    expect(assessFirstParty('app.seatcanvas', ['https://www.seatcanvas.app/api/mcp']).firstParty).toBe(true)
  })

  it('rejects a community entry hosted on someone else’s domain', () => {
    expect(assessFirstParty('io.github.someone', ['https://mcp.atlassian.com/v1/mcp']).firstParty).toBe(false)
    expect(assessFirstParty('com.someoneelse', ['https://mcp.atlassian.com/v1/mcp']).firstParty).toBe(false)
  })

  it('cannot be checked for a locally-run server, and says so rather than guessing', () => {
    expect(assessFirstParty('com.atlassian', [])).toEqual({
      firstParty: false,
      domain: 'atlassian.com',
      matchedHost: null
    })
  })

  it('survives a malformed url', () => {
    expect(assessFirstParty('com.atlassian', ['not a url']).firstParty).toBe(false)
  })

  it('reports the host that matched, for display', () => {
    expect(assessFirstParty('com.atlassian', ['https://mcp.atlassian.com/v1/mcp']).matchedHost).toBe(
      'mcp.atlassian.com'
    )
  })
})
