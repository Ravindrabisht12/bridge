/**
 * Generates `src/icons.ts` — the curated vendors' marks, compiled into the app.
 *
 * Why compiled in rather than fetched:
 *
 *   - The desktop app deliberately no longer asks vendors for icons. Every
 *     install doing its own favicon crawl told dozens of publishers that a
 *     Bridge user existed, in an app whose premise is that you can see what
 *     leaves your machine.
 *   - But the 55 curated entries are themselves compiled in, so the Library is
 *     useful before there is a network. Without their icons that Library renders
 *     as 55 grey monograms and looks broken — which is exactly what happened.
 *
 * So the icons get the same treatment as the entries: shipped with the app.
 * Registry entries beyond the curated set need a catalogue service anyway, and
 * their icons come from it.
 *
 * Run with:  npm run icons:catalogue
 *
 * Resolution order per vendor: the app's own on-disk cache first (free, already
 * the result of ranked discovery), then a live ranked search for anything
 * missing. Rasters are downscaled to 96px, which covers the 46px slot at 2x.
 */
const { app, nativeImage } = require('electron')
const { createHash } = require('node:crypto')
const { existsSync, readFileSync, writeFileSync } = require('node:fs')
const { homedir } = require('node:os')
const { join } = require('node:path')
const { execFileSync } = require('node:child_process')

// Never leave the process hanging on a bad promise.
process.on('unhandledRejection', (err) => { console.error('unhandled:', err); process.exit(1) })

const ROOT = join(__dirname, '..', '..', '..')
const OUT = join(__dirname, '..', 'src', 'icons.ts')
const HOME = process.env.BRIDGE_HOME || join(homedir(), 'Library', 'Application Support', 'Bridge')
const CACHE = join(HOME, 'icons')
const MAX_PX = 96
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/svg+xml': 'svg', 'image/webp': 'webp', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico' }
const MIME = Object.fromEntries(Object.entries(EXT).map(([m, e]) => [e, m]))

/** Parsed straight out of the TypeScript, so this needs no build step. */
function officialServers() {
  const src = readFileSync(join(__dirname, '..', 'src', 'official.ts'), 'utf8')
  const out = []
  const re = /\{\s*id:\s*'([^']+)',\s*title:\s*'([^']+)',\s*domain:\s*'([^']+)'([^}]*)\}/g
  let m
  while ((m = re.exec(src))) {
    const rest = m[4] || ''
    out.push({
      id: m[1],
      title: m[2],
      domain: m[3],
      iconDomain: (rest.match(/iconDomain:\s*'([^']+)'/) || [])[1] || null,
      iconUrl: (rest.match(/iconUrl:\s*'([^']+)'/) || [])[1] || null
    })
  }
  return out
}

/** domain -> winning URL, from the app's own resolution table. */
function resolutions() {
  const db = join(HOME, 'bridge.db')
  if (!existsSync(db)) return new Map()
  try {
    const rows = execFileSync('sqlite3', ['-separator', '\t', db,
      'SELECT domain, icon_url FROM icon_resolution WHERE icon_url IS NOT NULL;'], { encoding: 'utf8' })
    return new Map(rows.trim().split('\n').filter(Boolean).map((r) => r.split('\t')))
  } catch {
    return new Map()
  }
}

function fromCache(url) {
  const hash = createHash('sha256').update(url).digest('hex').slice(0, 24)
  for (const ext of ['png', 'svg', 'ico', 'jpg', 'webp']) {
    const p = join(CACHE, `${hash}.${ext}`)
    if (existsSync(p)) return { bytes: readFileSync(p), mime: MIME[ext] }
  }
  return null
}

/**
 * Conventional paths and the page's own `<link rel="icon">`, largest-first.
 *
 * Deliberately NOT importing `@bridge/favicon`: this is a CommonJS Electron
 * script and that package is TypeScript, so a dynamic import of it hangs the
 * process rather than failing. The ranked search lives there and is tested
 * there; what is needed here is only enough to fill gaps the app's own cache
 * does not already cover.
 */
const CONVENTIONAL = [
  ['/apple-touch-icon.png', 180],
  ['/apple-touch-icon-precomposed.png', 180],
  ['/favicon-192x192.png', 192],
  ['/favicon-96x96.png', 96],
  ['/favicon-32x32.png', 32],
  ['/favicon.svg', 1024],
  ['/favicon.ico', 16]
]

async function pageCandidates(domain) {
  try {
    const res = await fetch(`https://${domain}/`, {
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36' },
      signal: AbortSignal.timeout(12_000)
    })
    if (!res.ok) return []
    const html = (await res.text()).slice(0, 200_000)
    const out = []
    for (const tag of html.match(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*>/gi) || []) {
      const href = (tag.match(/href=["']([^"']+)["']/i) || [])[1]
      if (!href) continue
      const sizes = (tag.match(/sizes=["'](\d+)x/i) || [])[1]
      try {
        out.push({ url: new URL(href, `https://${domain}/`).href, size: sizes ? Number(sizes) : 0 })
      } catch { /* skip a malformed href */ }
    }
    return out
  } catch {
    return []
  }
}

async function fromNetwork(entry) {
  const domain = entry.iconDomain || entry.domain
  const targets = entry.iconUrl ? [{ url: entry.iconUrl, size: 1024 }] : []
  targets.push(...(await pageCandidates(domain)))
  targets.push(...CONVENTIONAL.map(([path, size]) => ({ url: `https://${domain}${path}`, size })))
  // Largest first, but .ico held back: it is nearly always tiny, and it is also
  // the only thing some vendors publish.
  const ico = (u) => /\.ico(\?|$)/i.test(u)
  targets.sort((a, b) => (ico(a.url) ? 1 : 0) - (ico(b.url) ? 1 : 0) || b.size - a.size)

  for (const t of targets.slice(0, 10)) {
    try {
      const res = await fetch(t.url, { headers: { accept: 'image/*', 'user-agent': 'Bridge-MCP-Client' }, signal: AbortSignal.timeout(12_000) })
      if (!res.ok) continue
      const mime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
      if (!EXT[mime]) continue
      const bytes = Buffer.from(await res.arrayBuffer())
      if (bytes.length && bytes.length <= 256 * 1024) return { bytes, mime }
    } catch { /* next candidate */ }
  }
  return null
}

/** Vector stays vector; raster is capped at 96px because that is all it needs. */
function shrink(bytes, mime) {
  if (mime === 'image/svg+xml') return { bytes, mime }
  const img = nativeImage.createFromBuffer(bytes)
  if (img.isEmpty()) return { bytes, mime }        // .ico — Electron cannot decode it
  const { width } = img.getSize()
  if (width <= MAX_PX) return { bytes, mime }
  return { bytes: img.resize({ width: MAX_PX, height: MAX_PX, quality: 'best' }).toPNG(), mime: 'image/png' }
}

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const entries = officialServers()
  const resolved = resolutions()
  const icons = []
  const missing = []
  let cached = 0
  let fetched = 0

  for (const entry of entries) {
    const url = entry.iconUrl || resolved.get(entry.iconDomain || entry.domain)
    let got = url ? fromCache(url) : null
    if (got) cached++
    else {
      got = await fromNetwork(entry)
      if (got) fetched++
    }
    if (!got) { missing.push(entry.title); continue }
    const small = shrink(got.bytes, got.mime)
    icons.push([entry.id, `data:${small.mime};base64,${small.bytes.toString('base64')}`])
  }

  icons.sort((a, b) => a[0].localeCompare(b[0]))
  const bytes = icons.reduce((n, [, d]) => n + d.length, 0)

  writeFileSync(OUT, `/**
 * GENERATED — do not edit. Run \`npm run icons:catalogue\` to rebuild.
 *
 * The curated vendors' marks, as data URIs, compiled into the app.
 *
 * The desktop app deliberately does not ask vendors for icons: every install
 * doing its own favicon crawl told dozens of publishers that a Bridge user
 * existed. But the 55 curated entries are compiled in so the Library works
 * before there is a network, and without their icons that Library renders as 55
 * grey monograms and looks broken. So the icons ship the same way the entries
 * do.
 *
 * Entries beyond the curated set need a catalogue service anyway; their icons
 * come from it, restricted to that service's own asset origin.
 *
 * ${icons.length} of ${entries.length} vendors, ${(bytes / 1024).toFixed(0)} kB of base64.
 */
const ICONS: Record<string, string> = {
${icons.map(([id, data]) => `  ${id}: '${data}'`).join(',\n')}
}

/** The vendor's mark for a curated entry, or null if we ship none. */
export function officialIconData(key: string): string | null {
  const id = key.startsWith('bridge:') ? key.slice(7) : key
  return ICONS[id] ?? null
}
`)

  console.log(`wrote ${icons.length}/${entries.length} icons (${(bytes / 1024).toFixed(0)} kB base64)`)
  console.log(`  ${cached} from the local cache, ${fetched} fetched`)
  if (missing.length) console.log(`  no icon found: ${missing.join(', ')}`)
  app.exit(0)
})
