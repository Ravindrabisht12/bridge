# Deploying Bridge

> What Bridge does not protect against is in [limitations](../limitations.md).
> This guide describes running the optional catalogue service; it does not make
> the desktop app production-ready security software. Credential storage, OAuth
> compatibility and security review are launch gates; install tracking is deferred.

**Nothing here has been run.** No Supabase project, no hosting account and no
Apple Developer account existed when this was written, so treat it as a plan to
execute rather than a transcript of something that worked. Everything it depends
on *has* been verified locally — the migrations apply, both query layers run
against real Postgres, and the worker completes a full pass against the live
registry.

---

## 0. Decide these first

Three are unanswered and two of them change what you build.

| Decision | Why it blocks |
|---|---|
| **Anonymous install count — yes or no?** | It is the only thing that would send anything up. Yes means one UUID and a `.env` flag; no means the API stays strictly read-only. The site copy differs either way. |
| **Apple Developer account — $99/year, in budget?** | Gates code signing, notarization and auto-update. Without it every install shows a Gatekeeper warning and the updater does not work at all. §5 cannot proceed without it. |
| **Domain** | `api.<yourdomain>` and `cdn.<yourdomain>`. Needed before §2. |

Settled already, for the record: anonymous-first with no mandatory login; the
curated set plus server-side search rather than shipping 28,000 rows to every
client.

---

## 1. Database — Supabase

```sh
npx supabase login
npx supabase link --project-ref <ref>
npx supabase db push          # applies infrastructure/supabase/migrations/
```

Verify the shape landed:

```sql
select table_name from information_schema.tables
 where table_schema = 'public' order by 1;
-- app_releases, catalogue_entries, curated, probes,
-- published_catalogue_entries, published_curated,
-- published_registry_servers, registry_servers, snapshots, sync_runs, sync_state
```

Both `catalogue_entries` **and** `published_catalogue_entries` must exist. The
worker writes the first set; the API reads the second. That split is what stops
a half-finished sync being served — see §4.

**Row Level Security.** Every table here holds public data about third parties,
and the API connects with a role you control, so RLS is not what protects it.
What protects it is that the API has no write path and no endpoint accepts a
body. If you later add an endpoint that writes, revisit this properly.

Take the **pooled** connection string (port 6543) for the API — a serverless or
small container should not hold direct Postgres connections.

---

## 2. Storage and CDN

Create a **public** bucket, `catalogue`.

Two kinds of object go in it, both immutable and content-addressed:

| Path | What | Cache |
|---|---|---|
| `snapshots/<digest>.json.gz` | the bulk catalogue | forever |
| `icons/<sha256>.<ext>` | vendor marks | forever |

Because the name contains the hash, `Cache-Control: public, max-age=31536000,
immutable` is correct and a new publish is a new URL. Nothing ever needs
purging.

Put your CDN in front of the bucket at `cdn.<yourdomain>` and set `CDN_BASE` to
it. Confirm the content types are right — `.svg` in particular, because 17 of
the 55 curated marks are SVG and a CDN serving them as `octet-stream` renders a
third of the Library as monograms. That exact bug was found in the local nginx
config.

---

## 3. API

Fly.io or Railway. The image is the repo's `Dockerfile` — multi-stage,
non-root (`USER node`), and it already builds both bundles.

```sh
fly launch --no-deploy
fly secrets set DATABASE_URL='postgres://...pooler...:6543/postgres'
fly secrets set CDN_BASE='https://cdn.yourdomain.com'
fly deploy
```

| Variable | Value | Notes |
|---|---|---|
| `DATABASE_URL` | pooled Supabase URL | **Absent means an empty in-memory catalogue with a warning, not a crash.** Check the logs on first boot. |
| `CDN_BASE` | `https://cdn.…` | Prefix for icon assets. |
| `PORT` | `8787` | |
| `PG_POOL` | `8` | Small on purpose; the CDN absorbs the reads. |

Do **not** set `staging`. Production reads the `published_*` tables. The flag
exists for tests.

```sh
curl -sf https://api.yourdomain.com/health          # {"ok":true}
curl -si  https://api.yourdomain.com/v1/featured | grep -i cache-control
```

Put a CDN in front of the API too. Every response is identical for every caller
— there is no user in any request — so a shared cache serves nearly all traffic
and the origin stays one small process. That is the capacity plan, not an
optimisation.

---

## 4. The weekly worker — GitHub Actions

Add repository secrets:

| Secret | Value |
|---|---|
| `DATABASE_URL` | **direct** Supabase URL (port 5432, not pooled — the worker uses transactions and advisory locks) |
| `SUPABASE_URL` | `https://<ref>.supabase.co` |
| `CDN_BUCKET` | `catalogue` |
| `CDN_TOKEN` | service-role key |
| `CDN_BASE` | `https://cdn.yourdomain.com` |

⚠ **`CDN_TOKEN` is a service-role key: it bypasses RLS and has unrestricted
access to the whole project.** As an Actions secret it is available to anything
that can trigger that workflow. Restrict who can push to `main` and who can
`workflow_dispatch`. If Supabase offers a storage-scoped key by the time you do
this, use that instead.

`.github/workflows/catalogue-sync.yml` already runs Mondays 03:00 UTC, with
`workflow_dispatch` and a `dry_run` input. It runs the publish-guard tests
*before* the sync, so a broken guard stops the run rather than riding along.

**First run:** trigger it by hand with `dry_run: true`, read the log, then run
it for real. Then check `sync_runs` — one row per stage, and the row that
explains a failure is the thing that makes an unattended job fixable:

```sql
select stage, started_at, fetched, added, changed, removed, error
  from sync_runs order by id desc limit 10;
```

The staging/published split means the API keeps serving the previous
publication for the entire duration of a sync, and only swaps at the end, in one
transaction. A mid-sync state is never visible.

**If a publish is refused** — the guard trips at >5% shrink — nothing changes and
the previous snapshot keeps serving. That is working correctly. Read `sync_runs`,
find out why the registry returned less, and re-run. Do not lower the threshold
to make it pass.

---

## 5. Desktop app — signing, notarization, updates

This is the step people underestimate.

1. Apple Developer Program, **$99/year**.
2. A *Developer ID Application* certificate in your keychain.
3. Notarization credentials as env vars:

```sh
export APPLE_ID='you@example.com'
export APPLE_APP_SPECIFIC_PASSWORD='xxxx-xxxx-xxxx-xxxx'
export APPLE_TEAM_ID='XXXXXXXXXX'
npm run dist:mac
```

4. Publish `release/*.dmg` **and `latest-mac.yml`** together. `electron-updater`
   reads the yml; without it beside the dmg, auto-update silently does nothing.
5. Insert the release into `app_releases` with `is_current = true` so
   `/v1/app/latest` can show release notes in-app.

⚠ **`appId` is `dev.bridge.app`.** macOS treats a change to it as a different
application: new permissions, new data directory, orphaned installs. Settle it
before the first signed build. It has already changed twice during renames, and
after you ship it is expensive.

Test on a machine that has never seen the app — a signing problem only shows up
on first launch somewhere else.

---

## 6. Order

Each step is useful on its own and nothing waits on step 5.

1. **Supabase + migrations.** Nothing else can start.
2. **Worker, by hand, `dry_run` then real.** Now the database has content.
3. **API + CDN.** Now there is something to point a client at.
4. **A desktop build against production**, unsigned, for yourself. Confirms the
   whole path before you spend money.
5. **Signing + notarization + auto-update.** Do it before you have users, not
   after — the first unsigned build you hand someone is an impression you cannot
   take back.
6. **Enable the cron.** Leave it manual until a full run has succeeded twice.

---

## Cost

| | Start | With real users |
|---|---|---|
| Supabase | $0 free tier | ~$25/mo |
| API host | $0–5 | ~$10–20/mo |
| CDN + storage | ~$0 | ~$5/mo |
| GitHub Actions | $0 | $0 |
| **Monthly** | **~$0–5** | **~$40–50** |
| Apple Developer | | **$99/year** |

---

## Still outstanding

Not blockers for deploying, but do not let them surprise you.

| | State |
|---|---|
| **OAuth (browser sign-in) servers** | Discoverable and testable, **not usable**. The design question is still open: token refresh needs a live process, so "Bridge must be running for OAuth servers" is a constraint you have to accept or design around. |
| **Credentials in the OS keychain** | Tokens are still written into AI-client config files in plaintext, exactly as they would be without Bridge. This is the oldest item on the list. |
| **Anonymous install count** | Undecided. §0. |
| **Windows and Linux** | Build from the same source, untested to the same standard. macOS is what ships. |
| **Deltas (`/v1/catalogue?since=`)** | Implemented and tested; unused. The snapshot is small enough that whole-file replacement is cheaper. Switch when the served set outgrows a plain download. |
