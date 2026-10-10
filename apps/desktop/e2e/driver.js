/**
 * Seeds fixtures, drives the built proxy over stdio, and asserts on both the
 * responses the client saw and the rows the proxy recorded.
 * Runs under ELECTRON_RUN_AS_NODE (see run.js).
 */
const { spawn } = require('node:child_process')
const path = require('node:path')

const HOME = process.env.BRIDGE_HOME
const PROJ = process.env.PROJ
// Resolved rather than path-joined: npm hoists better-sqlite3 to the
// workspace root, so a hardcoded <project>/node_modules path breaks the
// moment the app stops being the repo root.
const Database = require('better-sqlite3')
const DB_PATH = path.join(HOME, 'bridge.db')
const PROXY = path.join(PROJ, 'out', 'main', 'proxy.js')
const SERVER_ID = 'srv_e2e'
const SYNTHETIC_CREDENTIAL = 'sk-proj-' + 'Z'.repeat(32)

const results = []
const assert = (label, cond, extra = '') => results.push({ label, pass: !!cond, extra })

function seed() {
  const db = new Database(DB_PATH)
  // Ordinary policy-mode regression fixture; strict defaults are checked below.
  db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run('strictActionApproval', 'false')
  const now = Date.now()
  const target = {
    kind: 'stdio',
    command: process.execPath,
    args: [path.join(__dirname, 'fake-server.js')],
    env: { ELECTRON_RUN_AS_NODE: '1' }
  }
  db.prepare(
    `INSERT OR REPLACE INTO servers (id,name,client,target,enabled,installed,created_at,updated_at)
     VALUES (?,?,?,?,1,1,?,?)`
  ).run(SERVER_ID, 'fake-weather', 'claude-desktop', JSON.stringify(target), now, now)

  const rules = [
    ['e2e_deny', 10, 'Block credential files', 'deny', { tool: '*', argMatches: '(^|[/\\\\"\'\\s])(\\.env|id_rsa|\\.ssh/)' }],
    ['e2e_ask', 21, 'Confirm before sending', 'ask', { tool: 're:(send|post|email|message)' }],
    ['e2e_allow', 90, 'Allow reads', 'allow', { tool: 're:^(get|read|list|search)' }]
  ]
  for (const [id, priority, name, effect, match] of rules) {
    db.prepare(
      `INSERT OR REPLACE INTO rules (id,enabled,priority,name,description,match,effect,redact,created_at,updated_at)
       VALUES (?,1,?,?,'',?,?,NULL,?,?)`
    ).run(id, priority, name, JSON.stringify(match), effect, now, now)
  }
  // Hide one tool so the filtering path is exercised.
  db.prepare(
    `INSERT OR REPLACE INTO tool_prefs (server_id, name, enabled, updated_at) VALUES (?,?,0,?)`
  ).run(SERVER_ID, 'read_file', now)
  db.close()
}

function drive() {
  // Point at a socket that cannot exist, so the "app is closed" path is exercised.
  const proxy = spawn(process.execPath, [PROXY, '--id', SERVER_ID], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      BRIDGE_HOME: HOME,
      BRIDGE_SOCKET: path.join(HOME, 'no-such.sock')
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  proxy.stderr.on('data', (d) => process.stderr.write(`[proxy] ${d}`))

  const responses = new Map()
  let buf = ''
  proxy.stdout.setEncoding('utf8')
  proxy.stdout.on('data', (chunk) => {
    buf += chunk
    let i
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (line.trim()) {
        const msg = JSON.parse(line)
        responses.set(msg.id, msg)
      }
    }
  })

  const send = (id, method, params) =>
    proxy.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')

  send(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } })
  send(2, 'tools/list', {})
  send(3, 'tools/call', { name: 'get_weather', arguments: { city: 'Almora' } })
  send(4, 'tools/call', { name: 'get_poisoned', arguments: {} })
  send(5, 'tools/call', { name: 'get_weather', arguments: { path: '/Users/me/app/.env' } })
  send(6, 'tools/call', { name: 'send_message', arguments: { to: '+911234567890', body: 'hi' } })
  send(7, 'tools/call', { name: 'read_file', arguments: { path: '/tmp/harmless.txt' } })
  send(8, 'tools/call', { name: 'get_weather', arguments: { data: SYNTHETIC_CREDENTIAL } })

  setTimeout(() => {
    const settingsDb = new Database(DB_PATH)
    settingsDb.prepare('DELETE FROM settings WHERE key = ?').run('strictActionApproval')
    const session = settingsDb.prepare('SELECT id FROM sessions WHERE server_id=? AND ended_at IS NULL LIMIT 1').get(SERVER_ID)
    // Predicate grants: pin the target (city), leave the payload (note) free.
    // The point of the redesign is that a varying payload still matches.
    const grant = (id, city, expiry, opts = {}) =>
      settingsDb
        .prepare(
          `INSERT INTO action_grants (id,session_id,server_id,tools,constraints,label,expires_at,remaining,revoked_at,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          id,
          opts.sessionId === undefined ? session.id : opts.sessionId,
          SERVER_ID,
          JSON.stringify(['get_weather']),
          JSON.stringify([
            { path: 'city', op: 'eq', values: [city] },
            { path: 'note', op: 'any', values: [] }
          ]),
          `get_weather — city = ${city}`,
          expiry,
          opts.remaining ?? 1,
          opts.revokedAt ?? null,
          Date.now()
        )
    grant('permit_e2e', 'Permitted', Date.now() + 60_000, { remaining: 2 })
    grant('permit_expired', 'Expired', Date.now() - 1)
    grant('permit_revoked', 'Revoked', Date.now() + 60_000, { revokedAt: Date.now() })
    grant('permit_other_session', 'OtherSession', Date.now() + 60_000, { sessionId: 'different-session' })
    grant('permit_unbound', 'Unbound', Date.now() + 60_000, { sessionId: null })
    grant('permit_oneof', 'Ignored', Date.now() + 60_000, { remaining: 3 })
    settingsDb
      .prepare('UPDATE action_grants SET constraints=? WHERE id=?')
      .run(JSON.stringify([{ path: 'city', op: 'in', values: ['Alpha', 'Beta'] }]), 'permit_oneof')
    settingsDb.close()
    // A varying payload inside the same pinned scope: this is what the old
    // exact-digest grant could never do.
    send(10, 'tools/call', { name: 'get_weather', arguments: { city: 'Permitted', note: 'first' } })
    send(11, 'tools/call', { name: 'get_weather', arguments: { city: 'Permitted', note: 'second and different' } })
    send(16, 'tools/call', { name: 'get_weather', arguments: { city: 'Permitted', note: 'third — over the cap' } })
    send(12, 'tools/call', { name: 'get_weather', arguments: { city: 'Changed', note: 'first' } })
    send(13, 'tools/call', { name: 'get_weather', arguments: { city: 'Expired' } })
    send(14, 'tools/call', { name: 'get_weather', arguments: { city: 'Revoked' } })
    send(15, 'tools/call', { name: 'get_weather', arguments: { city: 'OtherSession' } })
    send(17, 'tools/call', { name: 'get_weather', arguments: { city: 'Unbound', note: 'no session binding' } })
    send(18, 'tools/call', { name: 'get_weather', arguments: { city: 'Alpha' } })
    send(19, 'tools/call', { name: 'get_weather', arguments: { city: 'Beta' } })
    send(20, 'tools/call', { name: 'get_weather', arguments: { city: 'Gamma' } })
    send(9, 'tools/call', { name: 'get_weather', arguments: { city: 'Strict mode' } })
  }, 1200)

  setTimeout(() => {
    proxy.stdin.end()
    setTimeout(() => verify(responses), 700)
  }, 2500)
}

function verify(responses) {
  assert('strict default blocks allowed reads offline after a policy change', responses.get(9)?.error?.code === -32001)
  assert('scoped permission dispatches inside its scope', !!responses.get(10)?.result)
  assert('scoped permission covers a changed payload', !!responses.get(11)?.result, JSON.stringify(responses.get(11)))
  assert('scoped permission covers a value set', !!responses.get(18)?.result && !!responses.get(19)?.result)
  assert('unbound permission works without a session match', !!responses.get(17)?.result, JSON.stringify(responses.get(17)))
  for (const [id, reason] of [
    [16, 'a spent use cap'],
    [12, 'a target outside the scope'],
    [13, 'expiry'],
    [14, 'revocation'],
    [15, 'a different bound session'],
    [20, 'a value outside the set']
  ]) {
    assert(`scoped permission rejects ${reason}`, responses.get(id)?.error?.code === -32001, JSON.stringify(responses.get(id)))
  }
  assert('initialize passes through' , responses.get(1)?.result?.serverInfo?.name === 'fake-weather')
  // The client sees the filtered list; the full inventory is asserted against
  // the database further down ('tool inventory fingerprinted').
  assert('tools/list returns a well-formed filtered list', Array.isArray(responses.get(2)?.result?.tools))
  assert('allowed result reaches the model', /Almora/.test(JSON.stringify(responses.get(3)?.result ?? '')))
  assert('flagged result is delivered, not blocked', !!responses.get(4)?.result)
  assert('.env read blocked by policy', responses.get(5)?.error?.code === -32001, JSON.stringify(responses.get(5)))
  assert('ask fails closed with no UI reachable', responses.get(6)?.error?.code === -32001, JSON.stringify(responses.get(6)))

  assert('credential in data field blocks an otherwise allowed read', responses.get(8)?.error?.code === -32001 && /credential/.test(responses.get(8)?.error?.message ?? ''))

  const listed = responses.get(2)?.result?.tools ?? []
  assert('hidden tool is stripped from tools/list', !listed.some((t) => t.name === 'read_file'), JSON.stringify(listed.map((t) => t.name)))
  assert('other tools still advertised', listed.length === 3, String(listed.length))
  assert(
    'listChanged capability is advertised to the client',
    responses.get(1)?.result?.capabilities?.tools?.listChanged === true,
    JSON.stringify(responses.get(1)?.result?.capabilities)
  )
  assert(
    'call to a hidden tool is refused',
    responses.get(7)?.error?.code === -32001 && /switched off/.test(responses.get(7)?.error?.message ?? ''),
    JSON.stringify(responses.get(7))
  )

  const db = new Database(DB_PATH, { readonly: true })
  const calls = db
    .prepare('SELECT tool,status,decision,decided_by,finding_count,max_severity,token_estimate,duration_ms FROM calls ORDER BY started_at')
    .all()
  const tools = db.prepare('SELECT name,revision FROM tools').all()
  const sessions = db.prepare('SELECT server_info,client_info,ended_at FROM sessions WHERE server_info IS NOT NULL').all()
  const evidence = db.prepare('SELECT args,result,error,findings FROM calls').all()
  assert('synthetic credential is absent from persisted trace', !JSON.stringify(evidence).includes(SYNTHETIC_CREDENTIAL))
  assert('persisted argument JSON remains valid', evidence.every((row) => { try { if (row.args) JSON.parse(row.args); return true } catch { return false } }))
  db.close()

  const byTool = (t) => calls.find((c) => c.tool === t)
  assert('every call is recorded', calls.length === 18, JSON.stringify(calls.map((c) => `${c.tool}:${c.status}`)))
  assert('injection detected in result', byTool('get_poisoned')?.max_severity === 'high', JSON.stringify(byTool('get_poisoned')))
  assert('clean result not flagged', calls.find((c) => c.tool === 'get_weather' && c.status === 'completed')?.finding_count === 0)
  assert('token estimate captured', calls.find((c) => c.tool === 'get_weather' && c.status === 'completed')?.token_estimate > 0)
  assert('latency captured', typeof calls.find((c) => c.tool === 'get_weather' && c.status === 'completed')?.duration_ms === 'number')
  assert('denied call recorded as denied', calls.some((c) => c.status === 'denied' && c.decision === 'deny'))
  assert('offline fallback attributed', byTool('send_message')?.decided_by === 'offline')
  assert('tool inventory fingerprinted', tools.length === 4, JSON.stringify(tools))
  assert('server identity captured', JSON.parse(sessions[0]?.server_info ?? '{}').name === 'fake-weather')
  assert('session closed cleanly', sessions[0]?.ended_at !== null)
  assert(
    'client identity captured from initialize',
    JSON.parse(sessions[0]?.client_info ?? '{}').name === 'e2e',
    String(sessions[0]?.client_info)
  )

  let failed = 0
  for (const r of results) {
    if (!r.pass) failed++
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.label}${r.pass ? '' : `   ${r.extra}`}`)
  }
  console.log(`\n${results.length - failed}/${results.length} end-to-end checks passed`)
  process.exit(failed ? 1 : 0)
}

seed()
drive()
