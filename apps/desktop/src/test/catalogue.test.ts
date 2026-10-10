import { describe, expect, it } from 'vitest'
import { emptyOverlay, frontPageComparator, type CatalogueItem } from '@shared/catalogue'
import { planCustom } from '@shared/install'

const item = (over: Partial<CatalogueItem>): CatalogueItem => ({
  key: 'k',
  source: 'registry',
  title: 'T',
  description: '',
  namespace: 'io.github.x',
  version: '1',
  repositoryUrl: null,
  websiteUrl: null,
  iconUrl: null,
  status: 'active',
  publishedAt: null,
  updatedAt: null,
  packages: [],
  remotes: [],
  downloads: null,
  downloadsSource: null,
  categories: [],
  overlay: emptyOverlay('k'),
  custom: null,
  ...over
})

describe('front page ordering', () => {
  const featured = (rank: number | null, downloads: number | null): CatalogueItem =>
    item({ overlay: { ...emptyOverlay('k'), featuredRank: rank }, downloads })

  it('puts curated picks before everything else', () => {
    expect(frontPageComparator(featured(1, 0), featured(null, 999_999))).toBeLessThan(0)
    expect(frontPageComparator(featured(null, 999_999), featured(1, 0))).toBeGreaterThan(0)
  })

  it('orders curated picks by the operator rank', () => {
    expect(frontPageComparator(featured(1, 0), featured(2, 0))).toBeLessThan(0)
  })

  it('falls back to real usage for uncurated entries', () => {
    expect(frontPageComparator(featured(null, 500), featured(null, 100))).toBeLessThan(0)
  })

  it('sorts entries with no usage data last, not first', () => {
    expect(frontPageComparator(featured(null, null), featured(null, 1))).toBeGreaterThan(0)
  })
})

describe('custom entry planning', () => {
  const base = { title: 'My Thing', command: null, args: [], env: {}, url: null, cwd: null }

  it('plans a local command verbatim', () => {
    const r = planCustom({ ...base, source: 'custom-local', command: 'node', args: ['server.js'], env: { K: 'v' } })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.target).toMatchObject({ kind: 'stdio', command: 'node', args: ['server.js'], env: { K: 'v' } })
    // Nothing to infer: the operator already said how to run it.
    expect(r.plan.required).toEqual([])
    expect(r.plan.prerequisite).toBeNull()
  })

  it('keeps the working directory when given', () => {
    const r = planCustom({ ...base, source: 'custom-local', command: 'node', cwd: '/srv/app' })
    expect(r.ok && r.plan.target).toMatchObject({ cwd: '/srv/app' })
  })

  it('plans a self-hosted url as an http target', () => {
    const r = planCustom({ ...base, source: 'custom-remote', url: 'https://mine.example.com/mcp' })
    expect(r.ok && r.plan.target).toMatchObject({ kind: 'http', url: 'https://mine.example.com/mcp' })
    expect(r.ok && r.plan.notes.join(' ')).toMatch(/your own endpoint/)
  })

  it('refuses a self-hosted entry with no url', () => {
    expect(planCustom({ ...base, source: 'custom-remote' }).ok).toBe(false)
  })

  it('refuses a git entry until a run command is supplied, and says why', () => {
    const r = planCustom({ ...base, source: 'custom-git', url: 'https://github.com/x/y' })
    expect(r.ok).toBe(false)
    // It must not silently clone or build someone's repository.
    expect(!r.ok && r.error.reason).toMatch(/command that runs the checked-out server/i)
  })

  it('plans a git entry once a command is supplied', () => {
    const r = planCustom({
      ...base,
      source: 'custom-git',
      url: 'https://github.com/x/y',
      command: 'node',
      args: ['dist/index.js'],
      cwd: '/repos/y'
    })
    expect(r.ok).toBe(true)
    expect(r.ok && r.plan.notes.join(' ')).toMatch(/does not clone or build/)
  })

  it('omits an empty env rather than passing a blank object', () => {
    const r = planCustom({ ...base, source: 'custom-local', command: 'node' })
    expect(r.ok && r.plan.target).not.toHaveProperty('env')
  })
})
