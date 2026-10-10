/**
 * Answers one question: what can I run right now, and what is missing?
 *
 * Worth being a script rather than a paragraph in a README, because the answer
 * changes — a stale build, a missing `.env`, a Docker daemon that is not up.
 * Reads only; changes nothing.
 */
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const ok = (s) => `\x1b[32m${s}\x1b[0m`
const no = (s) => `\x1b[31m${s}\x1b[0m`
const dim = (s) => `\x1b[2m${s}\x1b[0m`
const row = (label, value, note = '') =>
  console.log(`  ${label.padEnd(30)} ${value}${note ? dim('   ' + note) : ''}`)

const quiet = (cmd) => {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return null
  }
}

console.log('\nTooling')
const node = process.versions.node
const [major, minor] = node.split('.').map(Number)
row('node', major > 22 || (major === 22 && minor >= 14) ? ok(`v${node}`) : no(`v${node}`), 'need 22.14+')
row('npm', ok(quiet('npm -v') ?? '?'))
const docker = quiet('docker info --format "{{.ServerVersion}}"')
row('docker daemon', docker ? ok(docker) : no('not running'), 'Mode B only')

console.log('\nMode A — desktop app, no Docker, no database')
row('built bundle', existsSync(join(root, 'apps/desktop/out/main/index.js')) ? ok('present') : dim('npm run build'))
const iconsFile = join(root, 'packages/catalogue-data/src/icons.ts')
const icons = existsSync(iconsFile) ? (readFileSync(iconsFile, 'utf8').match(/^ {2}off_/gm) ?? []).length : 0
const official = (readFileSync(join(root, 'packages/catalogue-data/src/official.ts'), 'utf8').match(/id: 'off_/g) ?? []).length
row('curated icons compiled in', icons === official ? ok(`${icons}/${official}`) : no(`${icons}/${official}`),
    icons === official ? '' : 'npm run icons:catalogue')
row('ready', ok('yes'), 'npm run dev')

console.log('\nMode B — full stack')
const env = existsSync(join(root, '.env'))
row('.env', env ? ok('present') : no('missing'), env ? '' : 'cp .env.example .env')
row('compose.yaml', existsSync(join(root, 'compose.yaml')) ? ok('present') : no('missing'))
row('ready', docker && env ? ok('yes') : dim('no'), 'docs/setup/local.md')

console.log('\nYour local data')
const home = process.env.BRIDGE_HOME ?? join(homedir(), 'Library/Application Support/Bridge')
const db = join(home, 'bridge.db')
if (!existsSync(db)) {
  row('database', dim('none yet — created on first launch'))
} else {
  const q = (sql) => quiet(`sqlite3 ${JSON.stringify(db)} ${JSON.stringify(sql)}`) ?? '?'
  row('catalogue entries', q('select count(*) from catalog'))
  row('servers connected', q('select count(*) from servers where installed = 1'))
  row('tool calls recorded', q('select count(*) from calls'))
  const digest = q("select coalesce((select value from sync_state where key='service.digest'),'-')")
  row('last service snapshot', digest === '-' ? dim('none — catalogue is from before the service existed') : ok(digest.slice(0, 22) + '…'))
}
console.log('')
