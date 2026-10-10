import { describe, expect, it, vi } from 'vitest'
import { probeEndpoint } from '../src/stages/probe'
import { publicAddress } from '../src/network'
const target = { key: 'test', endpoint: 'https://mcp.example.com/mcp', vendorDomain: 'example.com' }
const now = () => new Date('2026-09-01')
describe('verification evidence', () => {
  it('rejects a vendor-domain mismatch before fetching', async () => {
    const fetcher = vi.fn()
    expect((await probeEndpoint({ ...target, endpoint: 'https://example.com.attacker.com/' }, now, fetcher)).outcome).toBe('refused')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('rejects bare WAF errors and HTML success pages', async () => {
    for (const status of [200, 401, 403]) {
      const fetcher = vi.fn(async () => new Response('not MCP', { status }))
      expect((await probeEndpoint(target, now, fetcher)).outcome).toBe('refused')
    }
  })
  it('accepts a valid initialize response', async () => {
    const fetcher = vi.fn(async () => Response.json({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'test' }, capabilities: {} } }))
    expect((await probeEndpoint(target, now, fetcher)).outcome).toBe('ok')
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' })
  })
  it('excludes private and local addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '172.16.1.1', '192.168.1.1', '::1', '::ffff:127.0.0.1', 'fe80::1']) expect(publicAddress(ip)).toBe(false)
    expect(publicAddress('8.8.8.8')).toBe(true)
  })
})
