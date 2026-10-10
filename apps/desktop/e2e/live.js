/**
 * Does the Calls page show a real call as it happens, or only on a later poll?
 *
 * This drives the built proxy against the stub server with the real app open
 * and measures how long the new line takes to appear, then checks the line
 * carries the call's arguments.
 *
 * Runs as a real Electron app (see runApp in run.js), not in Node mode.
 */
const { app } = require('electron')
const path = require('node:path')
const { spawn } = require('node:child_process')
const Database = require('better-sqlite3')

const fail = (why) => {
  process.stderr.write(`live: ${why}\n`)
  app.exit(1)
}
process.on('uncaughtException', (err) => fail(`uncaught — ${err && err.message}`))
process.on('unhandledRejection', (err) => fail(`unhandled rejection — ${err && err.message}`))
const timer = setTimeout(() => fail('timed out'), 60_000)

const HOME = process.env.BRIDGE_HOME
const PROJ = process.env.PROJ
const SERVER_ID = 'srv_live'
/** Anything above this could have come from the fallback poll, not the stream. */
const LIVE_BUDGET_MS = 2_500

function seed() {
  const db = new Database(path.join(HOME, 'bridge.db'))
  const now = Date.now()
  db.prepare(
    `INSERT OR REPLACE INTO servers (id,name,client,target,enabled,installed,created_at,updated_at)
     VALUES (?,?,?,?,1,1,?,?)`
  ).run(
    SERVER_ID,
    'live-stub',
    'claude-desktop',
    JSON.stringify({
      kind: 'stdio',
      command: process.execPath,
      args: [path.join(PROJ, 'e2e', 'fake-server.js')],
      env: { ELECTRON_RUN_AS_NODE: '1' }
    }),
    now,
    now
  )
  // Allow the read outright so the call completes without a prompt.
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('strictActionApproval','false')").run()
  db.prepare(
    `INSERT OR REPLACE INTO rules (id,enabled,priority,name,description,match,effect,redact,created_at,updated_at)
     VALUES (?,1,?,?,'',?,?,NULL,?,?)`
  ).run('live_allow', 10, 'Allow reads', JSON.stringify({ tool: 'get_weather' }), 'allow', now, now)
  db.close()
}

app.on('browser-window-created', (_event, win) => {
  win.webContents.on('did-fail-load', (_e, code, description) =>
    fail(`renderer failed to load (${code} ${description})`)
  )
  win.webContents.once('did-finish-load', async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const js = (script) => win.webContents.executeJavaScript(script)
    try {
      // Seeded here, not at module load: this phase gets a fresh BRIDGE_HOME and
      // the app itself runs the migrations that create these tables.
      seed()

      await js("location.hash = '#/trace'")
      for (let i = 0; i < 60; i++) {
        if (await js("document.querySelector('h1')?.textContent === 'Calls'")) break
        await wait(100)
      }
      const before = await js("document.querySelectorAll('.call-line').length")

      const proxy = spawn(process.execPath, [path.join(PROJ, 'out', 'main', 'proxy.js'), '--id', SERVER_ID], {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          BRIDGE_HOME: HOME,
          BRIDGE_SOCKET: process.env.BRIDGE_SOCKET
        },
        stdio: ['pipe', 'pipe', 'pipe']
      })
      proxy.stderr.on('data', (d) => process.stderr.write(`[proxy] ${d}`))
      const send = (id, method, params) =>
        proxy.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')

      // Let the proxy start and authenticate on the control socket first.
      await wait(1200)
      send(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'live', version: '1' } })
      await wait(400)

      const started = Date.now()
      send(2, 'tools/call', { name: 'get_weather', arguments: { city: 'Almora' } })

      let appeared = null
      for (let i = 0; i < 80; i++) {
        if ((await js("document.querySelectorAll('.call-line').length")) > before) {
          appeared = Date.now() - started
          break
        }
        await wait(50)
      }
      proxy.stdin.end()

      if (appeared === null) return fail('the call never reached the Calls page')
      if (appeared > LIVE_BUDGET_MS) {
        return fail(`activity took ${appeared}ms — slow enough to be the fallback poll, not the live stream`)
      }

      const preview = await js("document.querySelector('.call-line .call-args').innerText")
      if (!preview.includes('Almora')) {
        return fail(`argument preview lost its stored value: ${JSON.stringify(preview)}`)
      }

      clearTimeout(timer)
      process.stdout.write(`live: Calls showed a real call in ${appeared}ms with its arguments\n`)
      app.exit(0)
    } catch (err) {
      fail(`could not drive the page — ${err && err.message}`)
    }
  })
})

require(process.env.LAUNCH_MAIN)
