import { chmodSync } from 'node:fs'
import { ensurePrivateDir } from '@shared/private-fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { databasePath } from '@shared/control'
import { MIGRATIONS } from './schema'

export type Db = Database.Database

let instance: Db | null = null

/**
 * Opens the shared database. Several processes hold it at once — the app plus
 * one proxy per MCP server — so WAL and a generous busy timeout are required.
 */
export function openDatabase(path = databasePath()): Db {
  if (instance) return instance
  // Holds server targets (with their tokens) and every recorded call.
  ensurePrivateDir(dirname(path))
  const db = new Database(path)
  if (process.platform !== 'win32') {
    try {
      chmodSync(path, 0o600)
    } catch {
      /* a shared or read-only location; the directory mode still protects it */
    }
  }
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('busy_timeout = 5000')
  db.pragma('foreign_keys = ON')
  migrate(db)
  instance = db
  return db
}

export function getDatabase(): Db {
  if (!instance) throw new Error('Database not opened')
  return instance
}

export function closeDatabase(): void {
  instance?.close()
  instance = null
}

function migrate(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue
    db.exec('BEGIN')
    try {
      db.exec(migration.sql)
      db.pragma(`user_version = ${migration.version}`)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw new Error(`Migration ${migration.version} failed: ${(err as Error).message}`)
    }
  }
}
