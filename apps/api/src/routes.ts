/**
 * The routes.
 *
 * Every handler is thin on purpose: parse, clamp, delegate, set cache headers.
 * Anything with a decision in it belongs in `cursor.ts` or the repository, so
 * it can be tested without an HTTP server.
 *
 * Caching is not an optimisation here, it is the capacity plan. Every response
 * is identical for every caller — there is no user in any request — so a CDN
 * in front of this serves almost all of the traffic and the origin stays a
 * single small process.
 */
import type { FastifyInstance } from 'fastify'
import type { ApiError } from '@bridge/types'
import { clampLimit, decodeCursor, decodeOffset } from './cursor'
import type { CatalogueRepository } from './repository'

const SEARCH_LIMIT = { default: 25, max: 100 }
const DELTA_LIMIT = { default: 250, max: 500 }
const FEATURED_LIMIT = { default: 60, max: 200 }

/** Long enough that the CDN absorbs the load, short enough to feel live. */
const CACHE = {
  search: 'public, max-age=60, s-maxage=300, stale-while-revalidate=600',
  entry: 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400',
  featured: 'public, max-age=300, s-maxage=1800, stale-while-revalidate=86400',
  // Deltas are keyed by cursor, so each distinct answer is immutable.
  delta: 'public, max-age=60, s-maxage=600',
  release: 'public, max-age=300, s-maxage=900',
  none: 'no-store'
}

const bad = (message: string): ApiError => ({ error: { code: 'bad_request', message } })
const missing = (message: string): ApiError => ({ error: { code: 'not_found', message } })

export function registerRoutes(app: FastifyInstance, repo: CatalogueRepository): void {
  /* --------------------------------- health ------------------------------- */
  app.get('/health', async (_req, reply) => {
    try {
      await repo.ping()
      return reply.header('cache-control', CACHE.none).send({ ok: true })
    } catch (err) {
      // 503, not 500: the API is fine, its dependency is not, and a load
      // balancer should treat those differently.
      app.log.error({ err }, 'health check failed')
      return reply.code(503).header('cache-control', CACHE.none).send({ ok: false })
    }
  })

  /* --------------------------------- search ------------------------------- */
  app.get<{ Querystring: Record<string, string | undefined> }>('/v1/search', async (req, reply) => {
    const q = (req.query.q ?? '').trim()
    if (q.length < 2 || q.length > 200) {
      return reply.code(400).send(bad('q must be between 2 and 200 characters'))
    }
    // Search cursors are offsets, not keysets — see cursor.ts. Validating with
    // the wrong decoder would 400 every legitimate page-two request.
    if (req.query.cursor && decodeOffset(req.query.cursor) === null) {
      return reply.code(400).send(bad('cursor is not valid'))
    }

    const page = await repo.search({
      q,
      firstPartyOnly: req.query.firstParty === 'true',
      category: req.query.category ?? null,
      limit: clampLimit(req.query.limit, SEARCH_LIMIT.default, SEARCH_LIMIT.max),
      cursor: req.query.cursor ?? null
    })
    return reply.header('cache-control', CACHE.search).send(page)
  })

  /* -------------------------------- featured ------------------------------ */
  app.get<{ Querystring: Record<string, string | undefined> }>('/v1/featured', async (req, reply) => {
    const items = await repo.featured(clampLimit(req.query.limit, FEATURED_LIMIT.default, FEATURED_LIMIT.max))
    return reply.header('cache-control', CACHE.featured).send({ items, nextCursor: null, total: items.length })
  })

  /* ------------------------------- one entry ------------------------------ */
  app.get<{ Params: { key: string } }>('/v1/catalogue/:key', async (req, reply) => {
    const entry = await repo.get(req.params.key)
    if (!entry) return reply.code(404).send(missing(`no entry for key "${req.params.key}"`))
    return reply.header('cache-control', CACHE.entry).send(entry)
  })

  /* --------------------------------- delta -------------------------------- */
  app.get<{ Querystring: Record<string, string | undefined> }>('/v1/catalogue', async (req, reply) => {
    const since = req.query.since ?? null
    // An absent cursor is a first sync and legitimate. A present-but-broken
    // one is a client bug, and silently treating it as "send everything" would
    // hide that bug behind a 27,000-row response.
    if (since !== null && !decodeCursor(since)) {
      return reply.code(400).send(bad('since is not a valid cursor'))
    }

    const delta = await repo.delta({
      since,
      limit: clampLimit(req.query.limit, DELTA_LIMIT.default, DELTA_LIMIT.max)
    })
    return reply.header('cache-control', CACHE.delta).send(delta)
  })

  /* ------------------------------- snapshot ------------------------------- */
  app.get('/v1/snapshot/latest', async (_req, reply) => {
    const snap = await repo.currentSnapshot()
    if (!snap) return reply.code(404).send(missing('no snapshot has been published yet'))
    // Metadata only. The bytes live on the CDN; this hands over the URL rather
    // than proxying megabytes through the origin.
    return reply.header('cache-control', CACHE.featured).send(snap)
  })

  /* ------------------------------ app release ----------------------------- */
  app.get('/v1/app/latest', async (_req, reply) => {
    const release = await repo.currentRelease()
    if (!release) return reply.code(404).send(missing('no release has been published yet'))
    return reply.header('cache-control', CACHE.release).send(release)
  })
}
