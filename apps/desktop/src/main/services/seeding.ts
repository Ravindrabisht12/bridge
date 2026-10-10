/**
 * Applies the curated front page once, without ever overwriting the operator's
 * own curation.
 *
 * Two rules make a re-seed safe:
 *  - a registry pick is skipped if the operator has already set a featured rank
 *    on it (they have an opinion; ours is stale by definition)
 *  - a custom seed is upserted by a stable id, so it updates rather than
 *    duplicating, but its overlay follows the same skip rule
 */
import { SEED_CUSTOM, SEED_PICKS, SEED_VERSION } from '@shared/seed'
import { OFFICIAL_REGISTRY_KEYS, OFFICIAL_SERVERS, OFFICIAL_TAG, OFFICIAL_VERSION } from '@shared/official'
import type { FileLogger } from '@shared/logger'
import type { Db } from '../../db'
import { readSyncState, writeSyncState } from '../../db/catalog'
import {
  deleteCustomEntry,
  findFirstPartyByEndpoint,
  getCatalogueItem,
  getOverlay,
  listOfficialTagged,
  saveCustomEntry,
  saveOverlay
} from '../../db/catalogue'

const SEED_KEY = 'catalogue.seed'
const OFFICIAL_KEY = 'catalogue.official'

export interface SeedReport {
  applied: boolean
  picksApplied: number
  picksMissing: string[]
  customApplied: number
  skippedByOperator: string[]
}

/**
 * Retires the first-generation seed list.
 *
 * It featured registry rows for the same vendors the official directory now
 * covers with verified evidence, and shipped a Canva stub that is now part of
 * that directory — so leaving it in place showed several vendors twice. Its
 * artefacts are removed rather than left as duplicates.
 */
export function applySeed(db: Db, log: FileLogger, force = false): SeedReport {
  const report: SeedReport = {
    applied: false,
    picksApplied: 0,
    picksMissing: [],
    customApplied: 0,
    skippedByOperator: []
  }
  if (!force && readSyncState(db, SEED_KEY) === SEED_VERSION) return report
  report.applied = true

  for (const seed of SEED_CUSTOM) {
    if (getCatalogueItem(db, seed.id)?.custom) {
      deleteCustomEntry(db, seed.id)
      report.customApplied++
    }
  }

  // Un-feature the legacy picks unless the operator has re-ranked them since.
  for (const pick of SEED_PICKS) {
    const existing = getOverlay(db, pick.key)
    if (existing.featuredRank === pick.rank) {
      saveOverlay(db, { key: pick.key, featuredRank: null })
      report.picksApplied++
    } else if (existing.featuredRank !== null) {
      report.skippedByOperator.push(pick.key)
    }
  }

  writeSyncState(db, SEED_KEY, SEED_VERSION)
  if (report.picksApplied > 0 || report.customApplied > 0) {
    log.info(
      `retired legacy seed: cleared ${report.picksApplied} duplicate ranks, removed ${report.customApplied} superseded entries`
    )
  }
  return report
}

/**
 * Installs the curated first-party directory: bundled endpoints the registry
 * does not list, plus registry entries from recognisable companies. Everything
 * gets the `official` tag so the Library can show only these by default.
 */
export function applyOfficial(db: Db, log: FileLogger, force = false): { bundled: number; promoted: number } {
  if (!force && readSyncState(db, OFFICIAL_KEY) === OFFICIAL_VERSION) return { bundled: 0, promoted: 0 }

  let bundled = 0
  let promoted = 0
  let rank = 10
  const tagged = new Set<string>()

  const promote = (key: string): void => {
    tagged.add(key)
    const existing = getOverlay(db, key)
    saveOverlay(db, {
      key,
      // Only set a rank if the operator has not chosen one.
      featuredRank: existing.featuredRank ?? rank,
      tags: existing.tags.includes(OFFICIAL_TAG) ? existing.tags : [...existing.tags, OFFICIAL_TAG]
    })
    rank += 10
  }

  for (const server of OFFICIAL_SERVERS) {
    // If the vendor is already in the registry, promote that row instead of
    // shipping a stub: it has the real title, description, version and icon,
    // and two rows for one vendor is exactly what this list should prevent.
    const registryKey = findFirstPartyByEndpoint(db, server.url, server.domain)
    if (registryKey) {
      // Drop a stub a previous version of this list may have created.
      if (getCatalogueItem(db, server.id)?.custom) deleteCustomEntry(db, server.id)
      promote(registryKey)
      promoted++
      continue
    }

    saveCustomEntry(db, {
      id: server.id,
      source: 'custom-remote',
      title: server.title,
      description: server.description,
      command: null,
      args: [],
      env: {},
      url: server.url,
      gitRef: null,
      cwd: null
    })
    promote(server.id)
    bundled++
  }

  let explicitPromoted = 0
  for (const key of OFFICIAL_REGISTRY_KEYS) {
    if (!getCatalogueItem(db, key)) continue
    promote(key)
    promoted++
    explicitPromoted++
  }

  /*
   * Anything still carrying the tag that the directory no longer covers is
   * stale — an earlier version of this list promoted it by mistake. Only the
   * tag is removed; a rank the operator set by hand is theirs to keep.
   */
  let untagged = 0
  for (const key of listOfficialTagged(db)) {
    if (tagged.has(key)) continue
    const existing = getOverlay(db, key)
    saveOverlay(db, {
      key,
      tags: existing.tags.filter((t) => t !== OFFICIAL_TAG),
      featuredRank: existing.updatedAt === 0 ? null : existing.featuredRank
    })
    untagged++
  }
  if (untagged > 0) log.info(`official directory: removed ${untagged} entries no longer in the list`)

  // The bundled endpoints are self-contained, but the promotions need the
  // catalogue to be synced. Marking the whole job done after a run that could
  // not find them would strand those entries forever, so the marker is only
  // written once every promotion resolved.
  if (explicitPromoted === OFFICIAL_REGISTRY_KEYS.length) {
    writeSyncState(db, OFFICIAL_KEY, OFFICIAL_VERSION)
  } else {
    log.info(
      `official directory: ${OFFICIAL_REGISTRY_KEYS.length - promoted} registry entries not in the catalogue yet; will retry after the next sync`
    )
  }
  log.info(`official directory: ${bundled} bundled endpoints, ${promoted} registry entries promoted`)
  return { bundled, promoted }
}

/** True when the catalogue has entries but the front page has never been seeded. */
export function seedPending(db: Db): boolean {
  return readSyncState(db, SEED_KEY) !== SEED_VERSION || readSyncState(db, OFFICIAL_KEY) !== OFFICIAL_VERSION
}
