/**
 * Rasterise ONE svg at 1024 and downscale to the requested sizes.
 * One source per process: a second offscreen load in the same process fails
 * with ERR_FAILED, so the caller invokes this once per artwork.
 */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const PROJ = process.env.PROJ
const OUT = path.join(PROJ, 'resources', 'iconset')
const SVG = path.join(PROJ, 'resources', process.env.SVG)
const SIZES = process.env.SIZES.split(',').map(Number)
const BASE = 1024

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const svg = fs.readFileSync(SVG, 'utf8')
  const tmp = path.join(os.tmpdir(), `bridge-icon-${Date.now()}.html`)
  fs.writeFileSync(
    tmp,
    `<!doctype html><meta charset="utf-8"><style>
     html,body{margin:0;padding:0;background:transparent;width:${BASE}px;height:${BASE}px;overflow:hidden}
     svg{width:${BASE}px;height:${BASE}px;display:block}</style>${svg}`
  )
  const win = new BrowserWindow({
    width: BASE, height: BASE, show: false, frame: false, transparent: true,
    webPreferences: { offscreen: true }
  })
  await win.loadFile(tmp)
  await new Promise((r) => setTimeout(r, 700))
  const master = await win.webContents.capturePage()
  win.destroy()
  try { fs.unlinkSync(tmp) } catch {}

  for (const size of SIZES) {
    const img = size === BASE ? master : master.resize({ width: size, height: size, quality: 'best' })
    fs.writeFileSync(path.join(OUT, `icon_${size}x${size}.png`), img.toPNG())
    console.log(`${process.env.SVG} -> ${size}`)
  }
  app.exit(0)
})
