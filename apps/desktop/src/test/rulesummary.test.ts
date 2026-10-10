import { describe, expect, it } from 'vitest'
import { alternatives, describeToolPattern, summarizeRule } from '@shared/rulesummary'

describe('reading a matcher back as words', () => {
  it('pulls alternatives out of a regex group', () => {
    expect(alternatives('re:(exec|shell|bash)')).toEqual(['exec', 'shell', 'bash'])
    expect(alternatives('re:^(get|read|list)')).toEqual(['get', 'read', 'list'])
  })

  it('returns nothing for a single term, which needs no list', () => {
    expect(alternatives('re:(delete)')).toEqual([])
    expect(alternatives('trello')).toEqual([])
  })

  it('does not choke on a regex it cannot simplify', () => {
    expect(alternatives('re:^[a-z]{3,}\\d+$')).toEqual([])
  })
})

describe('tool pattern descriptions', () => {
  it('says "any tool" for a wildcard', () => {
    expect(describeToolPattern('*')).toBe('Any tool')
    expect(describeToolPattern(undefined)).toBe('Any tool')
  })

  it('lists alternatives, and distinguishes anchored ones', () => {
    expect(describeToolPattern('re:(delete|remove|drop)')).toBe('Tools mentioning delete, remove, drop')
    expect(describeToolPattern('re:^(get|read)')).toBe('Tools starting with get, read')
  })

  it('truncates a long list rather than running off the row', () => {
    const text = describeToolPattern('re:(a|b|c|d|e|f)')
    expect(text).toContain('and 2 more')
  })

  it('falls back to showing the pattern when it cannot be simplified', () => {
    expect(describeToolPattern('re:^x[0-9]+')).toBe('Tools matching /^x[0-9]+/')
  })

  it('handles globs and exact names', () => {
    expect(describeToolPattern('send_*')).toBe('Tools named like "send_*"')
    expect(describeToolPattern('delete_card')).toBe('The tool "delete_card"')
  })
})

describe('rule summaries', () => {
  it('states the effect and subject', () => {
    const s = summarizeRule({ tool: 're:(delete|drop)' }, 'deny')
    expect(s.effect).toBe('Is blocked')
    expect(s.subject).toBe('Tools mentioning delete, drop')
    expect(s.conditions).toEqual([])
  })

  it('names a server by label rather than id', () => {
    const s = summarizeRule({ tool: '*', serverId: 'srv_1' }, 'ask', (id) => (id === 'srv_1' ? 'trello' : id))
    expect(s.conditions).toContain('only on trello')
  })

  it('reads a client restriction as a surface', () => {
    const s = summarizeRule({ tool: '*', clientName: 're:(cowork|agent)' }, 'deny')
    expect(s.conditions).toContain('only from cowork or agent')
  })

  it('describes an argument condition precisely', () => {
    const s = summarizeRule({ tool: '*', argPath: 'path', argMatches: '\\.env$' }, 'deny')
    expect(s.conditions[0]).toBe('when the "path" argument matches /\\.env$/')
  })

  it('mentions a bare argument path with no regex', () => {
    const s = summarizeRule({ tool: '*', argPath: 'token' }, 'ask')
    expect(s.conditions[0]).toContain('a "token" argument is present')
  })

  it('ignores the default method but names an unusual one', () => {
    expect(summarizeRule({ tool: '*', method: 'tools/call' }, 'allow').conditions).toEqual([])
    expect(summarizeRule({ tool: '*', method: 'resources/read' }, 'allow').conditions).toContain(
      'on resources/read'
    )
  })
})

describe('long patterns do not swamp the sentence', () => {
  it('refers to a long argument regex instead of quoting it', () => {
    const long = '(^|[/\\\\"\'\\s])(\\.env(\\.[\\w-]+)?|id_rsa|id_ed25519|\\.ssh/|\\.aws/credentials)'
    const s = summarizeRule({ tool: '*', argMatches: long }, 'deny')
    expect(s.conditions[0]).toBe('when any argument matches a pattern')
    expect(s.conditions[0]).not.toContain('id_rsa')
  })

  it('still quotes a short one, which is more informative', () => {
    const s = summarizeRule({ tool: '*', argPath: 'path', argMatches: '\\.env$' }, 'deny')
    expect(s.conditions[0]).toContain('/\\.env$/')
  })
})
