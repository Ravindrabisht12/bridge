import { describe, expect, it } from 'vitest'
import { suggestName } from '@shared/install'

describe('suggested config name', () => {
  it('does not collapse a vendor/mcp name to "mcp"', () => {
    // com.gitlab/mcp used to produce the literal config key "mcp".
    expect(suggestName('com.gitlab/mcp')).toBe('gitlab')
    expect(suggestName('com.notion/mcp')).toBe('notion')
    expect(suggestName('com.stripe/mcp')).toBe('stripe')
    expect(suggestName('com.figma.mcp/mcp')).toBe('figma')
  })

  it('keeps a meaningful segment', () => {
    expect(suggestName('io.github.delorenj/mcp-server-trello')).toBe('trello')
    expect(suggestName('io.github.x/weather-tools')).toBe('weather-tools')
  })

  it('always yields a config-safe key', () => {
    for (const n of ['com.gitlab/mcp', 'io.github.x/Weird Name!', 'com.a.b.mcp/server']) {
      expect(suggestName(n), n).toMatch(/^[a-z0-9._-]+$/)
    }
  })
})
