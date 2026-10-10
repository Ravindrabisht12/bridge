import { describe, expect, it } from 'vitest'
import type { PolicyRule } from '@shared/types'
import { evaluate, ruleMatches, strictest } from '../policy/engine'
import { defaultRules } from '../policy/defaults'

const rule = (over: Partial<PolicyRule>): PolicyRule => ({
  id: 'r1',
  enabled: true,
  priority: 50,
  name: 'test',
  match: {},
  effect: 'ask',
  createdAt: 1,
  updatedAt: 1,
  ...over
})

describe('policy engine', () => {
  it('falls through to the default effect when nothing matches', () => {
    const d = evaluate([], { serverId: 's1', method: 'tools/call', tool: 'get_weather', args: {} }, 'allow')
    expect(d.effect).toBe('allow')
    expect(d.ruleId).toBeNull()
  })

  it('honours priority order, not array order', () => {
    const rules = [
      rule({ id: 'low', priority: 90, effect: 'allow', match: { tool: '*' } }),
      rule({ id: 'high', priority: 10, effect: 'deny', match: { tool: '*' } })
    ]
    expect(evaluate(rules, { serverId: 's', method: 'tools/call', tool: 'x', args: {} }, 'allow').ruleId).toBe('high')
  })

  it('skips disabled rules', () => {
    const rules = [rule({ id: 'off', enabled: false, effect: 'deny', match: { tool: '*' } })]
    expect(evaluate(rules, { serverId: 's', method: 'tools/call', tool: 'x', args: {} }, 'allow').effect).toBe('allow')
  })

  it('matches globs and regex patterns on the tool name', () => {
    const glob = rule({ match: { tool: 'send_*' } })
    expect(ruleMatches(glob, { serverId: 's', method: 'tools/call', tool: 'send_message', args: {} })).toBe(true)
    expect(ruleMatches(glob, { serverId: 's', method: 'tools/call', tool: 'read_message', args: {} })).toBe(false)

    const re = rule({ match: { tool: 're:(delete|drop)' } })
    expect(ruleMatches(re, { serverId: 's', method: 'tools/call', tool: 'sheet_delete_row', args: {} })).toBe(true)
    expect(ruleMatches(re, { serverId: 's', method: 'tools/call', tool: 'sheet_read_row', args: {} })).toBe(false)
  })

  it('scopes a rule to one server', () => {
    const r = rule({ match: { serverId: 's1', tool: '*' } })
    expect(ruleMatches(r, { serverId: 's1', method: 'tools/call', tool: 'x', args: {} })).toBe(true)
    expect(ruleMatches(r, { serverId: 's2', method: 'tools/call', tool: 'x', args: {} })).toBe(false)
  })

  it('matches on an argument path and regex', () => {
    const r = rule({ match: { tool: '*', argPath: 'path', argMatches: '\\.env$' } })
    expect(ruleMatches(r, { serverId: 's', method: 'tools/call', tool: 'read', args: { path: '/app/.env' } })).toBe(true)
    expect(ruleMatches(r, { serverId: 's', method: 'tools/call', tool: 'read', args: { path: '/app/main.ts' } })).toBe(false)
    // The regex applies at the path, not to a sibling argument.
    expect(ruleMatches(r, { serverId: 's', method: 'tools/call', tool: 'read', args: { other: '/app/.env' } })).toBe(false)
  })

  it('never throws on an invalid regex, and fails closed: blocks match, allows do not', () => {
    const ctx = { serverId: 's', method: 'tools/call', tool: 'x', args: {} }
    expect(ruleMatches(rule({ effect: 'deny', match: { tool: '*', argMatches: '([' } }), ctx)).toBe(true)
    expect(ruleMatches(rule({ effect: 'ask', match: { tool: 're:([' } }), ctx)).toBe(true)
    expect(ruleMatches(rule({ effect: 'allow', match: { tool: '*', argMatches: '([' } }), ctx)).toBe(false)
  })

  it('defaults the method match to tools/call', () => {
    const r = rule({ match: { tool: '*' } })
    expect(ruleMatches(r, { serverId: 's', method: 'resources/read', tool: null, args: {} })).toBe(false)
  })

  it('picks the strictest of two effects', () => {
    expect(strictest('allow', 'ask')).toBe('ask')
    expect(strictest('deny', 'ask')).toBe('deny')
    expect(strictest('allow', 'allow')).toBe('allow')
  })
})

describe('default rules', () => {
  const rules = defaultRules()
  const check = (tool: string, args: unknown = {}) =>
    evaluate(rules, { serverId: 's', method: 'tools/call', tool, args }, 'allow').effect

  it('blocks credential file access outright', () => {
    expect(check('read_file', { path: '/Users/me/.ssh/id_rsa' })).toBe('deny')
    expect(check('read_file', { path: '/srv/app/.env' })).toBe('deny')
  })

  it('asks before destructive and outbound tools', () => {
    expect(check('delete_row')).toBe('ask')
    expect(check('send_message')).toBe('ask')
    expect(check('run_shell_command')).toBe('ask')
  })

  it('lets plain reads through', () => {
    expect(check('get_weather', { city: 'Almora' })).toBe('allow')
    expect(check('list_files', { dir: '/tmp' })).toBe('allow')
  })
})

describe('client-scoped rules', () => {
  const base = {
    id: 'r',
    enabled: true,
    priority: 50,
    name: 'client rule',
    effect: 'deny' as const,
    createdAt: 1,
    updatedAt: 1
  }
  const ctx = (clientName: string | null) => ({
    serverId: 's',
    method: 'tools/call',
    tool: 'delete_card',
    args: {},
    clientName
  })

  it('matches a rule scoped to one client', () => {
    const rule = { ...base, match: { clientName: 'cowork', tool: '*' } }
    expect(ruleMatches(rule, ctx('cowork'))).toBe(true)
    expect(ruleMatches(rule, ctx('claude-desktop'))).toBe(false)
  })

  it('supports regex client patterns', () => {
    const rule = { ...base, match: { clientName: 're:(cowork|agent)', tool: '*' } }
    expect(ruleMatches(rule, ctx('cowork'))).toBe(true)
    expect(ruleMatches(rule, ctx('agent-runner'))).toBe(true)
    expect(ruleMatches(rule, ctx('chat'))).toBe(false)
  })

  it('does not match a client-scoped rule when the client is unknown', () => {
    const rule = { ...base, match: { clientName: 'cowork', tool: '*' } }
    expect(ruleMatches(rule, ctx(null))).toBe(false)
  })

  it('a wildcard or absent client still matches everything', () => {
    expect(ruleMatches({ ...base, match: { clientName: '*', tool: '*' } }, ctx(null))).toBe(true)
    expect(ruleMatches({ ...base, match: { tool: '*' } }, ctx(null))).toBe(true)
    expect(ruleMatches({ ...base, match: { tool: '*' } }, ctx('anything'))).toBe(true)
  })
})
