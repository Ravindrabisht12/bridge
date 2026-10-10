/**
 * Does the built app actually start?
 *
 * Nothing else in the gate answers that. `npm run build` typechecks and
 * bundles; the unit suites run source through vitest; the other e2e checks
 * exercise `out/main/proxy.js`. So the whole gate passed green while
 * `out/main/index.js` threw on its first line and the app would not open at
 * all — the workspace packages had been externalised instead of bundled, so the
 * bundle did `require('@bridge/registry')`, which resolves to TypeScript, and
 * Node's CJS loader died on `export`.
 *
 * This boots the real bundle under Electron with a throwaway data directory and
 * fails on any uncaught exception before the window finishes loading.
 */
const { app, BrowserWindow } = require('electron')

const TIMEOUT_MS = 45_000
const fail = (why) => {
  process.stderr.write(`launch: ${why}\n`)
  app.exit(1)
}

const timer = setTimeout(() => fail(`window never finished loading within ${TIMEOUT_MS}ms`), TIMEOUT_MS)

process.on('uncaughtException', (err) => fail(`uncaught exception — ${err && err.message}`))
process.on('unhandledRejection', (err) => fail(`unhandled rejection — ${err && err.message}`))

app.on('browser-window-created', (_event, win) => {
  win.webContents.on('render-process-gone', (_e, details) =>
    fail(`renderer gone (${details && details.reason})`)
  )
  win.webContents.on('did-fail-load', (_e, code, description) =>
    fail(`renderer failed to load (${code} ${description})`)
  )
  win.webContents.once('did-finish-load', async () => {
    try {
      // Not just "a window exists" — the UI has to have actually rendered.
      const heading = await win.webContents.executeJavaScript(
        'document.querySelector("h1") && document.querySelector("h1").textContent'
      )
      const nav = await win.webContents.executeJavaScript('document.querySelectorAll(".nav-item").length')
      const js = (code) => win.webContents.executeJavaScript(code)
      const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      const shot = async (suffix) => {
        if (!process.env.BRIDGE_REVIEW_SCREENSHOT) return
        await pause(200)
        require('node:fs').writeFileSync(`${process.env.BRIDGE_REVIEW_SCREENSHOT}${suffix}.png`, (await win.webContents.capturePage()).toPNG())
      }
      const click = (selector, label) => js(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(x => x.textContent.trim() === ${JSON.stringify(label)}).click()`)

      if (!heading) return fail('no <h1> rendered')
      // Three places, nothing else: servers, the calls through them, settings.
      const labels = await js("Array.from(document.querySelectorAll('.nav-item')).map(x => x.textContent.trim()).join(',')")
      if (labels !== 'Overview,Servers,Library,Calls,Settings') return fail(`expected Overview, Servers, Library, Calls, Settings in the sidebar, got ${labels}`)
      if (heading !== 'Overview') return fail(`expected to open on Overview, got "${heading}"`)

      // IPC contracts the hidden pages relied on still hold.
      const coverage = await js("window.bridge.invoke('security:coverage')")
      if (!Array.isArray(coverage.rows) || !Array.isArray(coverage.unreadableClients)) return fail('coverage IPC contract failed')
      const hookStatus = await js("window.bridge.invoke('hook:status')")
      if (typeof hookStatus.installed !== 'boolean' || typeof hookStatus.command !== 'string') return fail('hook status IPC contract failed')
      const snippet = await js("window.bridge.invoke('hook:snippet')")
      if (!snippet.snippet.includes('PreToolUse') || !snippet.snippet.includes('hook.js')) return fail('hook snippet did not name the built hook')
      const defaults = await js("window.bridge.invoke('settings:get')")
      if (defaults.claudeCodeHook !== false) return fail('hook enforcement must default to off')
      if (!defaults.strictActionApproval) return fail('strict approval must default to on')
      process.stdout.write('launch: coverage, hook and settings IPC verified\n')

      // Overview: the four numbers and its three panels.
      if ((await js("document.querySelectorAll('.home-stat').length")) !== 4) return fail('overview numbers not rendered')
      if ((await js("document.querySelectorAll('.home-panel').length")) !== 3) return fail('overview panels not rendered')
      await shot('.overview')
      process.stdout.write('launch: Overview renders its numbers and panels\n')

      // Servers: adding one by hand is a form, not a trip to the Library.
      await click('.nav-item', 'Servers')
      await pause(150)
      await click('.btn', 'Add server')
      await pause(100)
      if (!(await js("!!document.querySelector('.add-server') && document.body.textContent.includes('Command or URL')"))) return fail('add server form did not open')
      await shot('.servers')
      await click('.btn', 'Cancel')
      process.stdout.write('launch: Servers page opens the add-server form\n')

      // Library: the catalogue is one click from the sidebar.
      await click('.nav-item', 'Library')
      for (let i = 0; i < 40; i++) {
        if (await js("document.querySelector('h1')?.textContent === 'Library'")) break
        await pause(100)
      }
      if (!(await js("document.querySelector('h1')?.textContent === 'Library'"))) return fail('Library page not rendered')
      await pause(600)
      await shot('.library')
      process.stdout.write('launch: Library opens from the sidebar\n')

      // Calls: a recorded call shows as one line and opens to its arguments and result.
      await click('.nav-item', 'Calls')
      await pause(150)
      if (!(await js("document.querySelector('h1')?.textContent === 'Calls'"))) return fail('Calls page not rendered')
      // Synthetic UI fixture only; no provider or user account is contacted.
      const syntheticCall = { id: 'ui-layout-fixture', sessionId: 'synthetic-session', serverId: 'synthetic-gh', serverName: 'github', client: 'claude-code', method: 'tools/call', tool: 'create_issue', args: { repo: 'example/test', title: 'Synthetic issue' }, result: { content: [{ type: 'text', text: 'Created issue #1' }] }, error: null, status: 'completed', decision: 'allow', decidedBy: 'policy', ruleId: null, startedAt: Date.now(), endedAt: Date.now(), durationMs: 240, resultBytes: 80, tokenEstimate: 20, findings: [], redacted: false }
      win.webContents.send('bridge:event', { t: 'trace', event: { t: 'call.end', call: syntheticCall } })
      await pause(150)
      if (!(await js("!!document.querySelector('.call-session .call-line')"))) return fail('call stack did not show the recorded call')
      await js("document.querySelector('.call-head').click()")
      await pause(100)
      const body = await js("document.querySelector('.call-body')?.textContent ?? ''")
      if (!body.includes('Synthetic issue') || !body.includes('Created issue #1')) return fail('call did not open to its arguments and result')
      await shot('.calls')
      process.stdout.write('launch: Calls page shows the call stack and opens a call\n')

      // Settings: privacy controls stay isolated and deletion asks first.
      await click('.nav-item', 'Settings')
      await pause(150)
      await click('.workspace-tabs button', 'Privacy & history')
      await pause(150)
      if (!(await js("!!document.querySelector('[aria-label=\"What to save\"]') && !document.body.textContent.includes('Service URL')"))) return fail('privacy controls not isolated')
      await click('button', 'Delete history…')
      await pause(100)
      if (!(await js("!!document.querySelector('.preference-confirm')"))) return fail('history deletion confirmation missing')
      await click('button', 'Cancel')
      await shot('.settings')

      // The control socket carries approval decisions, so an unauthenticated
      // connection must get nothing at all — not even the config in `welcome`.
      const auth = await checkControlAuth()
      if (auth) return fail(auth)
      process.stdout.write('launch: control socket rejects unauthenticated connections\n')

      process.stdout.write('launch: isolated privacy controls verified\n')
      clearTimeout(timer)
      process.stdout.write(`launch: ok — rendered "${heading}" with ${nav} nav items\n`)
      app.exit(0)
    } catch (err) {
      fail(`could not inspect the window — ${err && err.message}`)
    }
  })
})

/**
 * Dials the live control socket twice: once with no token, once with the real
 * one. Returns a failure string, or null when both behaved.
 */
async function checkControlAuth() {
  const net = require('node:net')
  const fs = require('node:fs')
  const path = require('node:path')

  const socketPath = process.env.BRIDGE_SOCKET
  const tokenPath = path.join(process.env.BRIDGE_HOME, 'control.token')

  if (!fs.existsSync(tokenPath)) return 'control token file was never written'
  const stat = fs.statSync(tokenPath)
  // The token is the only thing keeping another user off the socket.
  if ((stat.mode & 0o077) !== 0) return `control token is group/world readable (mode ${(stat.mode & 0o777).toString(8)})`
  const token = fs.readFileSync(tokenPath, 'utf8').trim()
  if (token.length < 32) return 'control token is too short to be a secret'

  const session = (id) => ({
    id,
    serverId: 'srv_auth_probe',
    serverName: 'auth probe',
    client: 'claude-code',
    pid: process.pid,
    startedAt: Date.now(),
    endedAt: null,
    serverInfo: null,
    clientInfo: null
  })

  /** Connects, sends `hello`, and reports whatever came back within a window. */
  const dial = (hello) =>
    new Promise((resolve) => {
      const socket = net.connect(socketPath)
      let received = ''
      const done = (value) => {
        socket.destroy()
        resolve(value)
      }
      socket.on('connect', () => socket.write(JSON.stringify(hello) + '\n'))
      socket.on('data', (chunk) => {
        received += chunk.toString('utf8')
      })
      socket.on('error', () => done({ error: true }))
      setTimeout(() => done({ received }), 1200)
    })

  const noToken = await dial({ t: 'hello', v: 2, session: session('probe-no-token') })
  if (noToken.received) return `control socket replied to an unauthenticated hello: ${noToken.received.slice(0, 120)}`

  const badToken = await dial({ t: 'hello', v: 2, session: session('probe-bad-token'), token: 'x'.repeat(token.length) })
  if (badToken.received) return 'control socket replied to a wrong token'

  const good = await dial({ t: 'hello', v: 2, session: session('probe-good-token'), token })
  if (!good.received || !good.received.includes('"welcome"')) {
    return `control socket refused a valid token: ${JSON.stringify(good).slice(0, 160)}`
  }
  return null
}

// Requiring the built bundle is the test. If it throws, the process dies here
// and the uncaughtException handler above reports it.
require(process.env.LAUNCH_MAIN)
