/**
 * Wire protocol between a proxy child process and the Bridge app.
 * Newline-delimited JSON over a unix socket (POSIX) or named pipe (Windows).
 */
import { createHash } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type {
  ApprovalRequest,
  ApprovalResult,
  CallRecord,
  ClientId,
  PolicyRule,
  SessionRecord,
  Settings,
  ToolRecord
} from './types'

/**
 * 2 added authentication to `hello`. A proxy from an older build sends no
 * token and is refused, which is the safe direction: it reconnects after the
 * app updates it, and meanwhile it keeps recording and failing closed.
 */
export const CONTROL_PROTOCOL_VERSION = 2

/**
 * Largest control frame accepted, per connection.
 *
 * Half the MCP data path's bound. A trace event carries a tool result, which
 * can legitimately be a few MB, so this cannot be small — but it must be
 * *stated*, because the socket is fed by a separate process. Over the limit the
 * decoder discards its buffer and the reader logs a framing error; the call
 * itself is still recorded to SQLite by the proxy, so the failure costs live
 * UI detail rather than evidence.
 */
export const CONTROL_MAX_FRAME_BYTES = 16 * 1024 * 1024

export type ProxyToApp =
  /**
   * First message on every connection. `token` proves the sender can read a
   * 0600 file in the app's own directory — which keeps another *user* on the
   * machine off the socket. It is not a defence against same-user malware,
   * which can read the file too; that adversary is out of scope by design.
   */
  | { t: 'hello'; v: number; session: SessionRecord; token: string }
  | { t: 'session.end'; sessionId: string; endedAt: number }
  | { t: 'session.info'; sessionId: string; serverInfo: SessionRecord['serverInfo'] }
  | { t: 'session.client'; sessionId: string; clientInfo: SessionRecord['clientInfo'] }
  | { t: 'call.start'; call: CallRecord }
  | { t: 'call.end'; call: CallRecord }
  | { t: 'approval.request'; request: ApprovalRequest }
  | { t: 'tools.updated'; serverId: string; tools: ToolRecord[]; changed: string[] }
  | { t: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; msg: string }

export type AppToProxy =
  | { t: 'welcome'; v: number; settings: Settings; rules: PolicyRule[] }
  | { t: 'approval.result'; result: ApprovalResult }
  | { t: 'config.update'; settings: Settings; rules: PolicyRule[] }
  | { t: 'tools.prefs'; serverId: string; disabled: string[] }
  | { t: 'shutdown'; sessionId?: string }

export interface ProxyBootConfig {
  serverId: string
  serverName: string
  client: ClientId
}

/** Root directory for the database, logs and the control socket. */
export function bridgeHome(): string {
  const override = process.env.BRIDGE_HOME
  if (override) return override
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Bridge')
  }
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Bridge')
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'bridge')
}

/** A directory this app used under a previous name, and the database in it. */
export interface LegacyHome {
  dir: string
  db: string
}

/**
 * Where the app kept its data under its previous names, newest first.
 *
 * The product has been renamed twice, and each rename moves the whole tree —
 * database, icon cache, config backups. Someone who installed at any point in
 * that history must end up with their data, so every past location is a
 * candidate and the most recent one that actually holds a database wins.
 */
export function legacyHomes(): LegacyHome[] {
  if (process.env.BRIDGE_HOME) return []
  const past: Array<[string, string]> = [
    ['Kendra', 'kendra.db'],
    ['Lantern', 'lantern.db']
  ]
  return past.map(([name, db]) => ({ dir: pastHome(name), db }))
}

function pastHome(name: string): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', name)
  }
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), name)
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), name.toLowerCase())
}

/**
 * Where the app listens for proxies.
 *
 * POSIX: inside a 0700 `run` directory in Bridge's own data directory, never a
 * shared one. A path in /tmp could be created first by another local user, who
 * would then receive every proxy's token and could answer its approvals. It
 * also does not depend on TMPDIR, which AI clients often strip from the
 * environment they launch the proxy with. Socket paths are capped near 104
 * bytes, so a very long home falls back to a per-user 0700 directory in the
 * temp dir, which `verifyControlSocket` checks just the same.
 *
 * Windows: the pipe name is derived from the run's token, so another user can
 * neither predict it nor squat it before the app starts.
 */
export function controlSocketPath(token = ''): string {
  if (process.env.BRIDGE_SOCKET) return process.env.BRIDGE_SOCKET
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\bridge-${createHash('sha256').update(token).digest('hex').slice(0, 32)}`
  }
  const preferred = join(bridgeHome(), 'run', 'control.sock')
  if (Buffer.byteLength(preferred) <= 100) return preferred
  return join(tmpdir(), `bridge-${process.getuid?.() ?? 0}`, 'control.sock')
}

/**
 * Refuses a socket this user does not own, before any token is sent to it.
 * Returns the reason, or null when it is safe. POSIX only; Windows pipes are
 * protected by their unguessable name.
 */
export function verifyControlSocket(path: string): string | null {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') return null
  const uid = process.getuid()
  try {
    const socket = lstatSync(path)
    if (!socket.isSocket()) return `${path} is not a socket`
    if (socket.uid !== uid) return `${path} is owned by another user`
    const dir = lstatSync(dirname(path))
    if (!dir.isDirectory() || dir.uid !== uid) return `${dirname(path)} is not a directory owned by this user`
    if ((dir.mode & 0o022) !== 0) return `${dirname(path)} is writable by other users`
    return null
  } catch (err) {
    return (err as Error).message
  }
}

export function databasePath(): string {
  return join(bridgeHome(), 'bridge.db')
}

/**
 * Shared secret for the control socket, rewritten on every app start so a
 * leaked token dies with the run that issued it.
 */
export function controlTokenPath(): string {
  if (process.env.BRIDGE_CONTROL_TOKEN_FILE) return process.env.BRIDGE_CONTROL_TOKEN_FILE
  return join(bridgeHome(), 'control.token')
}
