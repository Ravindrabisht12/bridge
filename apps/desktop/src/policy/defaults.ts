import type { PolicyRule } from '@shared/types'

const now = () => Date.now()

/**
 * Seeded on first launch. Deliberately conservative: nothing is denied
 * outright, but anything destructive or outbound asks first.
 */
export function defaultRules(): PolicyRule[] {
  const base = now()
  const rule = (
    i: number,
    name: string,
    priority: number,
    effect: PolicyRule['effect'],
    match: PolicyRule['match'],
    description: string
  ): PolicyRule => ({
    id: `builtin_${i}`,
    enabled: true,
    priority,
    name,
    description,
    match,
    effect,
    createdAt: base + i,
    updatedAt: base + i
  })

  return [
    rule(1, 'Block reads of credential files', 10, 'deny', {
      tool: '*',
      argMatches: '(^|[/\\\\"\'\\s])(\\.env(\\.[\\w-]+)?|id_rsa|id_ed25519|\\.ssh/|\\.aws/credentials|\\.npmrc|\\.pgpass)'
    }, 'Any tool call whose arguments reference a well-known secret file is refused.'),

    rule(2, 'Confirm before deleting', 20, 'ask', {
      tool: 're:(delete|remove|drop|destroy|purge|truncate)'
    }, 'Destructive tools require a human click.'),

    rule(3, 'Confirm before sending messages', 21, 'ask', {
      tool: 're:(send|post|publish|email|message|notify|reply|tweet|dm)'
    }, 'Anything that speaks on your behalf asks first.'),

    rule(4, 'Confirm writes and updates', 30, 'ask', {
      tool: 're:(write|update|create|insert|upload|append|move|rename|patch|set_)'
    }, 'Mutating tools ask before running.'),

    rule(5, 'Confirm shell execution', 15, 'ask', {
      tool: 're:(exec|shell|bash|terminal|command|run_code|python|eval)'
    }, 'Arbitrary code execution always asks.'),

    rule(6, 'Allow reads', 90, 'allow', {
      tool: 're:^(get|read|list|search|fetch|query|find|view|describe|show)'
    }, 'Read-only tools run without interruption.')
  ]
}
