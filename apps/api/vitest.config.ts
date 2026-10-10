import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

const pkg = (name: string) => resolve(import.meta.dirname, `../../packages/${name}/src/index.ts`)

export default defineConfig({
  root: import.meta.dirname,
  resolve: {
    alias: { '@bridge/types': pkg('types'), '@bridge/pgtest': pkg('pgtest') }
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000
  }
})
