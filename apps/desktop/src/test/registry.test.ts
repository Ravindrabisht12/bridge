import { describe, expect, it } from 'vitest'
import { categorize, displayTitle, kindOf, toCatalogEntry, type RegistryEntry } from '@shared/registry'
import { assessTrust, namespaceVerification } from '@shared/trust'
import { applyInputs, planInstall, suggestName } from '@shared/install'

const entry = (over: Partial<RegistryEntry['server']> = {}, meta = {}): RegistryEntry => ({
  server: {
    name: 'io.github.delorenj/mcp-server-trello',
    description: 'MCP server for Trello boards',
    version: '1.8.1',
    repository: { url: 'https://github.com/delorenj/mcp-server-trello', source: 'github' },
    packages: [
      {
        registryType: 'npm',
        identifier: '@delorenj/mcp-server-trello',
        version: '1.8.1',
        transport: { type: 'stdio' },
        environmentVariables: [
          { name: 'TRELLO_API_KEY', description: 'Your Trello API key', isRequired: true, isSecret: true },
          { name: 'TRELLO_TOKEN', description: 'Your Trello token', isRequired: true, isSecret: true },
          { name: 'OPTIONAL_THING', isRequired: false }
        ]
      }
    ],
    ...over
  },
  _meta: {
    'io.modelcontextprotocol.registry/official': {
      status: 'active',
      isLatest: true,
      publishedAt: '2026-07-25T22:48:46Z',
      updatedAt: '2026-07-25T22:48:46Z',
      ...meta
    }
  }
})

describe('catalogue mapping', () => {
  it('flattens a registry entry', () => {
    const c = toCatalogEntry(entry())
    expect(c.name).toBe('io.github.delorenj/mcp-server-trello')
    expect(c.namespace).toBe('io.github.delorenj')
    expect(c.kind).toBe('stdio')
    expect(c.status).toBe('active')
    expect(c.updatedAt).toBeGreaterThan(0)
    // The registry publishes no popularity data.
    expect(c.downloads).toBeNull()
  })

  it('classifies transport kind', () => {
    expect(kindOf({ name: 'a', packages: [{ registryType: 'npm', identifier: 'x' }] })).toBe('stdio')
    expect(kindOf({ name: 'a', remotes: [{ type: 'streamable-http', url: 'https://x' }] })).toBe('remote')
    expect(
      kindOf({
        name: 'a',
        packages: [{ registryType: 'npm', identifier: 'x' }],
        remotes: [{ type: 'sse', url: 'https://x' }]
      })
    ).toBe('both')
    expect(kindOf({ name: 'a' })).toBe('none')
  })

  it('infers categories, falling back to other', () => {
    expect(categorize('x/trello', 'Manage boards')).toContain('productivity')
    expect(categorize('x/pg', 'A postgres database server')).toContain('data')
    expect(categorize('x/zzz', 'no idea')).toEqual(['other'])
  })
})

describe('trust assessment', () => {
  it('verifies a GitHub namespace', () => {
    expect(namespaceVerification('io.github.delorenj')).toEqual({ verified: true, how: 'GitHub account' })
    expect(namespaceVerification('com.example')).toEqual({ verified: true, how: 'DNS domain' })
    expect(namespaceVerification('randomthing')).toEqual({ verified: false, how: null })
  })

  it('rates a verified publisher with source and usage as verified', () => {
    const c = { ...toCatalogEntry(entry()), downloads: 3373, downloadsSource: 'npm' }
    const t = assessTrust(c, Date.parse('2026-08-01T00:00:00Z'))
    expect(t.level).toBe('verified')
    expect(t.warn).toBe(false)
  })

  it('flags a deprecated entry regardless of other signals', () => {
    const c = { ...toCatalogEntry(entry({}, { status: 'deprecated' })), downloads: 500_000 }
    const t = assessTrust(c)
    expect(t.level).toBe('flagged')
    expect(t.warn).toBe(true)
  })

  it('marks an unverifiable namespace unverified and warns', () => {
    const c = toCatalogEntry(entry({ name: 'sketchy/thing' }))
    const t = assessTrust(c)
    expect(t.level).toBe('unverified')
    expect(t.warn).toBe(true)
  })

  it('drops a verified publisher to community without source', () => {
    const c = toCatalogEntry(entry({ repository: undefined }))
    expect(assessTrust(c).level).toBe('community')
  })

  it('never invents a numeric score', () => {
    const t = assessTrust(toCatalogEntry(entry()))
    expect(t).not.toHaveProperty('score')
    // Download signals appear only when real data is present.
    expect(t.signals.some((s) => s.id === 'downloads')).toBe(false)
  })

  it('notes a long-stale entry', () => {
    const c = toCatalogEntry(entry())
    const t = assessTrust(c, Date.parse('2028-01-01T00:00:00Z'))
    expect(t.signals.some((s) => s.id === 'freshness' && s.tone === 'negative')).toBe(true)
  })
})

describe('install planning', () => {
  it('strips mcp boilerplate from the suggested name', () => {
    expect(suggestName('io.github.delorenj/mcp-server-trello')).toBe('trello')
    expect(suggestName('io.github.x/trello-mcp')).toBe('trello')
    expect(suggestName('io.github.x/notion')).toBe('notion')
  })

  it('plans an npm package as npx', () => {
    const r = planInstall(toCatalogEntry(entry()))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.target).toMatchObject({
      kind: 'stdio',
      command: 'npx',
      args: ['-y', '@delorenj/mcp-server-trello@1.8.1']
    })
    // Only required variables are demanded up front.
    expect(r.plan.required.map((i) => i.name)).toEqual(['TRELLO_API_KEY', 'TRELLO_TOKEN'])
    expect(r.plan.required[0]?.isSecret).toBe(true)
    expect(r.plan.prerequisite).toMatch(/Node/)
  })

  it('plans a PyPI package as uvx', () => {
    const c = toCatalogEntry(entry({ packages: [{ registryType: 'pypi', identifier: 'mcp-trello', version: '2.0' }] }))
    const r = planInstall(c)
    expect(r.ok && r.plan.target).toMatchObject({ command: 'uvx', args: ['mcp-trello@2.0'] })
  })

  it('plans a container as docker run', () => {
    const c = toCatalogEntry(entry({ packages: [{ registryType: 'oci', identifier: 'ghcr.io/x/y:1' }] }))
    const r = planInstall(c)
    expect(r.ok && r.plan.target).toMatchObject({ command: 'docker', args: ['run', '--rm', '-i', 'ghcr.io/x/y:1'] })
  })

  it('plans a hosted server as an http target', () => {
    const c = toCatalogEntry(
      entry({ packages: undefined, remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com' }] })
    )
    const r = planInstall(c)
    expect(r.ok && r.plan.target).toMatchObject({ kind: 'http', url: 'https://mcp.example.com' })
    expect(r.ok && r.plan.notes.join(' ')).toMatch(/leave your machine/)
  })

  it('prefers local when a server offers both', () => {
    const c = toCatalogEntry(entry({ remotes: [{ type: 'streamable-http', url: 'https://x' }] }))
    expect(planInstall(c, 'local').ok && planInstall(c, 'local')).toMatchObject({ plan: { target: { kind: 'stdio' } } })
    expect(planInstall(c, 'remote').ok && planInstall(c, 'remote')).toMatchObject({ plan: { target: { kind: 'http' } } })
  })

  it('refuses an mcpb bundle with an explanation', () => {
    const c = toCatalogEntry(entry({ packages: [{ registryType: 'mcpb', identifier: 'x' }] }))
    const r = planInstall(c)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error.reason).toMatch(/bundle/i)
  })

  it('refuses an entry with nothing to launch', () => {
    const c = toCatalogEntry(entry({ packages: undefined, remotes: undefined }))
    expect(planInstall(c).ok).toBe(false)
  })

  it('applies supplied values as env for a stdio target', () => {
    const r = planInstall(toCatalogEntry(entry()))
    if (!r.ok) throw new Error('expected a plan')
    const target = applyInputs(r.plan, { TRELLO_API_KEY: 'k', TRELLO_TOKEN: 't' })
    expect(target).toMatchObject({ env: { TRELLO_API_KEY: 'k', TRELLO_TOKEN: 't' } })
  })

  it('applies supplied values as headers for a remote target', () => {
    const c = toCatalogEntry(
      entry({
        packages: undefined,
        remotes: [
          { type: 'streamable-http', url: 'https://x', headers: [{ name: 'Authorization', isRequired: true, isSecret: true }] }
        ]
      })
    )
    const r = planInstall(c)
    if (!r.ok) throw new Error('expected a plan')
    expect(applyInputs(r.plan, { Authorization: 'Bearer z' })).toMatchObject({
      headers: { Authorization: 'Bearer z' }
    })
  })

  it('passes env into a container with -e flags', () => {
    const c = toCatalogEntry(
      entry({
        packages: [
          { registryType: 'oci', identifier: 'ghcr.io/x/y', environmentVariables: [{ name: 'TOK', isRequired: true }] }
        ]
      })
    )
    const r = planInstall(c)
    if (!r.ok) throw new Error('expected a plan')
    const target = applyInputs(r.plan, { TOK: 'v' })
    expect(target.kind === 'stdio' && target.args).toEqual(['run', '--rm', '-i', '-e', 'TOK', 'ghcr.io/x/y'])
  })

  it('omits empty values rather than passing blanks', () => {
    const r = planInstall(toCatalogEntry(entry()))
    if (!r.ok) throw new Error('expected a plan')
    expect(applyInputs(r.plan, { TRELLO_API_KEY: '', TRELLO_TOKEN: 't' })).toMatchObject({
      env: { TRELLO_TOKEN: 't' }
    })
  })
})

describe('category inference excludes the namespace', () => {
  it('does not classify every io.github entry as a developer tool', () => {
    // "github" appears in the namespace of most of the registry; it must not
    // leak into the classification of an unrelated server.
    expect(categorize('io.github.someone/trello-board', 'Manage Trello boards')).toEqual(['productivity'])
    expect(categorize('io.github.someone/whatsapp', 'Send messages')).toContain('comms')
  })

  it('still classifies a genuine developer tool', () => {
    expect(categorize('io.github.x/gitlab-mcp', 'Manage GitLab merge requests')).toContain('dev')
  })
})

describe('display titles', () => {
  it('keeps a real title', () => {
    expect(displayTitle('com.atlassian/atlassian-mcp-server', 'Atlassian Rovo MCP Server')).toBe(
      'Atlassian Rovo MCP Server'
    )
  })

  it('reads the vendor from the namespace when the title is generic', () => {
    // These publishers all name the server itself "mcp".
    expect(displayTitle('com.notion/mcp')).toBe('Notion')
    expect(displayTitle('com.stripe/mcp')).toBe('Stripe')
    expect(displayTitle('com.airtable/mcp')).toBe('Airtable')
    expect(displayTitle('com.webflow/mcp')).toBe('Webflow')
  })

  it('strips padding labels from the namespace', () => {
    expect(displayTitle('com.figma.mcp/mcp')).toBe('Figma')
    expect(displayTitle('com.paypal.mcp/mcp')).toBe('Paypal')
    expect(displayTitle('com.cloudflare.mcp/mcp')).toBe('Cloudflare')
  })

  it('treats a generic given title as absent', () => {
    expect(displayTitle('com.notion/mcp', 'mcp')).toBe('Notion')
    expect(displayTitle('com.notion/mcp', 'server')).toBe('Notion')
  })

  it('prefers a meaningful path segment over the namespace', () => {
    expect(displayTitle('io.github.someone/weather-tools')).toBe('weather-tools')
  })

  it('never strips the only label it has', () => {
    expect(displayTitle('com.mcp/mcp')).toBe('Mcp')
  })

  it('falls back to the name when nothing is usable', () => {
    expect(displayTitle('mcp')).toBe('mcp')
  })
})
