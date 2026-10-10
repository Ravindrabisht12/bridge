import { describe, expect, it } from 'vitest'
import { DEFAULT_TAB, parseHash, toHash, TABS } from '@shared/route'

describe('hash routing', () => {
  it('reads a plain tab', () => {
    expect(parseHash('#/servers')).toEqual({ tab: 'servers', param: null })
    expect(parseHash('#/library')).toEqual({ tab: 'library', param: null })
  })

  it('falls back to the default for an empty or unknown hash', () => {
    expect(parseHash('')).toEqual({ tab: DEFAULT_TAB, param: null })
    expect(parseHash('#')).toEqual({ tab: DEFAULT_TAB, param: null })
    expect(parseHash('#/nonsense')).toEqual({ tab: DEFAULT_TAB, param: null })
  })

  it('round-trips a catalogue key containing a slash', () => {
    // Registry names are `namespace/name`, so the param must survive encoding.
    const route = { tab: 'library' as const, param: 'io.github.delorenj/mcp-server-trello' }
    expect(parseHash(toHash(route))).toEqual(route)
  })

  it('round-trips every tab', () => {
    for (const tab of TABS) {
      expect(parseHash(toHash({ tab, param: null }))).toEqual({ tab, param: null })
    }
  })

  it('handles a param with characters that need escaping', () => {
    const route = { tab: 'library' as const, param: 'a b/c#d?e' }
    expect(parseHash(toHash(route))).toEqual(route)
  })

  it('tolerates a malformed percent-encoding rather than throwing', () => {
    expect(() => parseHash('#/library/%E0%A4%A')).not.toThrow()
    expect(parseHash('#/library/%E0%A4%A').tab).toBe('library')
  })

  it('accepts a hash with no leading slash', () => {
    expect(parseHash('#servers')).toEqual({ tab: 'servers', param: null })
  })

  it('omits the param from the hash when there is none', () => {
    expect(toHash({ tab: 'policy', param: null })).toBe('#/policy')
  })
})
