import { describe, expect, it } from 'vitest'
import {
  OFFICIAL_REGISTRY_KEYS,
  OFFICIAL_SERVERS,
  officialIconDomain,
  officialRequiresAuth
} from '@shared/official'
import { assessFirstParty } from '@shared/firstparty'

describe('official directory', () => {
  it('has a unique id per entry', () => {
    const ids = OFFICIAL_SERVERS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('has a unique endpoint per entry', () => {
    const urls = OFFICIAL_SERVERS.map((s) => s.url)
    expect(new Set(urls).size).toBe(urls.length)
  })

  it('only lists https endpoints', () => {
    for (const s of OFFICIAL_SERVERS) {
      expect(s.url.startsWith('https://'), `${s.id} -> ${s.url}`).toBe(true)
    }
  })

  it('serves every entry from the vendor’s own domain', () => {
    // This is the property that makes the list "official" rather than curated
    // taste: the endpoint host must belong to the vendor's own domain.
    for (const s of OFFICIAL_SERVERS) {
      const host = new URL(s.url).host
      const ok = host === s.domain || host.endsWith(`.${s.domain}`)
      expect(ok, `${s.id}: ${host} is not under ${s.domain}`).toBe(true)
    }
  })

  it('records how each endpoint was confirmed', () => {
    for (const s of OFFICIAL_SERVERS) {
      expect(['mcp-oauth', 'mcp-open']).toContain(s.evidence)
    }
  })

  it('describes every entry, so no row renders blank', () => {
    for (const s of OFFICIAL_SERVERS) {
      expect(s.title.trim().length, s.id).toBeGreaterThan(0)
      expect(s.description.trim().length, s.id).toBeGreaterThan(10)
      expect(s.category.trim().length, s.id).toBeGreaterThan(0)
    }
  })

  it('agrees with the first-party check it claims to encode', () => {
    for (const s of OFFICIAL_SERVERS) {
      // Namespace form the registry would use for this vendor.
      const ns = s.domain.split('.').reverse().join('.')
      expect(assessFirstParty(ns, [s.url]).firstParty, s.id).toBe(true)
    }
  })

  it('promotes registry entries by fully-qualified name', () => {
    for (const key of OFFICIAL_REGISTRY_KEYS) {
      expect(key, key).toMatch(/^[a-z0-9.-]+\/[A-Za-z0-9._-]+$/)
    }
    expect(new Set(OFFICIAL_REGISTRY_KEYS).size).toBe(OFFICIAL_REGISTRY_KEYS.length)
  })

  it('does not duplicate a vendor between bundled and promoted lists', () => {
    const bundledDomains = new Set(OFFICIAL_SERVERS.map((s) => s.domain))
    for (const key of OFFICIAL_REGISTRY_KEYS) {
      const ns = key.split('/')[0]!
      const domain = ns.split('.').reverse().join('.')
      expect(bundledDomains.has(domain), `${key} duplicates a bundled entry`).toBe(false)
    }
  })
})

describe('curated auth knowledge', () => {
  it('flags every OAuth-protected entry as requiring sign-in', () => {
    for (const s of OFFICIAL_SERVERS.filter((x) => x.evidence === 'mcp-oauth')) {
      expect(officialRequiresAuth(s.id), s.id).toBe(true)
    }
  })

  it('does not claim sign-in for endpoints that answered openly', () => {
    for (const s of OFFICIAL_SERVERS.filter((x) => x.evidence === 'mcp-open')) {
      expect(officialRequiresAuth(s.id), s.id).toBe(false)
    }
  })

  it('knows nothing about entries outside the directory', () => {
    expect(officialRequiresAuth('io.github.someone/thing')).toBe(false)
  })
})

describe('icon domain overrides', () => {
  it('overrides where the endpoint domain is not the brand domain', () => {
    // Google serves MCP from googleapis.com, GitHub from githubcopilot.com;
    // neither hosts the brand favicon.
    expect(officialIconDomain('off_gdrive')).toBe('google.com')
    expect(officialIconDomain('off_github')).toBe('github.com')
    expect(officialIconDomain('off_sentry')).toBe('sentry.io')
  })

  it('falls back to the endpoint domain when no override is needed', () => {
    expect(officialIconDomain('off_slack')).toBe('slack.com')
  })

  it('returns null for anything not in the directory', () => {
    expect(officialIconDomain('io.github.someone/thing')).toBeNull()
  })
})
