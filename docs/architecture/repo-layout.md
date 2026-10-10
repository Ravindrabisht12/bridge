# Repository layout

One repo, npm workspaces. Every top-level directory is either an application, a
shared library, infrastructure or docs — nothing loose at the root.

```
bridge/
├─ apps/
│  ├─ desktop/            the Electron app
│  │  ├─ src/             main · renderer · preload · proxy · db · policy · scanners · shared
│  │  ├─ e2e/             38 end-to-end checks against a real SQLite file
│  │  ├─ resources/       icon sources, generated iconset, .icns, entitlements
│  │  ├─ scripts/         npm run icons — renders both SVGs into the iconset
│  │  ├─ electron.vite.config.ts
│  │  └─ electron-builder.yml
│  └─ api/                the catalogue API (Fastify) + openapi.yaml
├─ workers/
│  └─ catalogue-sync/     the weekly job, run by GitHub Actions
├─ packages/
│  ├─ types/              the catalogue contract, shared by all three sides
│  ├─ registry/           MCP registry client + the pure transforms over it
│  ├─ catalogue-data/     the curated 55-server directory + their icons (generated)
│  ├─ favicon/            ranked favicon discovery
│  └─ pgtest/             a real Postgres for tests (PGlite over the wire protocol)
├─ infrastructure/
│  ├─ supabase/           migrations + the ER diagram
│  └─ github-actions/
├─ docs/architecture/
└─ package.json           workspace root only — no source, no `main`
```

## Where dependencies are declared

| Declared in | Why |
|---|---|
| `apps/desktop` | Electron, electron-builder, electron-vite, React, Vite, better-sqlite3 — none of it survives the desktop app being deleted |
| root | TypeScript, vitest, eslint, tsx, esbuild, PGlite — the toolchain, which is not any one app's to own |

npm hoists everything to the root `node_modules` regardless. What matters is
*where it is declared*, because that is what says who owns it.

## Scripts

Desktop scripts exist in both places. The root ones delegate:

```sh
npm run dev            # → --workspace @bridge/desktop
npm run build
npm run test:e2e
npm run icons
```

Everything else runs from the root:

```sh
npm run typecheck:all  # all seven tsconfig projects
npm run test:all       # desktop · registry · api · worker
npm run dev:api        # tsx watch, no database needed
npm run sync           # the weekly job; DRY_RUN=true for a safe pass
npm run db:apply       # migrations against $DATABASE_URL
```

## Two constraints to know before editing

**No `.ts` import extensions, and no constructor parameter properties, enums,
namespaces or decorators** in `apps/api`, `workers/` or `packages/`. Relative
imports are extensionless so tsc, vite, esbuild and vitest all resolve them
identically; the app's `composite: true` config cannot enable
`allowImportingTsExtensions`, which is what forced the choice. Node's
`--experimental-strip-types` erases types but does not transform code, which is
what rules out the rest.

**Shared code is imported by package name, never by relative path.** Every
`packages/*` entry has a `src/index.ts`, an alias in
`apps/desktop/electron.vite.config.ts` and `vitest.config.ts`, a `paths` entry
in the tsconfigs that need it, and a declared dependency in whoever uses it.
`'../../../../packages/foo/src/bar'` works right up until something moves, and
four levels of `../` is exactly what broke when the desktop app was relocated.

**Workspace packages must be bundled, not externalised.**
`externalizeDepsPlugin()` in `apps/desktop/electron.vite.config.ts` externalises
everything in `dependencies`, which is right for `better-sqlite3` — a native
module that has to load from disk — and fatal for `@bridge/*`, which is
TypeScript source. An externalised `require('@bridge/registry')` resolves to a
`.ts` file and Node's CJS loader dies on the first `export`, so the app does not
open at all. The exclude list is derived from the alias map rather than written
by hand, and `e2e/launch.js` boots the built bundle so the gate cannot go green
while the app is unstartable.

**No backticks inside SQL line comments.** They terminate the JavaScript
template literal the query sits in, and the parse error points nowhere near the
cause. There is a test for it (`workers/catalogue-sync/test/sql-hygiene.test.ts`)
because it happened three times.
