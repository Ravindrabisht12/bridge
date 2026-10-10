import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Explicit, so the suite runs the same from the repo root or from here.
  root: __dirname,
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      // Matches electron.vite.config.ts: the app's suite must exercise the
      // same shared-package source the app itself bundles.
      '@bridge/catalogue-data': resolve(__dirname, '../../packages/catalogue-data/src/index.ts'),
      '@bridge/favicon': resolve(__dirname, '../../packages/favicon/src/index.ts'),
      '@bridge/registry': resolve(__dirname, '../../packages/registry/src/index.ts'),
      '@bridge/types': resolve(__dirname, '../../packages/types/src/index.ts')
    }
  },
  test: { globals: true, environment: 'node', include: ['src/test/**/*.test.ts'] }
})
