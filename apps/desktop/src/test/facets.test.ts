import { describe, expect, it } from 'vitest'
import { facetsOf, hostingOf, requirementDetail } from '@shared/facets'
import { pickIcon, toCatalogEntry, type RegistryEntry } from '@shared/registry'

const make = (server: Partial<RegistryEntry['server']>): ReturnType<typeof toCatalogEntry> =>
  toCatalogEntry({
    server: { name: 'io.github.x/y', description: '', ...server },
    _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active' } }
  })

describe('hosting facet', () => {
  it('separates local, hosted and either', () => {
    expect(hostingOf(make({ packages: [{ registryType: 'npm', identifier: 'a' }] }))).toBe('local')
    expect(hostingOf(make({ remotes: [{ type: 'streamable-http', url: 'https://a' }] }))).toBe('hosted')
    expect(
      hostingOf(
        make({
          packages: [{ registryType: 'npm', identifier: 'a' }],
          remotes: [{ type: 'sse', url: 'https://a' }]
        })
      )
    ).toBe('either')
  })

  it('flags when data leaves the machine', () => {
    expect(facetsOf(make({ remotes: [{ type: 'streamable-http', url: 'https://a' }] })).sendsDataOffMachine).toBe(true)
    expect(facetsOf(make({ packages: [{ registryType: 'npm', identifier: 'a' }] })).sendsDataOffMachine).toBe(false)
  })
})

describe('setup facet', () => {
  it('treats a server with no required credentials as standalone', () => {
    const f = facetsOf(make({ packages: [{ registryType: 'npm', identifier: 'a' }] }))
    expect(f.requirement).toBe('standalone')
    expect(f.credentials).toEqual([])
  })

  it('collects required credentials from packages', () => {
    const f = facetsOf(
      make({
        packages: [
          {
            registryType: 'npm',
            identifier: 'a',
            environmentVariables: [
              { name: 'API_KEY', isRequired: true },
              { name: 'OPTIONAL', isRequired: false }
            ]
          }
        ]
      })
    )
    expect(f.requirement).toBe('needs-credentials')
    expect(f.credentials).toEqual(['API_KEY'])
  })

  it('collects required headers from hosted servers', () => {
    const f = facetsOf(
      make({
        remotes: [
          { type: 'streamable-http', url: 'https://a', headers: [{ name: 'Authorization', isRequired: true }] }
        ]
      })
    )
    expect(f.credentials).toEqual(['Authorization'])
  })

  it('deduplicates a credential declared in several places', () => {
    const f = facetsOf(
      make({
        packages: [
          { registryType: 'npm', identifier: 'a', environmentVariables: [{ name: 'TOKEN', isRequired: true }] },
          { registryType: 'pypi', identifier: 'b', environmentVariables: [{ name: 'TOKEN', isRequired: true }] }
        ]
      })
    )
    expect(f.credentials).toEqual(['TOKEN'])
  })

  it('never claims to know the price', () => {
    const detail = requirementDetail(
      facetsOf(
        make({
          packages: [{ registryType: 'npm', identifier: 'a', environmentVariables: [{ name: 'K', isRequired: true }] }]
        })
      )
    )
    // It must disclaim rather than assert. Mentioning "free" inside an explicit
    // disclaimer is fine; stating that something *is* free or paid is not.
    expect(detail).toMatch(/does not record whether that account costs anything/i)
    expect(detail).not.toMatch(/\bis free\b|\bis paid\b|\bfree tier\b|costs?\s*\$/i)
  })
})

describe('icon selection', () => {
  it('prefers a raster icon over svg', () => {
    expect(
      pickIcon([
        { src: 'https://x/a.svg', mimeType: 'image/svg+xml' },
        { src: 'https://x/a.png', mimeType: 'image/png' }
      ])
    ).toBe('https://x/a.png')
  })

  it('falls back to svg when it is all there is', () => {
    expect(pickIcon([{ src: 'https://x/a.svg', mimeType: 'image/svg+xml' }])).toBe('https://x/a.svg')
  })

  it('returns null when there are no icons', () => {
    expect(pickIcon(undefined)).toBeNull()
    expect(pickIcon([])).toBeNull()
  })

  it('flows through to the catalogue entry', () => {
    const e = make({ icons: [{ src: 'https://x/a.png', mimeType: 'image/png' }] })
    expect(e.iconUrl).toBe('https://x/a.png')
    expect(make({}).iconUrl).toBeNull()
  })
})


describe('facets are derived from transports, not a kind field', () => {
  it('reports a remote-only entry as hosted', () => {
    // The old version read `entry.kind`, which unified catalogue items lack —
    // so every hosted server rendered as "runs locally".
    expect(hostingOf({ packages: [], remotes: [{ type: 'streamable-http', url: 'https://a' }] })).toBe('hosted')
  })

  it('reports a package-only entry as local', () => {
    expect(hostingOf({ packages: [{ registryType: 'npm', identifier: 'a' }], remotes: [] })).toBe('local')
  })

  it('reports an entry offering both as either', () => {
    expect(
      hostingOf({
        packages: [{ registryType: 'npm', identifier: 'a' }],
        remotes: [{ type: 'sse', url: 'https://a' }]
      })
    ).toBe('either')
  })

  it('marks an OAuth endpoint as needing sign-in despite declaring no fields', () => {
    const f = facetsOf({
      packages: [],
      remotes: [{ type: 'streamable-http', url: 'https://mcp.slack.com/mcp' }],
      requiresAuth: true
    })
    expect(f.requirement).toBe('needs-credentials')
    expect(f.credentials).toEqual([])
    expect(requirementDetail(f)).toMatch(/sign-in happens in the browser/i)
  })

  it('still treats a credential-free local server as standalone', () => {
    const f = facetsOf({ packages: [{ registryType: 'npm', identifier: 'a' }], remotes: [] })
    expect(f.requirement).toBe('standalone')
  })
})
