/** Wiring, kept separate from `server.ts` so tests can build an app without listening. */
import Fastify, { type FastifyInstance } from 'fastify'
import type { ApiError } from '@bridge/types'
import { registerRoutes } from './routes'
import type { CatalogueRepository } from './repository'

export function buildApp(repo: CatalogueRepository, opts: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({
    logger: opts.logger ?? false,
    disableRequestLogging: true,
    // Trust the proxy in front of us for client IPs, which rate limiting will
    // need later. Harmless now, and easy to forget once it matters.
    trustProxy: false
  })

  app.setNotFoundHandler((_req, reply) => {
    const body: ApiError = { error: { code: 'not_found', message: 'no such route' } }
    return reply.code(404).send(body)
  })

  app.setErrorHandler((err, req, reply) => {
    app.log.error({ code: (err as { code?: string }).code, method: req.method }, 'request failed')
    // Never surface an internal message. A stack trace in a public JSON body
    // is how database schemas leak.
    const body: ApiError = { error: { code: 'internal', message: 'internal error' } }
    return reply.code(500).send(body)
  })

  registerRoutes(app, repo)
  return app
}
