/**
 * In-memory store, for tests and for `DRY_RUN` without a database.
 *
 * Change detection matches the Postgres implementation: a row counts as
 * `changed` only when a served field actually differs. Getting that wrong would
 * make every weekly sync mark all 27,000 entries as changed, which would in
 * turn push the entire catalogue into every client's next delta — a correct
 * result that is useless.
 *
 * Every query here has to mean the same thing as its SQL counterpart, or the
 * tests that run against it are worthless. Three divergences were found by
 * running the real pipeline and are fixed: `probeTargets` must be
 * curated-only (Postgres joins `curated`), `downloadTargets` must filter to
 * npm and PyPI, and a remote whose URL will not parse must be skipped rather
 * than thrown on.
 */
import type { CatalogueEntry, ProbeResult, StageResult } from '@bridge/types'
import type {
  CatalogueStore,
  DownloadTarget,
  IconTarget,
  ProbeTarget,
  ServerRow,
  UpsertOutcome
} from './store'

interface Held extends ServerRow {
  downloads: number | null
  downloadsSource: 'npm' | 'pypi' | null
  verifiedAt: string | null
  deletedAt: string | null
  updatedAt: string
}

/** The fields a client would notice. Only these make a row "changed". */
const SERVED = [
  'namespace', 'title', 'description', 'version',
  'repositoryUrl', 'websiteUrl', 'status', 'publishedAt'
] as const

export class MemoryStore implements CatalogueStore {
  readonly rows = new Map<string, Held>()
  /** Mirrors the `curated` table. Only these are ever probed or given icons. */
  readonly curated = new Map<
    string,
    { vendorDomain: string; iconDomain?: string; iconUrl?: string | null; iconAsset?: string | null }
  >()
  readonly probes: ProbeResult[] = []
  readonly runs: StageResult[] = []
  readonly snapshots: Array<{ digest: string; entryCount: number }> = []
  private readonly state = new Map<string, string>()
  private clock: () => string

  constructor(now: () => string = () => new Date().toISOString()) {
    this.clock = now
  }

  async upsertServers(incoming: ServerRow[]): Promise<UpsertOutcome> {
    let added = 0
    let changed = 0
    let unchanged = 0

    for (const row of incoming) {
      const held = this.rows.get(row.key)
      if (!held) {
        this.rows.set(row.key, {
          ...row,
          downloads: null,
          downloadsSource: null,
          verifiedAt: null,
          deletedAt: null,
          updatedAt: this.clock()
        })
        added++
        continue
      }

      const differs =
        SERVED.some((f) => held[f] !== row[f]) ||
        JSON.stringify(held.packages) !== JSON.stringify(row.packages) ||
        JSON.stringify(held.remotes) !== JSON.stringify(row.remotes)

      if (!differs && held.deletedAt === null) {
        unchanged++
        continue
      }
      // Resurrect a soft-deleted row the registry has published again.
      this.rows.set(row.key, { ...held, ...row, deletedAt: null, updatedAt: this.clock() })
      changed++
    }
    return { added, changed, unchanged }
  }

  async markMissingDeleted(seen: Set<string>): Promise<number> {
    let removed = 0
    for (const [key, row] of this.rows) {
      if (seen.has(key) || row.deletedAt !== null) continue
      this.rows.set(key, { ...row, deletedAt: this.clock(), updatedAt: this.clock() })
      removed++
    }
    return removed
  }

  async countLive(): Promise<number> {
    let n = 0
    for (const r of this.rows.values()) if (r.deletedAt === null) n++
    return n
  }

  async downloadTargets(limit: number): Promise<DownloadTarget[]> {
    const out: DownloadTarget[] = []
    for (const row of this.rows.values()) {
      if (row.deletedAt !== null || out.length >= limit) continue
      // Every package, not just the first, and only the two registries that
      // publish counts — matching the SQL, which filters on registryType.
      for (const pkg of row.packages as Array<{ registryType?: string; identifier?: string }>) {
        if (out.length >= limit) break
        if (!pkg?.identifier) continue
        if (pkg.registryType !== 'npm' && pkg.registryType !== 'pypi') continue
        out.push({ key: row.key, registryType: pkg.registryType, identifier: pkg.identifier })
      }
    }
    return out
  }

  /** Test/dev helper. There is no curation step in the worker itself. */
  setCurated(
    key: string,
    vendorDomain: string,
    icon: { iconDomain?: string; iconUrl?: string | null } = {}
  ): void {
    this.curated.set(key, { vendorDomain, iconAsset: null, ...icon })
  }

  async iconTargets(): Promise<IconTarget[]> {
    const out: IconTarget[] = []
    for (const [key, c] of this.curated) {
      const row = this.rows.get(key)
      if (!row || row.deletedAt !== null) continue
      const iconDomain = c.iconDomain ?? c.vendorDomain
      if (!iconDomain) continue
      out.push({ key, iconDomain, iconUrl: c.iconUrl ?? null, iconAsset: c.iconAsset ?? null })
    }
    return out
  }

  async setIconAsset(key: string, asset: string): Promise<void> {
    const c = this.curated.get(key)
    if (c) this.curated.set(key, { ...c, iconAsset: asset })
    const row = this.rows.get(key)
    // Mirrors the SQL: a new icon is a curation edit, so it must reach clients.
    if (row) this.rows.set(key, { ...row, updatedAt: this.clock() })
  }

  async setDownloads(key: string, downloads: number, source: 'npm' | 'pypi'): Promise<void> {
    const row = this.rows.get(key)
    if (row) this.rows.set(key, { ...row, downloads, downloadsSource: source })
  }

  async probeTargets(staleBefore: string): Promise<ProbeTarget[]> {
    const out: ProbeTarget[] = []
    for (const row of this.rows.values()) {
      // Curated only. Probing all 28,000 registry entries would be both wrong
      // and rude, and the SQL joins `curated` for exactly that reason.
      const curated = this.curated.get(row.key)
      if (!curated || row.deletedAt !== null) continue

      const remote = (row.remotes as Array<{ url?: string }>)[0]
      if (!remote?.url) continue
      if (row.verifiedAt !== null && row.verifiedAt >= staleBefore) continue

      // A registry entry can carry anything in `url`. An unparseable one is
      // skipped; before this guard, one bad row failed the whole stage.
      let host: string
      try {
        host = new URL(remote.url).host
      } catch {
        continue
      }
      if (!host) continue

      out.push({ key: row.key, endpoint: remote.url, vendorDomain: curated.vendorDomain || host })
    }
    return out
  }

  async recordProbe(result: ProbeResult): Promise<void> {
    this.probes.push(result)
  }

  async setVerified(key: string, verifiedAt: string): Promise<void> {
    const row = this.rows.get(key)
    if (row) this.rows.set(key, { ...row, verifiedAt, updatedAt: this.clock() })
  }

  async allEntries(): Promise<CatalogueEntry[]> {
    return [...this.rows.values()]
      .filter((r) => r.deletedAt === null)
      .map((r) => ({
        key: r.key,
        namespace: r.namespace,
        title: r.title,
        description: r.description,
        version: r.version,
        repositoryUrl: r.repositoryUrl,
        websiteUrl: r.websiteUrl,
        status: r.status,
        packages: r.packages as never[],
        remotes: r.remotes as never[],
        isFirstParty: r.verifiedAt !== null,
        vendorDomain: null,
        iconUrl: null,
        category: null,
        pricingTier: 'unknown' as const,
        evidence: r.verifiedAt !== null ? ('mcp-open' as const) : ('unverified' as const),
        featuredRank: null,
        downloads: r.downloads,
        downloadsSource: r.downloadsSource,
        publishedAt: r.publishedAt,
        updatedAt: r.updatedAt,
        verifiedAt: r.verifiedAt
      }))
  }

  async publishSnapshot(meta: { digest: string; entryCount: number }): Promise<void> {
    this.snapshots.push({ digest: meta.digest, entryCount: meta.entryCount })
  }

  async readSyncState(key: string): Promise<string | null> {
    return this.state.get(key) ?? null
  }

  async writeSyncState(key: string, value: string): Promise<void> {
    this.state.set(key, value)
  }

  async recordRun(result: StageResult): Promise<void> {
    this.runs.push(result)
  }
}
