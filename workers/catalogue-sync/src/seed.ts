import postgres from 'postgres'
import { OFFICIAL_SERVERS } from '@bridge/catalogue-data'

/** Seed editorial defaults only once; later operator edits survive every run. */
export async function seedCatalogue(url: string): Promise<void> {
  const sql = postgres(url, { max: 1 })
  try {
    await sql.begin(async (tx) => {
      for (const [rank, entry] of OFFICIAL_SERVERS.entries()) {
        const key = `bridge:${entry.id}`
        await tx`insert into registry_servers (key, title, description, website_url, remotes)
          values (${key}, ${entry.title}, ${entry.description}, ${'https://' + entry.domain},
          ${sql.json([{ type: 'streamable-http', url: entry.url }])}) on conflict (key) do nothing`
        await tx`insert into curated (key, is_first_party, vendor_domain, icon_domain, icon_url, category, evidence, featured_rank)
          values (${key}, true, ${entry.domain}, ${entry.iconDomain ?? entry.domain}, ${entry.iconUrl ?? null},
          ${entry.category}, ${entry.evidence}, ${rank + 1}) on conflict (key) do nothing`
      }
    })
  } finally { await sql.end() }
}
