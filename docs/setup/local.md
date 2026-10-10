# Running Bridge locally

Two modes. Start with A — it needs no Docker and no database, and it is enough
for most desktop-app work.

**Verified:** every command in Mode A, and the migrations, worker and API in
Mode B. **Not verified:** the containers actually running, because the Docker
daemon was not available on the machine this was written on. Anything unproven
is marked ⚠.

---

## Where am I?

```sh
npm run preflight
```

Reports what you can run right now and what is missing. Reads only, changes
nothing. Run it first, and again whenever something behaves oddly.

## Prerequisites

| | Version | Check |
|---|---|---|
| Node | 22+ | `node -v` |
| npm | 10+ | `npm -v` |
| Docker Desktop | any recent | `docker info` — **Mode B only** |

```sh
git clone <your remote> bridge && cd bridge
npm install
```

`npm install` links the six workspace packages and downloads Electron. Use
Node.js 22.14 or newer (`nvm use`): older 22.x releases cannot run Electron's
installer or load the SQLite driver. `better-sqlite3` ships one Node-API binary
per platform that loads in both Node and Electron, so nothing is rebuilt.

---

## Mode A — desktop app only, no Docker

```sh
npm run dev
```

The app opens with the 55 curated servers already in its Library, seeded from
`@bridge/catalogue-data` — **with their real vendor icons**, which are compiled
in alongside them. Trace, policy, tool controls and client wiring all work.
Search beyond the curated set does not, because that needs the API.

The icons are compiled in for the same reason the entries are. The desktop app
deliberately no longer asks vendors for icons — every install doing its own
favicon crawl told dozens of publishers that a Bridge user existed — and
`catalog:icons` is restricted to a configured service's own asset origin. With
no service, that leaves no icon path at all, and the Library rendered as 55 grey
monograms. Regenerate with:

```sh
npm run icons:catalogue    # rewrites packages/catalogue-data/src/icons.ts
```

Run the API too if you want the full Library, still with no database:

```sh
npm run dev:api        # 127.0.0.1:8787, in-memory catalogue, warns loudly
```

Then in the app: **Settings → catalogue service URL → `http://localhost:8787`**,
or start it pre-pointed:

```sh
BRIDGE_API_URL=http://localhost:8787 npm run dev
```

An empty in-memory catalogue is a legitimate state — the API says so on startup
rather than pretending. Useful for exercising the client's error handling.

### Tests, without any of the above

```sh
npm run test:all       # 389 tests across five suites
npm run test:e2e       # boots the built app, then 38 checks against real SQLite
npm run typecheck:all
npm run lint
```

`test:e2e` starts with the most basic question there is — **does the built app
open?** Nothing else in the gate asks it: `build` typechecks and bundles, the
unit suites run source through vitest, and the remaining e2e checks exercise the
proxy. The gate once passed entirely green while the app threw on its first
line, so `e2e/launch.js` now boots the real bundle and asserts the UI rendered.

The API and worker suites boot **PGlite** — real Postgres compiled to WASM,
behind the wire protocol — so they exercise the actual SQL with no Docker and no
daemon. That is why you can change a query and be confident before ever starting
a container.

---

## Mode B — the whole stack

### 1. Secrets

```sh
cp .env.example .env
# set POSTGRES_PASSWORD to something random:
#   openssl rand -base64 24 | tr -d '/+=' 
```

`.env` is gitignored. `.env.example` is not, and must never hold a real value.

### 2. Start the services

```sh
docker compose up -d db api assets
docker compose ps
```

| Service | Where | What |
|---|---|---|
| `db` | internal `5432` | Postgres 17. Migrations in `infrastructure/supabase/migrations/` are applied automatically on **first** init. |
| `api` | `127.0.0.1:8787` | The catalogue API. Read-only, hardened (`read_only`, `no-new-privileges`). |
| `assets` | `127.0.0.1:8788` | nginx over a shared volume — stands in for the CDN. |

Only `127.0.0.1` is bound. Nothing is reachable from your network.

```sh
curl -s localhost:8787/health          # {"ok":true}
curl -s localhost:8787/v1/featured     # {"items":[],...} until the worker runs
```

⚠ **Migrations run on first init only.** They are `docker-entrypoint-initdb.d`
scripts, which Postgres ignores once the data directory exists. After changing a
migration:

```sh
docker compose down -v && docker compose up -d db api assets
```

`-v` destroys the volume. That is the point — local data is disposable.

### 3. Fill the catalogue

Dry run first. It crawls the real registry but writes nothing:

```sh
DRY_RUN=true FULL=true npm run sync
```

Expect roughly:

```
registry   28346 fetched, +28346 ~0 -0     ~3m40s
downloads   2000 fetched, +0 ~127 -0
probe          0 fetched
publish    28346 fetched                   3.8 MB gzipped snapshot
```

Then for real, inside the compose network:

```sh
docker compose --profile sync run --rm worker
```

The worker seeds `curated` from `@bridge/catalogue-data`, mirrors the registry,
fetches download counts, probes the curated endpoints, resolves their icons into
the shared volume, and publishes a snapshot. It refuses to publish if the
catalogue shrank more than 5% — see `workers/catalogue-sync/README.md`.

```sh
curl -s localhost:8787/v1/featured | head -c 200
curl -s "localhost:8787/v1/search?q=notion" | head -c 200
curl -s localhost:8787/v1/snapshot/latest
```

### 4. Point the desktop app at it

```sh
BRIDGE_API_URL=http://localhost:8787 npm run dev
```

The app pulls `/v1/snapshot/latest`, checks the digest against what it already
has, downloads the gzipped snapshot only if it changed, verifies its sha256 and
entry count, and merges it. Search hits `/v1/search` on demand.

`http://` is accepted **only** for localhost — `serviceUrl()` requires HTTPS
everywhere else, so a typo cannot silently send traffic in the clear.

### 5. Stop

```sh
docker compose down       # keep the data
docker compose down -v    # throw it away
```

---

## Verifying before you deploy

Run all of this green and production is mostly a change of hostnames.

```sh
npm run typecheck:all && npm run lint && npm run test:all && npm run test:e2e
curl -sf localhost:8787/health
curl -sf localhost:8787/v1/featured   | grep -q '"items":\[{'   # curated present
curl -sf "localhost:8787/v1/search?q=notion" | grep -q Notion   # search works
curl -sf localhost:8787/v1/snapshot/latest | grep -q 'sha256-'  # published
docker compose logs api | tail -20                              # no errors
```

Then in the app, confirm by hand:

- Library shows the curated set with **real vendor icons**, not monograms — that
  proves the icon stage wrote to the volume and nginx serves it with the right
  content type.
- A search for something outside the curated set returns results.
- Connect one MCP server, run a tool, and see the row in **Live trace**. This is
  the part no automated check covers, and it is the actual product.

---

## When it goes wrong

| Symptom | Cause |
|---|---|
| `Set POSTGRES_PASSWORD in .env` | No `.env`. Step 1. |
| API healthy, `/v1/featured` empty forever | Worker never ran, or ran but refused to publish. `docker compose --profile sync run --rm worker` and read its output. |
| Icons show as monograms for the **curated 55** | `packages/catalogue-data/src/icons.ts` is missing or stale. `npm run icons:catalogue`. |
| Icons show as monograms for **registry entries** | Icon stage found nothing, or nginx served the wrong type. `curl -I localhost:8788/icons/<hash>.svg` and check `Content-Type`. |
| `Set the Bridge catalogue service URL in Settings` | The app has no URL. Step 4. |
| `Catalogue service requires HTTPS` | A non-localhost `http://` URL. Deliberate. |
| Schema changes not appearing | Migrations only run on first init. `docker compose down -v`. |
| `Snapshot digest mismatch` | Producer and verifier disagree. Both must hash the full JSON — see `buildSnapshot` and `decodeSnapshot`. |
| Electron won't start after `npm install` | Check `node -v` is 22.14+, then `node node_modules/electron/install.js` to fetch the binary again |
| `SyntaxError: Unexpected token 'export'` on launch | A `@bridge/*` package got externalised instead of bundled. Check `externalizeDepsPlugin({ exclude: bundled })` in `apps/desktop/electron.vite.config.ts`. `npm run test:e2e` catches this. |
