import { join } from 'node:path'
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { app, BrowserWindow, dialog, Menu, Notification, shell, Tray, nativeImage } from 'electron'
import { databasePath, bridgeHome, legacyHomes } from '@shared/control'
import { MAIN_EVENT_CHANNEL, type MainEvent } from '@shared/ipc'
import { FileLogger } from '@shared/logger'
import type { ApprovalRequest } from '@shared/types'
import { closeDatabase, openDatabase } from '../db'
import * as repo from '../db/repo'
import { defaultRules } from '../policy/defaults'
import { ControlServer } from './control/server'
import { registerIpc } from './ipc/handlers'
import { RegistrySync } from './services/registry-sync'
import { IconCache } from './services/icons'
import { catalogStats } from '../db/catalog'
import * as catalogDb from '../db/catalog'
import { applyOfficial, applySeed } from './services/seeding'
import { configEntryCurrent, installServer, setGatewayClients } from './services/clients'

const log = new FileLogger('main')

/** Shown in the menu bar, the About panel, and notifications. */
const PRODUCT_NAME = 'Bridge'
const TAGLINE = 'The center of your AI stack.'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let control: ControlServer | null = null
let registrySync: RegistrySync | null = null

const isDev = !app.isPackaged

/**
 * Only Bridge's own top-level renderer may call the IPC API.
 *
 * The window disables node integration and sandboxes the renderer, but that
 * does not stop a nested frame from calling `invoke`. Pinning to the main
 * window's own WebContents, and rejecting subframes, keeps the privileged
 * surface where the preload script put it.
 */
function isOwnRenderer(event: { sender: Electron.WebContents; senderFrame: Electron.WebFrameMain | null }): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  if (event.sender !== mainWindow.webContents) return false
  const frame = event.senderFrame
  // A missing frame means it has already gone away; a subframe is not the app.
  return !!frame && frame === event.sender.mainFrame
}

function send(event: MainEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(MAIN_EVENT_CHANNEL, event)
  }
}

/**
 * The app icon as a real file on disk.
 *
 * electron-builder's `icon:` only applies to a packaged build, so running from
 * source shows Electron's default instead. Setting it explicitly covers the dev
 * case on every platform: the Dock on macOS, and the window icon elsewhere.
 */
function appIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(app.getAppPath(), 'resources', 'icon.png')
}

function applyAppIcon(): void {
  try {
    const image = nativeImage.createFromPath(appIconPath())
    if (image.isEmpty()) return
    // Only the Dock needs telling; a packaged macOS build reads Info.plist.
    if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(image)
  } catch (err) {
    log.debug(`could not set the app icon: ${(err as Error).message}`)
  }
}

/**
 * Opens a link in the user's browser, and only a web link. Library entries
 * come from a public registry, so a `file:`, `smb:` or custom-protocol URL in
 * one must not reach the OS, which would hand it to whatever app claims it.
 */
function openInBrowser(url: string): void {
  try {
    const { protocol } = new URL(url)
    if (protocol === 'https:' || protocol === 'http:') {
      void shell.openExternal(url)
      return
    }
  } catch {
    /* not a URL at all */
  }
  log.warn(`refused to open a non-web link: ${url.slice(0, 200)}`)
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    // Windows and Linux take the icon from the window itself.
    ...(process.platform === 'darwin' ? {} : { icon: appIconPath() }),
    backgroundColor: '#f6f7f9',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })

  window.once('ready-to-show', () => window.show())

  // Anything that isn't our own UI opens in the real browser, never in-app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    openInBrowser(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    const devServer = process.env.ELECTRON_RENDERER_URL
    if (devServer && url.startsWith(devServer)) return
    event.preventDefault()
    openInBrowser(url)
  })

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  window.on('closed', () => {
    mainWindow = null
  })

  return window
}

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function notifyApproval(request: ApprovalRequest): void {
  showWindow()
  if (!Notification.isSupported()) return
  const notification = new Notification({
    title: `${request.serverName} wants to run ${request.tool}`,
    body:
      request.findings.length > 0
        ? request.findings.map((f) => f.label).join(' · ')
        : 'Waiting for your approval in Bridge.',
    urgency: 'critical'
  })
  notification.on('click', showWindow)
  notification.show()
}

/** A single tray glyph, drawn inline so the app needs no binary assets. */
function trayIcon(): Electron.NativeImage {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
    <circle cx="8" cy="8" r="6" fill="none" stroke="black" stroke-width="1.6"/>
    <circle cx="8" cy="8" r="2" fill="black"/>
  </svg>`
  const image = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`)
  image.setTemplateImage(true)
  return image
}

function buildAppMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: PRODUCT_NAME,
            submenu: [
              { role: 'about', label: `About ${PRODUCT_NAME}` },
              { type: 'separator' },
              { role: 'hide', label: `Hide ${PRODUCT_NAME}` },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit', label: `Quit ${PRODUCT_NAME}` }
            ]
          }
        ] as Electron.MenuItemConstructorOptions[])
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open log folder',
          click: () => void shell.openPath(join(bridgeHome(), 'logs'))
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }] }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createTray(): void {
  try {
    tray = new Tray(trayIcon())
    tray.setToolTip(`${PRODUCT_NAME} — MCP visibility`)
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `Open ${PRODUCT_NAME}`, click: showWindow },
        { type: 'separator' },
        { label: 'Open log folder', click: () => void shell.openPath(join(bridgeHome(), 'logs')) },
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() }
      ])
    )
    tray.on('click', showWindow)
  } catch (err) {
    log.warn(`tray unavailable: ${(err as Error).message}`)
  }
}

/**
 * Carries the data across a rename of the product.
 *
 * The obvious guard — "only run if the new home does not exist" — is wrong on
 * macOS and Windows, because `bridgeHome()` *is* Electron's userData directory
 * and Chromium has already created it (Cookies, Local Storage, Preferences)
 * before this runs. So the test is whether our own database is there, and items
 * move individually rather than renaming a directory over one that exists.
 */
function migrateLegacyHome(): void {
  const home = bridgeHome()
  if (existsSync(databasePath())) return

  const source = legacyHomes().find(
    (candidate) => candidate.dir !== home && existsSync(join(candidate.dir, candidate.db))
  )
  if (!source) return

  const moves: Array<[string, string]> = [
    [source.db, 'bridge.db'],
    [`${source.db}-wal`, 'bridge.db-wal'],
    [`${source.db}-shm`, 'bridge.db-shm'],
    ['icons', 'icons'],
    ['backups', 'backups'],
    ['logs', 'logs']
  ]

  mkdirSync(home, { recursive: true })
  let moved = 0
  for (const [from, to] of moves) {
    const src = join(source.dir, from)
    const dst = join(home, to)
    // Never overwrite: the logger has already made `logs`, and a partial second
    // run must not clobber what the first one moved.
    if (!existsSync(src) || existsSync(dst)) continue
    try {
      renameSync(src, dst)
      moved++
    } catch (err) {
      log.warn(`could not move ${from}: ${(err as Error).message}`)
    }
  }
  if (moved > 0) log.info(`migrated ${moved} items from ${source.dir}`)
}

async function bootstrap(): Promise<void> {
  migrateLegacyHome()
  const db = openDatabase()

  // Seed the starter policy the first time only.
  if (repo.listRules(db).length === 0) {
    for (const rule of defaultRules()) repo.upsertRule(db, rule)
    log.info('seeded default policy rules')
  }

  // Sessions left open by a proxy that was killed rather than shut down.
  const reaped = repo.reapDeadSessions(db)
  if (reaped > 0) log.info(`closed ${reaped} stale session(s) whose process had gone`)

  const settings = repo.readSettings(db)
  if (settings.retentionDays > 0) {
    const removed = repo.purgeOlderThan(db, Date.now() - settings.retentionDays * 86_400_000)
    if (removed > 0) log.info(`purged ${removed} calls past retention`)
  }

  // Before any config is touched: which clients route through one gateway entry.
  setGatewayClients(settings.gatewayClients)

  // A stanza written by an older build can name an id or arg set we no longer
  // use. Rewrite only those that actually differ, so a normal launch does not
  // touch the user's config at all.
  for (const server of repo.listServers(db)) {
    if (!server.installed) continue
    try {
      if (configEntryCurrent(server)) continue
      installServer(server)
      log.info(`repaired config entry for "${server.name}" (${server.client})`)
    } catch (err) {
      log.warn(`could not repair config for "${server.name}": ${(err as Error).message}`)
    }
  }

  control = new ControlServer(log, () => ({
    settings: repo.readSettings(db),
    rules: repo.listRules(db)
  }))

  control.on('event', (event) => send({ t: 'trace', event }))
  control.on('approval', (request: ApprovalRequest) => {
    send({ t: 'approval', request })
    notifyApproval(request)
  })
  control.on('approvalResolved', (id: string) => send({ t: 'approval.resolved', id }))

  try {
    await control.start()
  } catch (err) {
    log.error(`control socket failed to bind: ${(err as Error).message}`)
  }

  const sync = (registrySync = new RegistrySync(db, log, (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('bridge:sync', progress)
    }
  }))

  // Resolutions live in the database so a restart does not re-discover them.
  const icons = new IconCache(log, {
    all: () => catalogDb.allIconResolutions(db),
    remember: (domain, iconUrl) => catalogDb.rememberIcon(db, domain, iconUrl)
  })


  registerIpc(
    control,
    () => control?.broadcastConfig(repo.readSettings(db), repo.listRules(db)),
    sync,
    icons,
    isOwnRenderer
  )

  /**
   * Seed first, and unconditionally.
   *
   * This used to be one branch of the same if/else chain as the sync decision,
   * so a pending backfill took priority and the directory only appeared if a
   * multi-minute sync ran to completion. Quit before it finished and nothing
   * was seeded, the shape marker stayed stale, and the next launch backfilled
   * again — the Library could stay empty indefinitely.
   *
   * The bundled endpoints need no catalogue at all, and both helpers are
   * idempotent and guarded by their own version markers, so doing this on every
   * launch costs a few dozen upserts.
   */
  try {
    applySeed(db, log)
    applyOfficial(db, log)
  } catch (err) {
    log.warn(`front page seeding failed: ${(err as Error).message}`)
  }

  // An empty Library on first open is a dead end, so fill it in the background.
  /*
   * Nothing is downloaded on launch.
   *
   * The curated directory is bundled, so the Library is useful the moment the
   * window opens with no network at all. Pulling the whole registry is ~27,500
   * entries over 276 pages and several minutes — far too much to spend on every
   * start, and it re-ran whenever a sync had been interrupted, which is exactly
   * what it looked like: "Fetching servers… 19500 so far" on every open.
   *
   * The full catalogue is now fetched only when asked for: the Sync button, the
   * empty state behind the "Everything" tab, or a registry search. An
   * already-populated catalogue still refreshes incrementally once a day, which
   * moves only what changed and takes seconds.
   */
  const stats = catalogStats(db)
  const STALE_AFTER_MS = 24 * 60 * 60 * 1000
  if ((process.env.BRIDGE_API_URL || repo.readSettings(db).catalogueSourceUrl) && (stats.lastSyncedAt === null || Date.now() - stats.lastSyncedAt > STALE_AFTER_MS)) {
    log.info('catalogue older than a day; refreshing changed entries')
    void sync.sync(false)
  }

  mainWindow = createWindow()
  createTray()
}

/**
 * One instance owns the control socket, so a second one is normally refused.
 * BRIDGE_ALLOW_MULTIPLE lifts that for development — running a build next to
 * `npm run dev` — and for tests that need their own HOME. The second instance
 * will fail to bind the socket and log it; the database is WAL and safe.
 */
const allowMultiple = process.env.BRIDGE_ALLOW_MULTIPLE === '1'

/*
 * In development the process runs inside Electron's own bundle, so macOS reads
 * the name from that bundle's Info.plist and the menu bar says "Electron".
 * Setting it explicitly — before `whenReady`, which is when the menu is first
 * built — makes the running app carry the product name in every case.
 */
app.setName(PRODUCT_NAME)
app.setAboutPanelOptions({ applicationName: PRODUCT_NAME, credits: TAGLINE })

if (!allowMultiple && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showWindow)

  void app.whenReady().then(async () => {
    app.setAppUserModelId('dev.bridge.app')
    applyAppIcon()
    buildAppMenu()
    try {
      await bootstrap()
    } catch (err) {
      const message = (err as Error).stack ?? (err as Error).message
      log.error(`bootstrap failed: ${message}`)
      // Without this the app sits in the Dock with no window and nothing in
      // the terminal; the only trace would be the log file.
      console.error(`Bridge failed to start: ${message}`)
      dialog.showErrorBox(`${PRODUCT_NAME} failed to start`, `${(err as Error).message}\n\nDetails are in ${join(bridgeHome(), 'logs', 'main.log')}`)
      app.quit()
      return
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
    })
  })

  // Bridge keeps running in the tray: closing the window must not stop
  // recording, because the proxies are still live inside the AI client.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && !tray) app.quit()
  })

  app.on('before-quit', () => {
    // Order matters: stop the sync before the database it writes to goes away.
    registrySync?.abort()
    void control?.stop()
    closeDatabase()
  })
}

process.on('uncaughtException', (err) => log.error(`uncaught: ${err.stack ?? err.message}`))
process.on('unhandledRejection', (reason) => log.error(`unhandled rejection: ${String(reason)}`))
