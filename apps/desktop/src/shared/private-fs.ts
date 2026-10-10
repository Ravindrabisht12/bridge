/**
 * File writes for data other local users must not read: Bridge's database,
 * logs and backups, and the AI clients' config files, which hold tokens.
 *
 * Default modes are 0755 for directories and 0644 for files on most Linux
 * systems, which makes all of that readable to every account on the machine.
 * macOS keeps `~/Library` private, but Bridge should not depend on where it
 * happens to live.
 */
import { chmodSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Creates `dir` readable only by this user, and tightens it if it already exists. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (process.platform === 'win32') return
  try {
    chmodSync(dir, 0o700)
  } catch {
    /* not ours to change; nothing better to do */
  }
}

/**
 * Replaces `path` atomically without loosening its permissions: an existing
 * file keeps its mode (a 0600 `~/.claude.json` stays 0600), a new one is 0600.
 */
export function writeFileAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600
  const tmp = `${path}.bridge.tmp`
  writeFileSync(tmp, text, { encoding: 'utf8', mode })
  // `mode` on create is filtered through the umask; set it exactly.
  if (process.platform !== 'win32') chmodSync(tmp, mode)
  renameSync(tmp, path)
}

/** Writes a new file only this user can read. */
export function writePrivateFile(path: string, data: string | Buffer): void {
  writeFileSync(path, data, { mode: 0o600 })
  if (process.platform !== 'win32') chmodSync(path, 0o600)
}
