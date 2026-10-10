/**
 * A real Postgres for tests.
 *
 * PGlite is Postgres compiled to WASM — the same parser, planner and semantics,
 * with no daemon and no system state. `pglite-socket` puts it behind the wire
 * protocol so `postgres.js` connects to it exactly as it would to Supabase,
 * which means the query code is *exercised* rather than mocked.
 *
 * That distinction matters more here than usual: the interesting SQL in this
 * repo — an upsert that decides for itself whether a row changed, a view that
 * folds two tables together, constraints that refuse bad curation — cannot be
 * verified by a fake. A fake only proves that the fake agrees with itself, and
 * the first real run of the worker already caught three places where ours did
 * not agree with the SQL.
 */
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'

export interface TestDatabase {
  /** Connection string for `postgres.js`. */
  url: string
  /** Raw access, for assertions that should not go through the code under test. */
  raw: PGlite
  /** Truncates every table. Cheaper than a fresh cluster per test. */
  reset(): Promise<void>
  close(): Promise<void>
}

/**
 * Ports are found by trying, not by counting.
 *
 * A module-level counter does not work: vitest runs test files in separate
 * processes, so every file starts the counter at the same value and the second
 * one fails to bind. The symptom is nasty — the suite reports the file's tests
 * as *skipped* rather than failed, so it looks like they ran.
 */
let nextPort = 55000 + Math.floor(Math.random() * 4000)
const PORT_ATTEMPTS = 40

const TABLES = [
  'probes', 'snapshots', 'sync_runs', 'sync_state',
  'app_releases', 'curated', 'registry_servers', 'published_registry_servers', 'published_curated'
]

export async function startTestDatabase(migrations: string[]): Promise<TestDatabase> {
  const db = await PGlite.create({ extensions: { pg_trgm } })

  for (const path of migrations) {
    const sql = readFileSync(path, 'utf8')
    try {
      await db.exec(sql)
    } catch (err) {
      // Name the file: a migration failure inside a test run is otherwise a
      // wall of SQL with no indication of which file produced it.
      throw new Error(`migration failed (${path}): ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  let server: PGLiteSocketServer | null = null
  let port = 0
  for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt++) {
    port = nextPort++
    const candidate = new PGLiteSocketServer({ db, port, host: '127.0.0.1' })
    try {
      await candidate.start()
      server = candidate
      break
    } catch {
      // Almost certainly EADDRINUSE from a sibling test process; try the next.
      try {
        await candidate.stop()
      } catch {
        /* it never started */
      }
    }
  }
  if (!server) {
    await db.close()
    throw new Error(`could not bind a local port for the test database after ${PORT_ATTEMPTS} attempts`)
  }
  const listening = server

  return {
    url: `postgres://postgres@127.0.0.1:${port}/postgres`,
    raw: db,
    async reset() {
      // One statement, so foreign keys and identity columns are handled
      // together and the order of TABLES does not matter.
      await db.exec(`truncate ${TABLES.join(', ')} restart identity cascade;`)
    },
    async close() {
      await listening.stop()
      await db.close()
    }
  }
}
