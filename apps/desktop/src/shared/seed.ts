/**
 * The curated front page.
 *
 * "Top servers" is not derivable. The registry publishes no popularity signal,
 * and download counts only exist for packaged servers — which is precisely why
 * Atlassian, Figma and Notion were buried: they are hosted, so they have no npm
 * downloads, so a usage-ranked list put every tiny npm library above them.
 *
 * So this list is editorial, and labelled as such. Two rules kept it honest:
 *
 *  1. Every endpoint below was probed and answered. All returned HTTP 401
 *     (OAuth required), which confirms a live MCP endpoint rather than a URL
 *     someone hoped existed.
 *  2. No pricing is claimed. These vendors have varying free and paid tiers and
 *     the registry records none of it, so `tier` stays unset for the operator
 *     to fill in.
 *
 * Applied once, guarded by SEED_VERSION. Operator curation is never overwritten
 * — a later bump only touches entries the operator has not already ranked.
 */

/** An entry that exists in the registry and just needs surfacing. */
export interface SeedPick {
  /** Registry name, exactly as synced. */
  key: string
  rank: number
  tags?: string[]
}

/** A vendor with a live endpoint that the registry does not list. */
export interface SeedCustom {
  /** Stable id so re-seeding updates rather than duplicates. */
  id: string
  rank: number
  title: string
  description: string
  url: string
  tags?: string[]
}

export const SEED_VERSION = '2'

/**
 * Registry entries promoted to the front page. Keys verified present in a full
 * sync; endpoints verified live.
 */
export const SEED_PICKS: SeedPick[] = [
  { key: 'com.atlassian/atlassian-mcp-server', rank: 10, tags: ['work'] },
  { key: 'com.figma.mcp/mcp', rank: 20, tags: ['work'] },
  { key: 'com.notion/mcp', rank: 30, tags: ['work'] },
  { key: 'app.linear/linear', rank: 40, tags: ['work'] },
  { key: 'com.stripe/mcp', rank: 50, tags: ['work'] },
  { key: 'com.supabase/mcp', rank: 60 },
  { key: 'com.cloudflare.mcp/mcp', rank: 70 },
  { key: 'com.airtable/mcp', rank: 80 },
  { key: 'com.monday/monday.com', rank: 90 },
  { key: 'com.webflow/mcp', rank: 100 },
  { key: 'com.paypal.mcp/mcp', rank: 110 },
  { key: 'com.wix/mcp', rank: 120 },
  { key: 'com.zapier/mcp', rank: 130 }
]

/**
 * Vendors absent from the registry. Canva is listed in Anthropic's connector
 * directory but has never been published to registry.modelcontextprotocol.io,
 * so without this it simply cannot appear. Its endpoint was probed and is live.
 */
export const SEED_CUSTOM: SeedCustom[] = [
  {
    id: 'seed_canva',
    rank: 25,
    title: 'Canva',
    description:
      'Design, edit and export Canva documents. Published by Canva but absent from the MCP registry, so Bridge ships the endpoint directly.',
    url: 'https://mcp.canva.com/mcp',
    tags: ['work']
  }
]
