import type { AppRelease, CatalogueEntry, SnapshotMeta } from '@bridge/types'

export function entry(over: Partial<CatalogueEntry> = {}): CatalogueEntry {
  return {
    key: 'io.github.someone/thing',
    namespace: 'io.github.someone',
    title: 'Thing',
    description: 'Does a thing.',
    version: '1.0.0',
    repositoryUrl: null,
    websiteUrl: null,
    status: 'active',
    packages: [],
    remotes: [],
    isFirstParty: false,
    vendorDomain: null,
    iconUrl: null,
    category: null,
    pricingTier: 'unknown',
    evidence: 'unverified',
    featuredRank: null,
    downloads: null,
    downloadsSource: null,
    publishedAt: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
    verifiedAt: null,
    ...over
  }
}

export const snapshot: SnapshotMeta = {
  digest: 'sha256-abc',
  url: 'https://cdn.bridge.app/snapshots/abc.json.gz',
  bytes: 1234,
  entryCount: 55,
  cursor: 'MjAyNi0wMS0wMVQwMDowMDowMC4wMDBafGF6',
  generatedAt: '2026-01-01T00:00:00.000Z'
}

export const release: AppRelease = {
  version: '0.1.0',
  notes: 'First build.',
  notesUrl: null,
  publishedAt: '2026-01-01T00:00:00.000Z',
  minimumSupported: '0.1.0',
  downloads: [
    { platform: 'mac-arm64', url: 'https://cdn.bridge.app/Bridge-0.1.0-arm64.dmg', bytes: 1, sha512: 'x' }
  ]
}
