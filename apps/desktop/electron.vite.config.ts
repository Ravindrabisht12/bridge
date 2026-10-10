import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const shared = resolve(__dirname, 'src/shared')

/**
 * `@bridge/*` resolves into the workspace packages by source, not by a built
 * artifact: there is no build step between editing a shared package and
 * running the app, which is the point of the monorepo.
 */
const alias = {
  '@shared': shared,
  '@bridge/catalogue-data': resolve(__dirname, '../../packages/catalogue-data/src/index.ts'),
  '@bridge/favicon': resolve(__dirname, '../../packages/favicon/src/index.ts'),
  '@bridge/registry': resolve(__dirname, '../../packages/registry/src/index.ts'),
  '@bridge/types': resolve(__dirname, '../../packages/types/src/index.ts')
}

/**
 * The workspace packages must be BUNDLED, not externalised.
 *
 * `externalizeDepsPlugin()` externalises everything in `dependencies`, which is
 * right for `better-sqlite3` — a native module that has to be loaded from disk
 * — and catastrophic for these. They are TypeScript source, so an externalised
 * `require('@bridge/registry')` resolves to a `.ts` file and Node's CJS loader
 * dies on the first `export`. The app failed to launch at all.
 *
 * Derived from `alias` rather than listed by hand, so adding a package cannot
 * reintroduce this.
 */
const bundled = Object.keys(alias).filter((name) => name.startsWith('@bridge/'))

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: bundled })],
    resolve: { alias },
    build: {
      rollupOptions: {
        // These entry points share the main build so they share the same
        // Node ABI as the packaged Electron binary (see ARCHITECTURE.md).
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          proxy: resolve(__dirname, 'src/proxy/cli.ts'),
          // Claude Code launches this one per native tool call, so it needs the
          // same Node ABI and the same real-file-on-disk treatment as the proxy.
          hook: resolve(__dirname, 'src/hooks/cli.ts')
        },
        output: { entryFileNames: '[name].js' }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: bundled })],
    resolve: { alias },
    build: { rollupOptions: { input: resolve(__dirname, 'src/preload/index.ts') } }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias },
    plugins: [react()],
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') }
    }
  }
})
