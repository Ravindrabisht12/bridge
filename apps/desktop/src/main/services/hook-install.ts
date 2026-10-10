/**
 * Installs and removes Bridge's `PreToolUse` entry in Claude Code's settings.
 *
 * The transformation itself lives in `@shared/hook-settings`, which has no
 * filesystem access and is directly tested — this file is only the IO around
 * it: read, refuse to touch what it cannot parse, back up once, write
 * atomically.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic, writePrivateFile } from '@shared/private-fs'
import { homedir } from 'node:os'
import { app } from 'electron'
import { HOOK_EVENTS, HOOK_MATCHER, type HookEvent, type HookStatus } from '@shared/hook'
import {
  type ClaudeSettings,
  addBridgeHook,
  bridgeHookCommands,
  removeBridgeHook
} from '@shared/hook-settings'

/**
 * Claude Code kills a hook that overruns. This sits above the hook's own
 * approval ceiling so a prompt waiting on a person is not cut off mid-decision.
 */
const HOOK_TIMEOUT_SECONDS = 130

export function claudeCodeSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json')
}

/** Path to the built hook entry, as a real file Claude Code can execute. */
export function hookScriptPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'app.asar.unpacked', 'out', 'main', 'hook.js')
  }
  return join(app.getAppPath(), 'out', 'main', 'hook.js')
}

/**
 * The command string Claude Code runs.
 *
 * The hook is a Node script that needs Electron's Node — the same requirement
 * the proxy has, for the same native-module reason — so it is invoked through
 * the Electron binary in Node mode rather than whatever `node` is on PATH.
 */
export function hookCommand(): string {
  return `ELECTRON_RUN_AS_NODE=1 ${quote(process.execPath)} ${quote(hookScriptPath())}`
}

/**
 * Always quoted. Quoting only when a path "looked" unsafe missed `;`, `&`,
 * `|`, `(` and friends, so an install path containing one would have run as
 * shell inside Claude Code's hook command.
 */
function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function readSettings(path: string): { data: ClaudeSettings | null; problem: string | null } {
  if (!existsSync(path)) return { data: {}, problem: null }
  try {
    const text = readFileSync(path, 'utf8')
    const parsed = text.trim() ? JSON.parse(text) : {}
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { data: null, problem: 'The settings file is not a JSON object.' }
    }
    return { data: parsed as ClaudeSettings, problem: null }
  } catch (err) {
    // Never rewrite a file we could not parse: that would discard the user's own
    // configuration, including hooks belonging to other tools.
    return { data: null, problem: `The settings file is not valid JSON (${(err as Error).message}).` }
  }
}

/**
 * Writes atomically, keeping a one-off backup the first time Bridge touches the
 * file. Editing somebody's editor configuration in place deserves both.
 */
function writeSettings(path: string, data: ClaudeSettings): void {
  const backup = `${path}.bridge-backup`
  if (existsSync(path) && !existsSync(backup)) {
    try {
      writePrivateFile(backup, readFileSync(path))
    } catch {
      /* a missing backup must not stop the edit */
    }
  }
  writeFileAtomic(path, JSON.stringify(data, null, 2) + '\n')
}

export function hookStatus(): HookStatus {
  const settingsPath = claudeCodeSettingsPath()
  const command = hookCommand()
  const { data, problem } = readSettings(settingsPath)

  if (!data) {
    return { settingsPath, command, readable: false, installed: false, stale: false, problem }
  }

  const byEvent = bridgeHookCommands(data, HOOK_EVENTS)
  const events = HOOK_EVENTS.filter((event) => (byEvent[event] ?? []).includes(command))
  const anyRegistered = HOOK_EVENTS.some((event) => (byEvent[event] ?? []).length > 0)
  // Both events must point at this build. PreToolUse alone still decides calls
  // but never learns their outcome, which is a partial install, not a working
  // one — so it is reported as stale rather than installed.
  return {
    settingsPath,
    command,
    readable: true,
    installed: events.length === HOOK_EVENTS.length,
    events: events as HookEvent[],
    // A Bridge entry naming a different path — an older install, or a moved
    // checkout — is registered but will never run this build.
    stale: events.length !== HOOK_EVENTS.length && anyRegistered,
    problem: null
  }
}

export function installHook(): HookStatus {
  const settingsPath = claudeCodeSettingsPath()
  const { data, problem } = readSettings(settingsPath)
  if (!data) {
    throw new Error(
      `${problem} Bridge did not change ${settingsPath}. Fix the file, or add the hook by hand.`
    )
  }
  writeSettings(settingsPath, addBridgeHook(data, hookCommand(), HOOK_MATCHER, HOOK_TIMEOUT_SECONDS, HOOK_EVENTS))
  return hookStatus()
}

export function uninstallHook(): HookStatus {
  const settingsPath = claudeCodeSettingsPath()
  const { data, problem } = readSettings(settingsPath)
  if (!data) throw new Error(`${problem} Bridge did not change ${settingsPath}.`)
  writeSettings(settingsPath, removeBridgeHook(data, HOOK_EVENTS))
  return hookStatus()
}
