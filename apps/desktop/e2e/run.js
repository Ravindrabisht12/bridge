#!/usr/bin/env node
/**
 * End-to-end check of the built proxy against a stub MCP server.
 *
 *   npm run build && npm run test:e2e
 *
 * Runs the proxy exactly as a packaged install would — the Electron binary in
 * Node mode — so the native module ABI matches what ships.
 */
const { spawnSync } = require('node:child_process')
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')

const electron = require('electron')
const root = path.join(__dirname, '..')
const home = mkdtempSync(path.join(tmpdir(), 'bridge-e2e-'))

/** Runs a script under Electron's Node, which is what the proxy checks need. */
const run = (script, args = []) =>
  spawnSync(electron, [script, ...args], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', BRIDGE_HOME: home, BRIDGE_SOCKET: path.join(home, 'control.sock'), PROJ: root },
    stdio: 'inherit',
    encoding: 'utf8'
  })

/**
 * Runs a script as a real Electron app — no ELECTRON_RUN_AS_NODE, because the
 * launch check needs `app` and a BrowserWindow, which do not exist in Node mode.
 */
const runApp = (script, env = {}) => {
  // Its own BRIDGE_HOME. A real app launch seeds the catalogue and writes
  // settings, and sharing the directory with the checks below changed the state
  // they assert against — 17/17 became 15/17 the first time this ran.
  const appHome = mkdtempSync(path.join(tmpdir(), 'bridge-e2e-launch-'))
  return spawnSync(electron, [script, `--user-data-dir=${path.join(appHome, 'chromium')}`], {
    env: { ...process.env, BRIDGE_HOME: appHome, BRIDGE_SOCKET: path.join(appHome, 'control.sock'), PROJ: root, ...env },
    stdio: 'inherit',
    encoding: 'utf8'
  })
}

try {
  const blockedHome = path.join(home, 'not-a-directory')
  writeFileSync(blockedHome, 'fixture')
  const unavailablePolicy = spawnSync(electron, [path.join(root, 'out', 'main', 'proxy.js'), '--id', 'policy-unavailable'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', BRIDGE_HOME: blockedHome, BRIDGE_SOCKET: path.join(home, 'control.sock') },
    encoding: 'utf8', timeout: 10_000
  })
  if (unavailablePolicy.status !== 5 || unavailablePolicy.stdout) {
    console.error('FAIL proxy must refuse startup without local policy storage')
    process.exit(1)
  }
  console.log('PASS proxy refuses startup without local policy storage')
  // Phase 1: let the proxy create the schema. It exits 3 because no server
  // with this id is registered yet, which is the behaviour we want anyway.
  // Cheapest, most fundamental question first: does the built app start?
  const launch = runApp(path.join(__dirname, 'launch.js'), {
    LAUNCH_MAIN: path.join(root, 'out', 'main', 'index.js'),
    BRIDGE_ALLOW_MULTIPLE: '1'
  })
  if (launch.status !== 0) {
    console.error('the built app failed to launch; skipping the rest')
    process.exit(1)
  }

  run(path.join(root, 'out', 'main', 'proxy.js'), ['--id', 'bootstrap'])

  // Phase 2: seed fixtures, drive the proxy, assert on what was recorded.
  const proxyResult = run(path.join(__dirname, 'driver.js'))

  // Phase 3: the unified catalogue SQL, against the same real database.
  const catalogueResult = run(path.join(__dirname, 'catalogue.js'))

  // Phase 4: the Claude Code hook — the surface that decides shell commands.
  // Its own HOME, because it rewrites settings the phase-2 checks assert on.
  const hookHome = mkdtempSync(path.join(tmpdir(), 'bridge-e2e-hook-'))
  const hookEnv = { BRIDGE_HOME: hookHome, BRIDGE_SOCKET: path.join(hookHome, 'control.sock') }
  const runIn = (script, env, args = []) =>
    spawnSync(electron, [script, ...args], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PROJ: root, ...env },
      stdio: 'inherit',
      encoding: 'utf8'
    })
  // Let the proxy create the schema in the hook's directory first.
  // Exits 3 (no such server), which is fine: the schema is created on the way.
  runIn(path.join(root, 'out', 'main', 'proxy.js'), hookEnv, ['--id', 'bootstrap'])
  const hookResult = runIn(path.join(__dirname, 'hook.js'), hookEnv)
  rmSync(hookHome, { recursive: true, force: true })

  // Phase 5: the Security page must follow the live stream, not just its poll.
  const liveResult = runApp(path.join(__dirname, 'live.js'), {
    LAUNCH_MAIN: path.join(root, 'out', 'main', 'index.js'),
    BRIDGE_ALLOW_MULTIPLE: '1'
  })

  process.exit(
    (proxyResult.status ?? 1) ||
      (catalogueResult.status ?? 1) ||
      (hookResult.status ?? 1) ||
      (liveResult.status ?? 1)
  )
} finally {
  rmSync(home, { recursive: true, force: true })
}
