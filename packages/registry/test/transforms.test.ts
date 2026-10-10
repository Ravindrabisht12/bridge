/**
 * The pure transforms. Each of these encodes a bug that reached a screenshot.
 */
import { describe, expect, it } from 'vitest'
import { categorize, displayTitle, kindOf, pickIcon } from '../src/schema'

describe('categorize', () => {
  it('reads the local name only, never the namespace', () => {
    // Every io.github.* entry contains "github". Including the namespace put
    // 18,528 of 27,213 entries into "developer tools".
    expect(categorize('io.github.someone/weather-api', 'Current conditions')).not.toContain('dev')
  })

  it('still categorises a genuinely developer-y name', () => {
    expect(categorize('io.github.someone/docker-tools', 'Manage containers')).toContain('dev')
  })

  it('falls back to "other" rather than guessing', () => {
    expect(categorize('com.example/thing', 'A thing')).toEqual(['other'])
  })
})

describe('displayTitle', () => {
  it('takes the vendor from the namespace when the name is generic', () => {
    // Notion, Stripe, PayPal, Wix and Cloudflare all publish `<vendor>/mcp`
    // with no title. Using the path segment renders a page of rows called "mcp".
    expect(displayTitle('com.notion/mcp')).toBe('Notion')
    expect(displayTitle('com.stripe/mcp-server')).toBe('Stripe')
  })

  it('strips reverse-DNS padding to find the vendor', () => {
    expect(displayTitle('com.gitlab.api/mcp')).toBe('Gitlab')
  })

  it('prefers a real given title', () => {
    expect(displayTitle('com.notion/mcp', 'Notion Workspace')).toBe('Notion Workspace')
  })

  it('ignores a title that is only boilerplate', () => {
    // The list is anchored and exact: `mcp`, `mcp-server`, `server`, `api`
    // and friends. A bare one of those is worthless as a name.
    expect(displayTitle('com.notion/thing', 'mcp')).toBe('thing')
    expect(displayTitle('com.notion/thing', 'mcp-server')).toBe('thing')
    expect(displayTitle('com.notion/thing', 'API')).toBe('thing')
  })

  it('keeps a descriptive title that merely starts with boilerplate', () => {
    // 12 real entries are named like this. Widening the boilerplate match to
    // catch "MCP Server" with a space would eat all of them, and no real entry
    // uses the bare form — so the regex stays anchored and exact.
    expect(displayTitle('io.github.x/ppt', 'MCP Server for PowerPoint')).toBe('MCP Server for PowerPoint')
    expect(displayTitle('io.github.x/ynab', 'MCP Server for YNAB')).toBe('MCP Server for YNAB')
  })
})

describe('pickIcon', () => {
  it('prefers a raster icon over SVG', () => {
    // SVG is executable markup; a cache that never reasons about embedded
    // script is a simpler thing to trust.
    expect(
      pickIcon([
        { src: 'a.svg', mimeType: 'image/svg+xml' },
        { src: 'b.png', mimeType: 'image/png' }
      ])
    ).toBe('b.png')
  })

  it('falls back to SVG when it is all that is offered', () => {
    expect(pickIcon([{ src: 'a.svg', mimeType: 'image/svg+xml' }])).toBe('a.svg')
  })

  it('returns null for nothing', () => {
    expect(pickIcon(undefined)).toBeNull()
    expect(pickIcon([])).toBeNull()
  })
})

describe('kindOf', () => {
  it('distinguishes local, hosted, both and neither', () => {
    expect(kindOf({ name: 'x', packages: [{ registryType: 'npm', identifier: 'a' }] })).toBe('stdio')
    expect(kindOf({ name: 'x', remotes: [{ type: 'sse', url: 'https://a' }] })).toBe('remote')
    expect(
      kindOf({ name: 'x', packages: [{ registryType: 'npm', identifier: 'a' }], remotes: [{ type: 'sse', url: 'https://a' }] })
    ).toBe('both')
    expect(kindOf({ name: 'x' })).toBe('none')
  })
})
