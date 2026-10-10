import { MemoryStore } from './memory-store'
import { PostgresStore } from './postgres-store'
import { runSync } from './run'
import { downloadsStage } from './stages/downloads'
import { probeStage } from './stages/probe'
import { publishStage } from './stages/publish'
import { registryStage } from './stages/registry'
import { assetStorage } from './storage'
import { seedCatalogue } from './seed'
import { iconsStage } from './stages/icons'

const dryRun = process.env.DRY_RUN === 'true'
const url = process.env.DATABASE_URL
const ctx = { scheduled: !!process.env.GITHUB_ACTIONS, now: () => new Date(), log: (msg: string) => console.log(msg) }

async function main(): Promise<void> {
  if (!dryRun && !url) throw new Error('DATABASE_URL is required; use DRY_RUN=true for an isolated preview')
  // Validate upload configuration before making any database changes.
  const storage = dryRun ? null : assetStorage()
  const db = dryRun ? new MemoryStore() : new PostgresStore(url!)
  try {
    if (db instanceof PostgresStore) {
      await db.acquireLock()
      await seedCatalogue(url!)
    }
    const report = await runSync({ store: db, ctx, stages: [
      registryStage({ store: db, full: process.env.FULL !== 'false' }),
      downloadsStage({ store: db }),
      probeStage({ store: db }),
      ...(storage ? [iconsStage({ store: db, storage })] : []),
      publishStage({ store: db, curatedOnly: !dryRun, ...(storage ? {
        upload: async (body) => ({ url: await storage.put(`snapshots/${body.digest}.json.gz`, body.bytes, 'application/gzip') })
      } : {}) })
    ] })
    for (const result of report.results) ctx.log(`${result.stage}: ${result.error ?? `${result.fetched} fetched, ${result.changed} changed`}`)
    if (!report.ok) process.exitCode = 1
  } finally {
    if (db instanceof PostgresStore) {
      await db.releaseLock?.()
      await db.close()
    }
  }
}
void main().catch((err) => { console.error(err instanceof Error ? err.message : String(err)); process.exitCode = 1 })
