/**
 * The write boundary.
 *
 * Stages talk to this interface, never to SQL — the same shape as the API's
 * `CatalogueRepository`, and for the same reason: the orchestration logic that
 * actually matters (ordering, abort policy, the publish guard, what counts as
 * a change) is fully tested with no database anywhere near CI.
 *
 * It is deliberately narrow. Nothing here can read or write anything about a
 * person, because there is nothing about a person in this database.
 */
import type { CatalogueEntry, ProbeResult, StageResult } from '@bridge/types'

/** A registry entry flattened into the shape `registry_servers` stores. */
export interface ServerRow {
  key: string
  namespace: string | null
  title: string
  description: string
  version: string | null
  repositoryUrl: string | null
  websiteUrl: string | null
  status: string
  packages: unknown[]
  remotes: unknown[]
  publishedAt: string | null
  sourceUpdatedAt: string | null
}

export interface UpsertOutcome {
  added: number
  changed: number
  /** Rows the registry returned that were byte-identical to what we held. */
  unchanged: number
}

/** A package worth asking npm or PyPI about. */
export interface DownloadTarget {
  key: string
  registryType: string
  identifier: string
}

/** A curated entry whose icon needs resolving. */
export interface IconTarget {
  key: string
  /** The domain to search. Not necessarily the endpoint's — Google serves MCP
   *  from googleapis.com and hosts no brand icon there. */
  iconDomain: string
  /** A pinned exact URL, for the few vendors whose best icon is not their
   *  most recognisable one. Slack's multi-colour mark is only in its .ico. */
  iconUrl: string | null
  /** What is already stored, so an unchanged result is not rewritten. */
  iconAsset: string | null
}

/** A curated endpoint worth re-verifying. */
export interface ProbeTarget {
  key: string
  endpoint: string
  vendorDomain: string
}

export interface CatalogueStore {
  /* ------------------------------ registry -------------------------------- */
  upsertServers(rows: ServerRow[]): Promise<UpsertOutcome>
  /** Soft-deletes anything not seen in a full pass. Returns the count. */
  markMissingDeleted(seenKeys: Set<string>): Promise<number>
  /** Live rows only. The guard compares against this. */
  countLive(): Promise<number>

  /* ------------------------------ enrichment ------------------------------ */
  downloadTargets(limit: number): Promise<DownloadTarget[]>
  setDownloads(key: string, downloads: number, source: 'npm' | 'pypi'): Promise<void>

  probeTargets(staleBefore: string): Promise<ProbeTarget[]>
  recordProbe(result: ProbeResult): Promise<void>
  /** Only an outcome that proves the endpoint exists should move this. */
  setVerified(key: string, verifiedAt: string): Promise<void>

  iconTargets(): Promise<IconTarget[]>
  setIconAsset(key: string, asset: string): Promise<void>

  /* ------------------------------- publish -------------------------------- */
  /** Everything the snapshot should contain, already joined with curation. */
  allEntries(): Promise<CatalogueEntry[]>
  publishSnapshot(meta: {
    digest: string
    url: string
    bytes: number
    entryCount: number
    cursor: string
  }): Promise<void>

  /* ----------------------------- bookkeeping ------------------------------ */
  readSyncState(key: string): Promise<string | null>
  writeSyncState(key: string, value: string): Promise<void>
  recordRun(result: StageResult): Promise<void>
}
