/**
 * Stage 5: publish a snapshot.
 *
 * Critical, and the only stage that can destroy something a user can see —
 * which is why `checkPublish` sits between the count and the write. See
 * `guard.ts`.
 *
 * The snapshot is content-addressed so a client already holding the digest has
 * nothing to download, and so a republish of identical content is a no-op
 * rather than a new version everyone re-fetches.
 */
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import type { CatalogueEntry } from '@bridge/types'
import { checkPublish } from '../guard'
import type { Stage, StageContext } from '../stages'
import type { CatalogueStore } from '../store'

export const PREVIOUS_COUNT_KEY = 'publish.entryCount'
export const CURSOR_KEY = 'publish.cursor'

export class PublishRefused extends Error {
  constructor(reason: string) {
    super(`publish refused: ${reason}`)
    this.name = 'PublishRefused'
  }
}

export interface SnapshotBody {
  entries: CatalogueEntry[]
  digest: string
  bytes: Buffer
  /** The cursor a client should use for its first delta after this snapshot. */
  cursor: string
}

/** Deterministic: the same entries must always produce the same digest. */
export function buildSnapshot(entries: CatalogueEntry[]): SnapshotBody {
  const ordered = [...entries].sort((a, b) => a.key.localeCompare(b.key))
  const json = JSON.stringify({ version: 1, entries: ordered })
  const bytes = gzipSync(Buffer.from(json, 'utf8'), { level: 9 })
  const digest = 'sha256-' + createHash('sha256').update(json).digest('hex')

  // The cursor is the newest updatedAt in the snapshot, so a client's first
  // delta asks for everything after what it just downloaded.
  const newest = ordered.reduce<string | null>(
    (max, e) => (max === null || e.updatedAt > max ? e.updatedAt : max),
    null
  )
  const tip = ordered.filter((e) => e.updatedAt === newest).at(-1)
  const cursor = tip
    ? Buffer.from(`${tip.updatedAt}|${tip.key}`, 'utf8').toString('base64url')
    : ''

  return { entries: ordered, digest, bytes, cursor }
}

export interface PublishStageOptions {
  store: CatalogueStore
  curatedOnly?: boolean
  /** Where the bytes go. Absent means dry run: build and check, never write. */
  upload?: (body: SnapshotBody) => Promise<{ url: string }>
}

export function publishStage(opts: PublishStageOptions): Stage {
  return {
    name: 'publish',
    async run(ctx: StageContext) {
      const all = await opts.store.allEntries()
      const entries = opts.curatedOnly ? all.filter((e) => e.featuredRank !== null) : all
      const previousTotal = Number(await opts.store.readSyncState('publish.registryCount') ?? 0)
      const registryVerdict = checkPublish(all.length, previousTotal)
      if (!registryVerdict.ok) throw new PublishRefused(registryVerdict.reason)
      const previousRaw = await opts.store.readSyncState(PREVIOUS_COUNT_KEY)
      const previous = previousRaw === null ? 0 : Number(previousRaw)

      const verdict = checkPublish(entries.length, previous)
      ctx.log(`publish: ${verdict.reason}`)
      // Throwing rather than returning an error keeps the decision in one
      // place: a refused publish is a failed critical stage, so the orchestrator
      // aborts the run and the previous snapshot keeps serving.
      if (!verdict.ok) throw new PublishRefused(verdict.reason)

      const snapshot = buildSnapshot(entries)

      if (!opts.upload) {
        ctx.log(`publish: dry run — would publish ${snapshot.digest} (${snapshot.bytes.length} bytes)`)
        return { fetched: entries.length, added: 0, changed: 0, removed: 0, error: null }
      }

      const { url } = await opts.upload(snapshot)
      await opts.store.publishSnapshot({
        digest: snapshot.digest,
        url,
        bytes: snapshot.bytes.length,
        entryCount: entries.length,
        cursor: snapshot.cursor
      })
      await opts.store.writeSyncState(PREVIOUS_COUNT_KEY, String(entries.length))
      await opts.store.writeSyncState('publish.registryCount', String(all.length))
      await opts.store.writeSyncState(CURSOR_KEY, snapshot.cursor)

      return { fetched: entries.length, added: 1, changed: 0, removed: 0, error: null }
    }
  }
}
