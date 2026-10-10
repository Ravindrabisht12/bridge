import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

const pkg = (name: string) => resolve(import.meta.dirname, `../../packages/${name}/src/index.ts`)

export default defineConfig({
  root: import.meta.dirname,
  resolve: {
    alias: {
      '@bridge/catalogue-data': pkg('catalogue-data'),
      '@bridge/favicon': pkg('favicon'),
      '@bridge/types': pkg('types'),
      '@bridge/registry': pkg('registry'),
      '@bridge/pgtest': pkg('pgtest')
    }
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // PGlite boots a WASM Postgres and replays every migration per file.
    testTimeout: 30_000,
    hookTimeout: 60_000
  }
})
