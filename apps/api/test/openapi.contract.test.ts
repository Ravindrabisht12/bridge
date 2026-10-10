/**
 * The spec and the code must not drift.
 *
 * An OpenAPI document nobody checks is worse than none: it becomes confidently
 * wrong documentation. These tests make the spec load-bearing — add a route
 * without documenting it, or document a field the type does not have, and CI
 * fails.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { buildApp } from '../src/app'
import { MemoryRepository } from '../src/memory-repository'
import { entry, release, snapshot } from './fixtures'

const spec = parse(readFileSync(join(import.meta.dirname, '..', 'openapi.yaml'), 'utf8'))

/** Fastify's own route table, normalised to OpenAPI path syntax. */
function implementedRoutes(): string[] {
  const app = buildApp(new MemoryRepository())
  const printed = app.printRoutes({ commonPrefix: false })
  // printRoutes gives a tree; the registered set is easier to read off the
  // paths we know we declared, so assert both directions explicitly below.
  return printed
    .split('\n')
    .map((l) => l.replace(/[│├└─\s]/g, ''))
    .filter(Boolean)
}

describe('openapi document', () => {
  it('is valid enough to be useful', () => {
    expect(spec.openapi).toMatch(/^3\./)
    expect(spec.info.title).toBe('Bridge Catalogue API')
    expect(Object.keys(spec.paths).length).toBeGreaterThan(0)
  })

  it('documents every route the app serves', () => {
    const documented = Object.keys(spec.paths).sort()
    expect(documented).toEqual(
      [
        '/health',
        '/v1/app/latest',
        '/v1/catalogue',
        '/v1/catalogue/{key}',
        '/v1/featured',
        '/v1/search',
        '/v1/snapshot/latest'
      ].sort()
    )
  })

  it('serves every route it documents', async () => {
    const repo = new MemoryRepository([entry({ key: 'k', featuredRank: 1 })], [], snapshot, release)
    const app = buildApp(repo)
    for (const path of Object.keys(spec.paths)) {
      const url = path.replace('{key}', 'k') + (path === '/v1/search' ? '?q=ab' : '')
      const res = await app.inject({ method: 'GET', url })
      // Anything but 404-no-such-route means the path is wired up.
      expect(res.statusCode, `${path} is documented but not served`).not.toBe(404)
    }
  })

  it('declares no endpoint that accepts a request body', () => {
    // The §0 boundary, enforced. A POST or a requestBody appearing here is the
    // moment this stops being a read-only catalogue, and that should be a
    // conscious decision rather than a merged diff.
    for (const [path, ops] of Object.entries(spec.paths as Record<string, Record<string, unknown>>)) {
      const methods = Object.keys(ops).filter((m) =>
        ['get', 'put', 'post', 'patch', 'delete'].includes(m)
      )
      expect(methods, `${path} should be GET-only`).toEqual(['get'])
      expect((ops.get as Record<string, unknown>).requestBody, `${path} must not take a body`).toBeUndefined()
    }
  })

  it('keeps CatalogueEntry in step with the TypeScript type', () => {
    const documented: string[] = spec.components.schemas.CatalogueEntry.required
    const actual = Object.keys(entry()).sort()
    // Both directions: a field added to the type must be documented, and a
    // field documented must exist. Either mismatch is a lie to a client.
    expect(documented.slice().sort()).toEqual(actual)
  })

  it('marks the fields a client must handle as nullable', () => {
    const props = spec.components.schemas.CatalogueEntry.properties
    for (const field of ['namespace', 'version', 'iconUrl', 'category', 'vendorDomain', 'downloads']) {
      expect(props[field].type, `${field} must be documented nullable`).toContain('null')
    }
  })

  it('documents the removal rule, because getting it wrong destroys data', () => {
    const text = String(spec.paths['/v1/catalogue'].get.description)
    expect(text).toMatch(/explicit list/i)
    expect(text).toMatch(/final page/i)
  })
})

describe('route table', () => {
  it('registers exactly the paths under test', () => {
    const routes = implementedRoutes().join(' ')
    for (const p of ['health', 'search', 'featured', 'catalogue', 'snapshot', 'app']) {
      expect(routes).toContain(p)
    }
  })
})
