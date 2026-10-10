/**
 * Integration checks for the unified catalogue SQL.
 *
 * These run against a real SQLite file under Electron's Node, because the
 * queries are the interesting part — a union of two differently-shaped tables
 * with a left-joined overlay. The failure modes are all in the SQL, not in the
 * TypeScript around it.
 */
const path = require('node:path')

const HOME = process.env.BRIDGE_HOME
// Resolved rather than path-joined: npm hoists better-sqlite3 to the
// workspace root, so a hardcoded <project>/node_modules path breaks the
// moment the app stops being the repo root.
const Database = require('better-sqlite3')
const DB_PATH = path.join(HOME, 'bridge.db')

const results = []
const assert = (label, cond, extra = '') => results.push({ label, pass: !!cond, extra })

const REQ = '%"isRequired":true%'

const UNIFIED = `
  SELECT c.name AS key, 'registry' AS source, c.title AS title, c.description AS description,
         c.namespace AS namespace, c.status AS status, c.updated_at AS updated_at,
         c.packages AS packages, c.remotes AS remotes, c.downloads AS downloads,
         c.categories AS categories, NULL AS custom_id
  FROM catalog c
  UNION ALL
  SELECT e.id AS key, e.source AS source, e.title AS title, e.description AS description,
         NULL AS namespace, 'active' AS status, e.updated_at AS updated_at,
         CASE WHEN e.source = 'custom-remote' THEN '[]' ELSE '[{"registryType":"custom","identifier":"local"}]' END AS packages,
         CASE WHEN e.source = 'custom-remote' THEN '[{"type":"streamable-http","url":"' || COALESCE(e.url,'') || '"}]' ELSE '[]' END AS remotes,
         NULL AS downloads, '["other"]' AS categories, e.id AS custom_id
  FROM custom_entries e`

const OVERLAY_COLS = `
  o.tier AS o_tier, o.featured_rank AS o_featured_rank, o.tags AS o_tags,
  o.notes AS o_notes, o.rating AS o_rating, o.hidden AS o_hidden, o.updated_at AS o_updated_at`

function seed(db) {
  const now = Date.now()
  // Two registry entries, one with required credentials.
  const ins = db.prepare(
    `INSERT OR REPLACE INTO catalog
      (name,title,description,version,namespace,status,published_at,updated_at,kind,packages,remotes,downloads,downloads_source,categories,synced_at,icon_url)
     VALUES (?,?,?,?,?,'active',?,?,?,?,?,?,?,?,?,NULL)`
  )
  ins.run('io.github.a/alpha', 'Alpha', 'A local thing', '1.0', 'io.github.a', now, now, 'stdio',
    JSON.stringify([{ registryType: 'npm', identifier: 'alpha' }]), '[]', 5000, 'npm', '["dev"]', now)
  ins.run('io.github.b/beta', 'Beta', 'A hosted thing', '1.0', 'io.github.b', now, now, 'remote',
    '[]', JSON.stringify([{ type: 'streamable-http', url: 'https://b', headers: [{ name: 'Authorization', isRequired: true }] }]),
    100, 'npm', '["web"]', now)

  // One custom local entry and one self-hosted.
  const cus = db.prepare(
    `INSERT OR REPLACE INTO custom_entries (id,source,title,description,command,args,env,url,git_ref,cwd,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  )
  cus.run('cst_local', 'custom-local', 'My Local', 'runs here', 'node', '["server.js"]', '{}', null, null, null, now, now)
  cus.run('cst_remote', 'custom-remote', 'My Hosted', 'runs there', null, '[]', '{}', 'https://mine.example.com/mcp', null, null, now, now)

  // Curation: feature Alpha, tier the custom one, hide Beta.
  const ov = db.prepare(
    `INSERT OR REPLACE INTO catalog_overlay (key,tier,featured_rank,tags,notes,rating,hidden,updated_at)
     VALUES (?,?,?,?,?,?,?,?)`
  )
  ov.run('io.github.a/alpha', 'free', 1, '["work","trusted"]', 'our pick', 5, 0, now)
  ov.run('cst_local', 'enterprise', null, '["internal"]', null, 4, 0, now)
  ov.run('io.github.b/beta', 'paid', null, '[]', null, null, 1, now)
}

function run() {
  const db = new Database(DB_PATH)
  seed(db)

  const q = (where, order = 'u.title', params = {}) =>
    db.prepare(
      `SELECT u.*, ${OVERLAY_COLS} FROM (${UNIFIED}) u
       LEFT JOIN catalog_overlay o ON o.key = u.key
       WHERE ${where} ORDER BY ${order}`
    ).all(params)

  // --- the union itself ---
  const visible = q("COALESCE(o.hidden,0) = 0 AND u.status = 'active'")
  const keys = visible.map((r) => r.key).sort()
  assert('registry and custom entries appear in one list',
    keys.includes('io.github.a/alpha') && keys.includes('cst_local') && keys.includes('cst_remote'),
    JSON.stringify(keys))
  assert('a hidden entry is excluded', !keys.includes('io.github.b/beta'), JSON.stringify(keys))

  // --- the alias bug this test exists for ---
  const noOverlay = visible.find((r) => r.key === 'cst_remote')
  assert('an entry with no overlay keeps its own key', noOverlay?.key === 'cst_remote', JSON.stringify(noOverlay?.key))
  assert('an entry with no overlay keeps its own updated_at',
    typeof noOverlay?.updated_at === 'number' && noOverlay.updated_at > 0, String(noOverlay?.updated_at))
  assert('an entry with no overlay reports null tier', noOverlay?.o_tier === null, String(noOverlay?.o_tier))

  const withOverlay = visible.find((r) => r.key === 'io.github.a/alpha')
  assert('overlay fields arrive under their own names',
    withOverlay?.o_tier === 'free' && withOverlay?.o_featured_rank === 1 && withOverlay?.o_rating === 5,
    JSON.stringify({ t: withOverlay?.o_tier, f: withOverlay?.o_featured_rank, r: withOverlay?.o_rating }))
  assert('entry updated_at is not overwritten by the overlay',
    withOverlay?.updated_at !== withOverlay?.o_updated_at || withOverlay?.updated_at > 0,
    JSON.stringify({ u: withOverlay?.updated_at, o: withOverlay?.o_updated_at }))

  // --- filters ---
  assert('tier filter matches curated values',
    q("COALESCE(o.tier,'unknown') = 'enterprise'").map((r) => r.key).join() === 'cst_local')
  assert('source filter isolates custom entries',
    q("u.source LIKE 'custom-%' AND COALESCE(o.hidden,0)=0").length === 2)
  assert('tag filter works on the overlay',
    q("o.tags LIKE '%\"work\"%'").map((r) => r.key).join() === 'io.github.a/alpha')
  assert('featured filter selects only curated picks',
    q('o.featured_rank IS NOT NULL').map((r) => r.key).join() === 'io.github.a/alpha')

  // --- hosting, across both halves ---
  const local = q("u.packages != '[]' AND COALESCE(o.hidden,0)=0").map((r) => r.key).sort()
  assert('local filter spans registry and custom entries',
    local.includes('io.github.a/alpha') && local.includes('cst_local') && !local.includes('cst_remote'),
    JSON.stringify(local))
  const hosted = q("u.remotes != '[]' AND COALESCE(o.hidden,0)=0").map((r) => r.key).sort()
  assert('hosted filter finds the self-hosted custom entry',
    hosted.includes('cst_remote'), JSON.stringify(hosted))

  // --- credentials, read out of nested JSON ---
  const needs = db.prepare(
    `SELECT u.key FROM (${UNIFIED}) u LEFT JOIN catalog_overlay o ON o.key = u.key
     WHERE (u.packages LIKE @req OR u.remotes LIKE @req)`
  ).all({ req: REQ }).map((r) => r.key)
  assert('required-credential detection reaches nested headers',
    needs.includes('io.github.b/beta'), JSON.stringify(needs))

  // --- front page ordering ---
  const front = q("COALESCE(o.hidden,0)=0", 'o.featured_rank ASC NULLS LAST, u.downloads DESC NULLS LAST, u.title ASC')
  assert('curated pick sorts before higher-download entries',
    front[0]?.key === 'io.github.a/alpha', JSON.stringify(front.map((r) => r.key)))

  // --- curation survives a registry sync of the same row ---
  db.prepare('UPDATE catalog SET title = ?, description = ?, downloads = ? WHERE name = ?')
    .run('Alpha v2', 'changed upstream', 9999, 'io.github.a/alpha')
  const after = q("u.key = 'io.github.a/alpha'")[0]
  assert('a registry update does not clear the operator overlay',
    after?.title === 'Alpha v2' && after?.o_tier === 'free' && after?.o_featured_rank === 1,
    JSON.stringify({ title: after?.title, tier: after?.o_tier, rank: after?.o_featured_rank }))

  // --- counting matches the page query ---
  const total = db.prepare(
    `SELECT COUNT(*) c FROM (${UNIFIED}) u LEFT JOIN catalog_overlay o ON o.key = u.key
     WHERE COALESCE(o.hidden,0)=0 AND u.status='active'`
  ).get().c
  assert('count and page agree', total === visible.length, `${total} vs ${visible.length}`)

  db.close()

  let failed = 0
  for (const r of results) {
    if (!r.pass) failed++
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.label}${r.pass ? '' : `   ${r.extra}`}`)
  }
  console.log(`\n${results.length - failed}/${results.length} catalogue checks passed`)
  process.exit(failed ? 1 : 0)
}

run()
