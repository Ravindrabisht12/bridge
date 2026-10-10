/**
 * Integration check against the live MCP Registry.
 *
 * Skipped unless BRIDGE_LIVE=1, so the normal suite stays offline and fast.
 * Its job is to catch the registry changing shape under us — the mapping,
 * trust and install-planning code all assume a schema we do not control.
 */
import { describe, expect, it } from 'vitest'
import { REGISTRY_BASE, toCatalogEntry, type RegistryListResponse } from '@shared/registry'
import { assessTrust } from '@shared/trust'
import { planInstall } from '@shared/install'

const live = process.env.BRIDGE_LIVE === '1'

describe.runIf(live)('live MCP Registry', () => {
  it('returns entries this codebase can map', async () => {
    const res = await fetch(`${REGISTRY_BASE}/v0/servers?version=latest&limit=50`, {
      headers: { accept: 'application/json' }
    })
    expect(res.ok).toBe(true)
    const body = (await res.json()) as RegistryListResponse
    expect(Array.isArray(body.servers)).toBe(true)
    expect(body.servers.length).toBeGreaterThan(0)

    const entries = body.servers.map((e) => toCatalogEntry(e))
    for (const e of entries) {
      expect(e.name).toBeTruthy()
      expect(e.namespace).toBeTruthy()
      expect(['stdio', 'remote', 'both', 'none']).toContain(e.kind)
      expect(Array.isArray(e.categories)).toBe(true)
      // Trust must be derivable for every real entry, never throw.
      expect(['verified', 'community', 'unverified', 'flagged']).toContain(assessTrust(e).level)
    }

    // Every launchable entry must yield a plan or a stated reason - never a crash.
    const launchable = entries.filter((e) => e.kind !== 'none')
    expect(launchable.length).toBeGreaterThan(0)
    for (const e of launchable) {
      const r = planInstall(e)
      if (r.ok) {
        if (r.plan.target.kind === 'stdio') expect(r.plan.target.command).toBeTruthy()
        else expect(r.plan.target.url).toMatch(/^https?:\/\//)
      } else {
        expect(r.error.reason.length).toBeGreaterThan(10)
      }
    }
  }, 90_000)

  it('finds trello servers and can plan one', async () => {
    const res = await fetch(`${REGISTRY_BASE}/v0/servers?search=trello&version=latest&limit=5`, {
      headers: { accept: 'application/json' }
    })
    const body = (await res.json()) as RegistryListResponse
    const entries = body.servers.map((e) => toCatalogEntry(e))
    expect(entries.length).toBeGreaterThan(0)

    const npmOne = entries.find((e) => e.packages.some((p) => p.registryType === 'npm'))
    expect(npmOne, 'expected at least one npm-packaged trello server').toBeTruthy()
    const r = planInstall(npmOne!)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.plan.target.kind).toBe('stdio')
  }, 90_000)

  it('npm publishes the usage numbers the library shows', async () => {
    const res = await fetch(
      'https://api.npmjs.org/downloads/point/last-week/%40modelcontextprotocol%2Fserver-filesystem'
    )
    const body = (await res.json()) as { downloads?: number }
    expect(typeof body.downloads).toBe('number')
    expect(body.downloads!).toBeGreaterThan(0)
  }, 30_000)
})
