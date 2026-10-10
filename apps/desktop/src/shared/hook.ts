/**
 * The Claude Code hook surface.
 *
 * The most dangerous thing an agent in Claude Code can do is run a shell
 * command, and that never touches MCP. A product that only watched MCP would be
 * watching the safer half. `PreToolUse` is the documented place to see and
 * decide on the native tools — Bash, Edit, Write, Read — before they run.
 *
 * https://code.claude.com/docs/en/hooks
 */

export interface HookStatus {
  /** Hook events currently registered for this build. */
  events?: HookEvent[]
  /** Where Claude Code's user settings live. */
  settingsPath: string
  /** Absolute path to the hook entry Bridge would register. */
  command: string
  /** The settings file exists and is readable as JSON. */
  readable: boolean
  /** A Bridge hook entry is present and points at the current build. */
  installed: boolean
  /** A Bridge entry is present but names a different (stale) path. */
  stale: boolean
  problem: string | null
}

import { createHash } from 'node:crypto'

/** Synthetic server id for hook activity, so it groups in trace and coverage. */
export const HOOK_SERVER_ID = 'hook:claude-code'
export const HOOK_SERVER_NAME = 'Claude Code (native tools)'

/**
 * The payload Claude Code writes to a hook's stdin. Only the fields Bridge
 * relies on are declared; everything else is carried through as-is and never
 * trusted for identity.
 */
export interface HookInput {
  hook_event_name?: string
  session_id?: string
  transcript_path?: string
  cwd?: string
  tool_name?: string
  tool_input?: unknown
  /** Present on `PostToolUse`: whatever the tool actually returned. */
  tool_response?: unknown
}

export type HookPermission = 'allow' | 'deny' | 'ask'

/**
 * Events Bridge registers for.
 *
 * `PreToolUse` is the decision. `PostToolUse` is the only way Bridge ever
 * learns what a permitted call actually did — without it a record can say
 * "Bridge allowed this" and nothing more, which is not an answer to "what
 * happened to my site".
 */
export const HOOK_EVENTS = ['PreToolUse', 'PostToolUse'] as const
export type HookEvent = (typeof HOOK_EVENTS)[number]

/** The `PreToolUse` response shape Claude Code reads back from stdout. */
export interface HookOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse'
    permissionDecision: HookPermission
    permissionDecisionReason: string
  }
}

/**
 * Correlation key between the two hook processes.
 *
 * `PreToolUse` opens the record and `PostToolUse` finishes it, in separate
 * processes with no shared id, so both derive the same key from what they both
 * see. Arguments are included because a turn can run the same tool twice; only
 * two genuinely identical parallel calls can collide, and either row is then
 * equally correct.
 */
export function hookKey(sessionId: string, tool: string, toolInput: unknown): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical)
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.keys(value as Record<string, unknown>)
          .sort()
          .map((key) => [key, canonical((value as Record<string, unknown>)[key])])
      )
    }
    return value
  }
  return createHash('sha256')
    .update(JSON.stringify([sessionId, tool, canonical(toolInput ?? null)]) ?? '')
    .digest('hex')
    .slice(0, 32)
}

export function hookOutput(decision: HookPermission, reason: string): HookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason
    }
  }
}

/**
 * A stable, readable name for the thing being decided.
 *
 * Bash is special-cased because `Bash` alone is useless in a rule or a trace —
 * every shell command would share one name. The first word of the command is
 * what a person actually wants to write a rule about (`bash:rm`, `bash:git`),
 * and the full command still lands in the arguments.
 */
export function hookToolName(toolName: string, toolInput: unknown): string {
  const name = (toolName || 'unknown').slice(0, 80)
  if (name !== 'Bash') return name
  const command = (toolInput as { command?: unknown } | null)?.command
  if (typeof command !== 'string') return 'bash'
  const executable = command.trim().split(/[\s;|&]+/)[0] ?? ''
  const bare = executable.split('/').pop() ?? ''
  // Keep it to a plain program name; anything else stays generic.
  return /^[A-Za-z0-9._-]{1,40}$/.test(bare) ? `bash:${bare}` : 'bash'
}

/** Claude Code's own tool names, for the settings UI and the install snippet. */
export const HOOK_MATCHER = 'Bash|Edit|Write|MultiEdit|NotebookEdit|WebFetch|Read|Glob|Grep'

/**
 * The settings stanza a user adds to `~/.claude/settings.json`.
 *
 * `command` is the absolute path to the hook entry, which differs between a
 * packaged install and a checkout, so it is always rendered rather than
 * documented as a constant.
 */
export function hookSettingsSnippet(command: string): string {
  const entry = { matcher: HOOK_MATCHER, hooks: [{ type: 'command', command, timeout: 130 }] }
  return JSON.stringify(
    { hooks: Object.fromEntries(HOOK_EVENTS.map((event) => [event, [entry]])) },
    null,
    2
  )
}
