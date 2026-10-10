/** Entry point. Chooses a repository from the environment and listens. */
import { buildApp } from './app'
import { MemoryRepository } from './memory-repository'
import type { CatalogueRepository } from './repository'

const port = Number(process.env.PORT ?? 8787)
const host = process.env.HOST ?? '0.0.0.0'

async function repository(): Promise<CatalogueRepository> {
  if (!process.env.DATABASE_URL) {
    // Deliberate: `pnpm dev` works with no database, and the failure mode of a
    // missing DATABASE_URL in production is a loud log line rather than a
    // process that boots and quietly serves nothing.
    if (process.env.NODE_ENV === 'production') throw new Error('DATABASE_URL is required in production')
    console.warn('DATABASE_URL is not set — serving from an empty in-memory catalogue')
    return new MemoryRepository()
  }
  const { PostgresRepository } = await import('./postgres-repository.js')
  return new PostgresRepository(process.env.DATABASE_URL)
}

const repo = await repository()
const app = buildApp(repo, { logger: true })
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
  void app.close().then(async () => { if ('close' in repo) await (repo as CatalogueRepository & { close(): Promise<void> }).close() })
})

try {
  await app.listen({ port, host })
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
