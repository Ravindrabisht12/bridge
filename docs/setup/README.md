# Setup

| I want to… | Read |
|---|---|
| Work on the desktop app only | [local.md](local.md) → **Mode A** |
| Run the whole stack on my machine | [local.md](local.md) → **Mode B** |
| Deploy it | [production.md](production.md) |

## Local vs production

The difference is smaller than it looks: **the same code runs in both.** What
changes is where four things live.

| | Local | Production |
|---|---|---|
| **Catalogue database** | Postgres 17 in Docker (`db`) | Supabase Postgres |
| **API** | Docker (`api`) on `127.0.0.1:8787` | Fly.io / Railway, behind a CDN |
| **Snapshots + icons** | nginx (`assets`) on `127.0.0.1:8788`, backed by a Docker volume | Supabase Storage, behind a CDN |
| **Weekly worker** | `docker compose run` on demand | GitHub Actions cron, Mondays 03:00 UTC |
| **Desktop app** | `npm run dev`, pointed at localhost | signed `.dmg`, pointed at your API |

Two things are identical in both, on purpose:

- **Migrations.** The same files in `infrastructure/supabase/migrations/` are
  applied by Docker's `docker-entrypoint-initdb.d` locally and by `supabase db
  push` in production. There is no "local schema".
- **The user's own data.** Trace, policies and tokens live in local SQLite on
  the user's machine in *both* environments. There is no configuration that
  moves them, and nothing in the API accepts them — a test fails if any
  endpoint gains a request body. See `SERVICE-ARCHITECTURE.md` §0.

## What the desktop app does with no server at all

It works. The curated 55 servers are compiled into the app and seeded on first
launch (`applySeed` / `applyOfficial`), so the Library is useful before there is
a network. Pointing it at a catalogue service adds the other ~28,000 entries and
keeps the curated set fresh; it is not a prerequisite for the app running.

That matters for the order you do things in: you can develop the desktop app for
a long time without touching any of this.
