/**
 * Pure transformations on Claude Code's settings object.
 *
 * Bridge edits a file the user owns and other tools also write to, so this is
 * kept free of filesystem and Electron access: the part that can destroy
 * somebody's configuration is the part that has to be directly testable.
 *
 * Every operation is surgical. Bridge's own entry is recognised by the hook
 * script path, only that entry is added or removed, and every other hook,
 * matcher and unrelated key is carried through untouched.
 */

export interface HookCommand {
  type?: string
  command?: string
  timeout?: number
}

export interface HookMatcher {
  matcher?: string
  hooks?: HookCommand[]
}

export type ClaudeSettings = Record<string, unknown>

/** Written on one platform and read on another, so both separators count. */
const BRIDGE_HOOK = /out[\\/]main[\\/]hook\.js/

export function isBridgeHook(entry: HookCommand | null | undefined): boolean {
  return typeof entry?.command === 'string' && BRIDGE_HOOK.test(entry.command)
}

export function eventEntries(data: ClaudeSettings, event: string): HookMatcher[] {
  const hooks = data.hooks
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return []
  const entries = (hooks as Record<string, unknown>)[event]
  return Array.isArray(entries) ? (entries as HookMatcher[]) : []
}

/**
 * Bridge's registered command per event.
 *
 * Reported per event rather than as one list because the two do different jobs
 * and can drift apart: `PreToolUse` alone still decides calls, but their
 * outcome is never learned, and the UI has to be able to say so.
 */
export function bridgeHookCommands(data: ClaudeSettings, events: readonly string[]): Record<string, string[]> {
  return Object.fromEntries(
    events.map((event) => [
      event,
      eventEntries(data, event)
        .flatMap((matcher) => matcher.hooks ?? [])
        .filter(isBridgeHook)
        .map((entry) => entry.command as string)
    ])
  )
}

function hooksObject(data: ClaudeSettings): Record<string, unknown> {
  const hooks = data.hooks
  return hooks && typeof hooks === 'object' && !Array.isArray(hooks)
    ? { ...(hooks as Record<string, unknown>) }
    : {}
}

/**
 * Strips Bridge's entries from the matcher list.
 *
 * A matcher stanza that existed only to hold Bridge's hook is dropped with it;
 * one that also holds another tool's hook is kept, minus ours.
 */
function withoutBridge(entries: HookMatcher[]): HookMatcher[] {
  const out: HookMatcher[] = []
  for (const matcher of entries) {
    const own = matcher.hooks ?? []
    const hadOurs = own.some(isBridgeHook)
    if (!hadOurs) {
      out.push(matcher)
      continue
    }
    const kept = own.filter((entry) => !isBridgeHook(entry))
    if (kept.length > 0) out.push({ ...matcher, hooks: kept })
  }
  return out
}

/** Replaces any previous Bridge entry with exactly one per event. */
export function addBridgeHook(
  data: ClaudeSettings,
  command: string,
  matcher: string,
  timeout: number,
  events: readonly string[]
): ClaudeSettings {
  const hooks = hooksObject(data)
  for (const event of events) {
    const entries = withoutBridge(eventEntries(data, event))
    entries.push({ matcher, hooks: [{ type: 'command', command, timeout }] })
    hooks[event] = entries
  }
  return { ...data, hooks }
}

/** Removes Bridge's entries, and any container they leave empty behind them. */
export function removeBridgeHook(data: ClaudeSettings, events: readonly string[]): ClaudeSettings {
  const hooks = hooksObject(data)
  for (const event of events) {
    const entries = withoutBridge(eventEntries(data, event))
    if (entries.length > 0) hooks[event] = entries
    else delete hooks[event]
  }
  const next: ClaudeSettings = { ...data }
  if (Object.keys(hooks).length > 0) next.hooks = hooks
  else delete next.hooks
  return next
}
