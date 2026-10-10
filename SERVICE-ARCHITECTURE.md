# Bridge — Service Architecture

*Companion to `ARCHITECTURE.md`, which covers the desktop app. This one covers
everything that runs on a server.*

Status: **plan, not built.** Nothing in here exists yet. Written against what
the app actually does today, so the gaps are real gaps.

---

## 0. The one line that decides everything else

There are two very different things a server could hold, and collapsing them is
the mistake that would kill this product:

| | Example | Where it may live |
|---|---|---|
| **Catalogue data** | which MCP servers exist, who publishes them, their icons, categories, pricing | anywhere — it is public information about third parties |
| **User data** | the trace of every tool call, policy rules, access tokens, which servers you connected | **the user's machine, only, forever** |

Bridge's entire pitch is that it shows you what your AI is doing *without*
becoming another thing that watches you. The marketing site says so in four
places. So the rule is:

> **Catalogue data flows down. User data never flows up.**

Every design below follows from that. A server that only ships catalogue data
down is not a compromise — it is a straight improvement, for the reason in §1.

---

## 1. A server makes the privacy story *stronger*, not weaker

This is counter-intuitive, so it is worth being concrete. Today, **every user's
machine** talks directly to:

- `registry.modelcontextprotocol.io` — paginated, up to 600 pages of 100 = the
  whole ~27,000-entry registry
- `api.npmjs.org` and `pypistats.org` — download counts, one call per package
- **every vendor's own domain** — favicon discovery: fetch the homepage, parse
  `<link rel="icon">`, probe up to eight candidate URLs

That means each install re-does work that has exactly one correct answer, and
in doing so tells npm, PyPI and dozens of vendors that a Bridge user exists.

Move it server-side and the client stops calling third parties altogether:

```
before   N users  ×  (27,000 registry rows + download stats + 55 favicon probes)
after    1 job    ×  (27,000 registry rows + download stats + 55 favicon probes)
         N users  ×  (one delta request to bridge.app)
```

The claim on the site changes from "makes no network calls of its own" to
something more accurate and more defensible: **"talks to one server, ours, and
sends it nothing about you."** Copy change needed — see §9.

---

## 2. The five components, and where each one lives

You listed five. Here they are with the hosting answer, which is what you asked
for:

| # | Component | Hosted? | Notes |
|---|---|---|---|
| 1 | **Desktop app** | **No — distributed as a file** | Signed `.dmg` on object storage or GitHub Releases. Needs a CDN, not a server. |
| 2 | **Catalogue API** | **Yes** | Read-only, cacheable, small. The only thing the app talks to. |
| 3 | **Catalogue DB** | **Yes** | Postgres. Holds public data about third parties, plus your editorial overlay. |
| 4 | **Weekly job** | **Yes, but not a running server** | A scheduled task, not a service. GitHub Actions cron is enough — see §6. |
| 5 | **Auth** | **Yes, managed** | Use a provider. Do not build this. And make it **optional** — see §7. |
| — | **User's trace, rules, tokens** | **Never** | Stays in local SQLite. This is the product. |

Two things worth adding that you did not list:

| # | Component | Hosted? | Why it matters |
|---|---|---|---|
| 6 | **Icon CDN** | Yes (object storage) | Resolve each vendor icon once centrally, serve the bytes. Kills the per-user favicon crawl. |
| 7 | **Update feed** | No — static files | `latest-mac.yml` + the `.dmg` next to it. `electron-updater` reads it. No server. |

---

## 3. The shape

```
┌──────────────────────────────────────────────────────────────────────┐
│  WEEKLY JOB  (scheduled, not a server)                               │
│  • pull the MCP registry            • probe vendor domains           │
│  • pull npm / PyPI download counts  • resolve + store icons          │
│  • diff against last run            • publish a new snapshot         │
└───────────────────────────┬──────────────────────────────────────────┘
                            │ writes
                    ┌───────▼────────┐        ┌──────────────────────┐
                    │  Postgres      │        │  Object storage/CDN  │
                    │  catalogue +   │        │  icons, snapshots,   │
                    │  editorial     │        │  app releases        │
                    └───────┬────────┘        └──────────┬───────────┘
                            │ reads                      │
                    ┌───────▼────────────────────────────▼───────────┐
                    │  CATALOGUE API   (read-mostly, cacheable)      │
                    │  /v1/catalogue?since=  /v1/search?q=           │
                    │  /v1/snapshot/latest   /v1/app/latest          │
                    └───────────────────┬───────────────────────────┘
                                        │ HTTPS, no user data in the request
   ┌────────────────────────────────────▼──────────────────────────────┐
   │  DESKTOP APP                                                      │
   │  local SQLite  ← merges deltas into `catalog`                     │
   │  local SQLite  ← trace, rules, tokens.  NEVER SENT.               │
   └───────────────────────────────────────────────────────────────────┘
```

**The API is a content channel, not a runtime dependency.** The app reads from
its own SQLite and works fully offline. If your server is down, the Library
still opens — it is just not learning about anything new. Never put a server
between a user and their own data.

---

## 4. Catalogue database

Postgres. The app's local SQLite schema is close enough to reuse the shapes.

```sql
-- Mirror of the public registry. Replaced wholesale by the job.
create table servers (
  key           text primary key,          -- 'io.github.foo/bar'
  namespace     text not null,
  title         text not null,
  description   text,
  version       text,
  repository_url text,
  website_url   text,
  status        text not null,
  packages      jsonb not null default '[]',
  remotes       jsonb not null default '[]',
  published_at  timestamptz,
  updated_at    timestamptz not null,
  downloads     integer,                    -- weekly, from npm/PyPI
  deleted_at    timestamptz                -- soft delete, so deltas can say "gone"
);
create index on servers (updated_at);

-- YOUR editorial layer. This is the actual moat: the registry has none of it.
create table curated (
  key            text primary key,
  is_first_party boolean not null default false,
  vendor_domain  text,                      -- what makes it first-party
  icon_url       text,
  icon_asset     text,                      -- path in object storage
  category       text,
  pricing_tier   text,
  evidence       text,                      -- 'mcp-oauth' | 'mcp-open' | 'manual'
  featured_rank  integer,
  notes          text,
  updated_at     timestamptz not null
);

-- Verification history, so "first-party" is a fact with a date on it.
create table probes (
  key         text not null,
  probed_at   timestamptz not null,
  endpoint    text not null,
  outcome     text not null,               -- 'ok' | 'auth-required' | 'refused' | 'timeout'
  detail      jsonb,
  primary key (key, probed_at)
);

-- Job audit. Without this you cannot answer "why did 4,000 entries vanish?"
create table sync_runs (
  id          bigserial primary key,
  started_at  timestamptz not null,
  finished_at timestamptz,
  source      text not null,               -- 'registry' | 'downloads' | 'probe' | 'icons'
  fetched     integer,
  added       integer,
  changed     integer,
  removed     integer,
  error       text
);
```

Note `deleted_at` and `updated_at`. Both exist purely so §5 can work.

---

## 5. The API

**Revised after review.** My first draft had the app pulling static snapshots
with no API server in step 1, and an API arriving later. That was wrong, but not
for the reason usually given.

The weak argument for an API on day one is "you will want ratings and teams
later". That is a reason to keep the *boundary* clean, not to run a server
before you need one.

The strong argument is that **server-side search cannot be a static file**, and
search is not a later feature — it is how anyone finds anything beyond the
curated 55. Once you are running an API for search, serving the catalogue
endpoints from it too costs nothing extra.

So: **API from day one.** The split that matters is not API-vs-static, it is:

| Kind of request | Served by | Why |
|---|---|---|
| Bulk data (snapshots, icons, `.dmg`) | **static files on the CDN** | large, identical for everyone, must be cheap |
| Queries (`/search`, `/catalogue?since=`) | **the API** | depend on the request |

Both live behind the same domain, so the app has one base URL and one thing to
trust. Read-only, no auth required, aggressively cacheable. Four endpoints to
start.

### `GET /v1/snapshot/latest`
A gzipped full snapshot of the curated set, for a fresh install. Served from the
CDN as a static file, not generated per request. `ETag` + `Cache-Control`.

### `GET /v1/catalogue?since=<cursor>&limit=500`
The delta feed. This is the answer to your question 4.

```json
{
  "cursor": "2026-09-14T00:00:00Z:04d1",
  "has_more": false,
  "changed": [ { "key": "...", "title": "...", "...": "..." } ],
  "removed": [ "io.github.dead/server" ]
}
```

The app stores the cursor in its existing `sync_state` table, sends it back next
time, and merges what comes down. Two properties matter:

- **Idempotent.** Replaying a delta twice is harmless, so a crashed merge just
  retries.
- **Soft deletes are explicit.** `removed` is a list, not an absence. An entry
  missing from a page must never mean "delete it" — that is how a truncated
  response wipes a user's catalogue.

### `GET /v1/search?q=<term>`
**Search stays on the server.** This is the biggest single win available.

Today the app downloads the entire ~27,000-entry registry to answer a search
locally, which is minutes of syncing and megabytes of local storage for data the
user will mostly never look at. You already decided against that once — *"I like
give official one first and then start pagination... on search fetch again which
is good idea rather then fetch all instantly."* This is that decision, finished:
ship the curated 55 with the app, serve everything else on demand.

### `GET /v1/app/latest`
Version, release notes, download URL, minimum supported version. Static JSON.
Separate from `electron-updater`'s own feed (§8) because the app also wants to
*show* "what's new" in the UI, not just silently update.

**Not in v1, deliberately:** any endpoint that accepts user data. No telemetry
ingest, no crash reporting with payloads, no "which servers do you use". Adding
one later is a decision to make in daylight, not something that creeps in.

---

## 6. The weekly job

**Do not run a server for this.** It runs for minutes, once a week, and needs no
availability. A GitHub Actions scheduled workflow is free, versioned with your
code, has logs and a manual re-run button, and can hold DB credentials as
secrets.

```yaml
# .github/workflows/catalogue-sync.yml
on:
  schedule: [{ cron: '0 3 * * 1' }]   # Mondays, 03:00 UTC
  workflow_dispatch: {}               # and on demand, when something breaks
```

Five stages, in order, each writing a `sync_runs` row:

1. **Registry pull** — paginate `registry.modelcontextprotocol.io`. The app
   already has this logic in `src/main/services/registry-sync.ts`; move it, do
   not rewrite it. It already handles the two bugs that cost real time: the
   page cap that truncated the catalogue alphabetically, and category inference
   being poisoned by the `io.github.*` namespace.
2. **Download counts** — npm and PyPI, batched.
3. **First-party probe** — for each curated endpoint, an `initialize` handshake
   against the vendor's own domain. Records `auth-required` as success, because
   an OAuth wall proves the endpoint is real. Writes `probes`.
4. **Icon resolution** — the discovery logic now in `src/main/services/icons.ts`
   and `favicon.ts`, run once centrally, bytes written to object storage.
5. **Publish** — write a new snapshot, bump the cursor, invalidate the CDN.

**Guard rail worth writing on day one:** if a run would remove more than ~5% of
the catalogue, abort and alert instead of publishing. A registry outage that
returns an empty page must not become a delta that empties 27,000 entries out of
every user's app. Deltas are the one thing here that can do real damage.

---

## 7. Auth — where I would push back

You have Google login at install, before the app is usable. I would not ship
that, for three reasons.

**1. It contradicts the product.** The site currently says, in four places: *"No
account, no telemetry"*, *"There is no sign-up and no analytics"*, *"No account ·
Nothing leaves your machine"*. For a tool whose pitch is *"I will show you what
your AI is doing without becoming another thing that watches you"*, a mandatory
account is the single most expensive thing you could put in front of the
download. Security-minded developers — exactly your early adopters — bounce.

**2. It buys the user nothing yet.** Ask what login *unlocks*. Right now: the
Library, which works better offline. That is a toll booth, not a feature.

**3. It buys you less than it looks like.** An email list of people who bounced
at a login screen is worth less than a smaller number who installed it, saw
their trace, and told someone.

**What I would do instead:**

- **Anonymous by default.** Install, open, works. No account.
- **An anonymous install id** — a random UUID in local settings, sent with the
  delta request only so you can count active installs and see version spread.
  No email, no machine fingerprint, no server list. Say so in Settings, with a
  switch to turn it off.
- **Account when it earns its place.** Sync your policy rules across two
  machines. Share a rule set with a team. A paid tier. *Then* login is a
  feature the user wants, and they will happily sign in.

If you do add Google auth — for those features or because you disagree — two
technical points that are easy to get wrong:

- **Desktop OAuth is not web OAuth.** Use the loopback redirect flow from RFC
  8252: open the user's real browser, listen on `127.0.0.1:<random>`, PKCE with
  S256, exchange the code in the main process. Never an embedded `BrowserWindow`
  webview — it is phishable, Google blocks it, and it trains users to type
  credentials into your app.
- **Store the refresh token in the OS keychain**, not in settings or a config
  file. You already owe the user this for MCP access tokens; do both at once.

---

## 8. "How does the user see a new update?" — two different questions

You have merged two things. They need different mechanisms.

### (a) New MCP servers in the catalogue

- The weekly job publishes a delta.
- The app pulls it on launch and on demand — never blocking the UI.
- The merge sets `first_seen_at` on genuinely new rows.
- The Library gets a **"New this week (12)"** filter and a small dot on the nav
  item. Not a push notification; nobody wants their laptop buzzing about a new
  MCP server.
- Because the app knows what it had before, "new" means *new to this user*,
  which is the honest version.

### (b) A new version of the app

- `electron-updater` against a static feed (`latest-mac.yml` + `.dmg` on the
  CDN). This is already half-wired: `electron-builder.yml` exists and produces
  a dmg.
- **This requires code signing and notarization.** An Apple Developer account
  is **$99/year**, non-optional. Without it: Gatekeeper warns on first launch,
  and auto-update does not work at all. Budget it now — it also affects the
  `appId` decision from the rename, because changing `appId` after you ship a
  signed build orphans installs.
- Show release notes in-app from `/v1/app/latest`, so an update is something the
  user understands rather than something that happens to them.

---

## 9. Stack recommendation

You mentioned AWS or Heroku. For one developer shipping this, both are more
operational work than you need. Two options, in order of how much I would
recommend them.

### Option A — Supabase (recommended to start)

| Need | Supabase gives you |
|---|---|
| Postgres | managed, with branching |
| API | auto-generated REST, or Edge Functions for the delta endpoint |
| Auth | Google OAuth, if and when you want it |
| Storage + CDN | icons, snapshots, releases |
| Cron | `pg_cron`, though I would still use GitHub Actions (§6) |

One dashboard, one bill, four boxes collapsed into one. Free tier covers you
until this has real users. It is also, pleasingly, already in your own curated
catalogue.

**The catch:** you are on their Postgres. Fine at this stage — migrating
Postgres later is a real but bounded job, and the alternative is spending your
first month on infrastructure instead of the product.

### Option B — assembled

- **Neon** for Postgres (HTTP driver, so serverless works)
- **Fly.io** or **Railway** for the API (Node + Fastify or Hono)
- **Cloudflare R2 + CDN** for icons, snapshots, releases
- **GitHub Actions** for the job
- **Clerk** or **WorkOS** for auth, if needed

More control, more moving parts, roughly the same money.

### Not AWS, not yet
AWS is the right answer at a scale you do not have, and the wrong answer at the
scale you do: IAM, VPCs, and CloudFormation are weeks you could spend on the
app. Nothing here locks you out of moving later.

### Rough monthly cost

| Item | Start | With real users |
|---|---|---|
| Postgres | $0 (free tier) | ~$25 |
| API hosting | $0–5 | ~$10–20 |
| Storage + CDN | ~$0 | ~$5 |
| Weekly job | $0 (Actions) | $0 |
| **Total** | **~$0–5/mo** | **~$40–50/mo** |
| Apple Developer | **$99/year** | required for signing |

---

## 10. Build order

Sequenced so each step ships something usable, and nothing is blocked on auth.

**1. Move the job off users' machines.** Postgres + the GitHub Actions job +
snapshots on the CDN, with the ~5%-shrink guard rail. The app keeps working
exactly as it does; it just pulls a snapshot instead of crawling the registry
itself. **Biggest win, least risk** — and no API server is needed *for this step
alone*, which makes it a safe first move even though the API lands in step 3.

**2. Icons centrally.** Resolve once in the job, serve from the CDN. Deletes a
whole class of per-user network traffic and makes every Library open instant on
a cold install.

**3. The API, with `/search` and `/app/latest`.** Plus `first_seen_at` on the
merge, which is all "new this week" actually needs — the delta endpoint can wait
until the served set outgrows a plain snapshot download (§12).

**4. Server-side search.** Stop shipping 27,000 rows to every client at all.
This is the step that forces the API, so steps 3 and 4 land together.

**5. Signing and notarization + auto-update.** Do this before you have users,
not after — the first unsigned build you hand someone is a bad first impression
you cannot take back.

**6. Auth — only when a feature needs it.** Rule sync across machines is the
obvious first one, and it is a genuine reason to sign in.

Note what is *not* in the list: nothing here requires an account, and nothing
sends user data up. That is on purpose, and it is worth keeping true for as long
as you can.

---

## 11. Copy that must change

If §1 lands, the marketing site is now wrong in three places. Fix these when the
API goes live, not before:

- `"Bridge makes no network calls of its own"` → `"Bridge talks to one server —
  ours — and tells it nothing about you."`
- `"No account, no telemetry"` → keep if you take the §7 advice. If you ship
  mandatory login, delete it, and rewrite the "Nowhere" section honestly.
- `"There is no sign-up and no analytics"` → same.

Getting caught overstating this would cost more than the feature is worth. The
honest version is still a very strong claim, and almost nobody else in this
space can make it.

---

## 12. Second review, and what changed

This plan has now had a second review. Most of it was confirmed. Three things
changed, and three things in the review I would not follow.

### Changed

1. **API from day one**, not snapshots-then-API. Reasoning rewritten in §5 —
   search forces it, and once the server exists the boundary is free.
2. **Deltas move after MVP.** Correct, but for a precise reason: a snapshot of
   the *curated* set is tiny, so re-downloading it whole is cheaper than a delta
   protocol. Deltas become necessary at the point the served set outgrows a
   plain download — roughly a few megabytes. Until then, snapshot-and-replace,
   and skip §5's `?since=` endpoint entirely.
3. **Monorepo**, one repo, pnpm workspaces. Layout in §13.

### Not followed

1. **"Skip the first-party probe."** This is the product. The reason to open
   Bridge's Library instead of the raw registry is that it tells you which
   Notion server Notion actually publishes — and that fact comes from probing
   `notion.com`, not from trusting a name. It is also already written and has
   already run for all 55 entries. Ship the verified set as data on day one;
   what can wait is *re-*verification on a cadence.
2. **"Skip the guard rail."** It does not disappear with deltas, it moves: the
   job must refuse to publish a snapshot that is more than ~5% smaller than the
   last one. A registry outage returning empty pages must not become a snapshot
   that empties every user's Library. Ten lines, and it is the only thing in
   this design that can destroy user-visible data.
3. **The MVP feature list, as written.** See below — this is the one that
   matters.

### The MVP list drops the moat

The reviewed MVP is: *library, search, categories, details, install, configure,
tokens, connect to clients, start/stop, local MCP, local logs, MCP updates, app
auto-update.*

Every one of those is the **installer** half of Bridge. Not one of them is the
**observability** half — and the observability half is what already exists and
what nothing else does:

| Already built | In that MVP list? |
|---|---|
| Live trace of every tool call, with arguments and results | no |
| Policy engine — allow / ask / deny, matched on tool, server, client, argument | no |
| Per-tool on/off that actually filters `tools/list` and refuses the call | no |
| Context-cost accounting per server and per tool | no |
| Prompt-injection scanning, including invisible Unicode | no |
| Secret redaction before anything is stored | no |
| Tool-definition change detection | no |

An MCP installer with a nice catalogue is the commodity half of this product and
it is already contested. The review itself warns against Bridge becoming "just
another MCP directory" — and then lists a feature set that is exactly that.

The correct MVP is not a subset of what exists. It is **what exists**, plus the
server that keeps the catalogue fresh. The trace and policy engine are done,
tested and shipping today; cutting them from the MVP would be cutting the reason
anyone would choose this.

---

## 13. Repository layout

One repo, pnpm workspaces. Broadly as reviewed, with two corrections.

```text
bridge/
├─ apps/
│  ├─ desktop/          # the Electron app as it stands today
│  └─ api/              # Fastify or Hono, read-mostly
├─ workers/
│  └─ catalogue-sync/   # the weekly job, run by GitHub Actions
├─ packages/
│  ├─ types/            # shared TS types — the catalogue shapes
│  ├─ api-client/       # generated-ish client the desktop app imports
│  └─ config/           # eslint, tsconfig bases
├─ infrastructure/
│  ├─ supabase/         # migrations, seed
│  └─ github-actions/
├─ pnpm-workspace.yaml
└─ package.json
```

**Correction 1: no shared `packages/database`.** The reviewed layout has one.
That is a trap: the server is Postgres and the client is SQLite, with different
dialects, different schemas and different lifecycles — the server holds a
registry mirror, the client holds a user's trace. Sharing *types* is right.
Sharing a database layer would force one schema to distort to fit the other.

**Correction 2: move `apps/desktop` last, not first** — done in that order, and
the reasoning held. The API and the worker shipped first while the app sat
untouched at the repo root; the move happened afterwards as one step, with 205
unit tests and 38 e2e checks as the safety net.

Five things needed re-pointing, and the tests found each one:

| What | Why it broke |
|---|---|
| `electron.vite.config.ts`, `vitest.config.ts` | `@bridge/*` aliases were `packages/*`, now `../../packages/*` |
| both app tsconfigs | same for `paths` and `include` |
| `composite: true` + `rootDir` | a composite project needs every included file under `rootDir`; including `../../packages` meant pointing it at the workspace root |
| the desktop `vitest.config.ts` | had no explicit `root`, so `include: ['src/test/**']` resolved against the invoking cwd and found nothing |
| `e2e/driver.js`, `e2e/catalogue.js` | `require(path.join(PROJ, 'node_modules', 'better-sqlite3'))` — npm hoists it to the workspace root, so a hardcoded project-relative path stops resolving the moment the app is not the repo root. Now a plain `require`, which walks up |

The root `package.json` is now a pure workspace root: no `main`, no app source,
and the desktop scripts delegate (`npm run build` → `--workspace
@bridge/desktop`) so anything already in muscle memory keeps working. Electron,
React and the builders are declared in `apps/desktop`; the toolchain —
TypeScript, vitest, eslint, tsx — stays at the root, because it is not the
desktop app's to own.

---

## 14. On "Registry / Control Plane / Runtime"

The review credits this framing to me. It is not mine — but it is good, and it
is worth stating correctly, because Bridge splits it in an unusual place:

```
REGISTRY            CONTROL PLANE          RUNTIME
what exists?        how is it configured?  what is running?
                                          
Postgres, remote    SQLite, local         proxy processes, local
catalogue, search   policies, tokens,     sessions, tool calls,
metadata            connections           health, logs
```

In most products all three tiers are server-side. In Bridge, **only the registry
is remote — the control plane and the runtime are both on the user's machine.**
That is not an implementation detail, it is the §0 boundary restated, and it is
the sentence to lead with when someone asks how Bridge is different from an MCP
directory.

---

## 15. Decisions I need from you

Three are now settled by the second review; two are still open.

**Settled:** anonymous-first, no mandatory login (both reviews agree).
Supabase to start. Curated set plus server-side search rather than shipping the
full 27,000-entry registry to every client.

**Still open:**

1. **Anonymous install count — yes or no?** One UUID in local settings, sent
   with the catalogue request, so you can see install count and version spread.
   Disclosed in Settings with an off switch. The second review says skip it; I
   would take it, because without it you cannot tell a launch that worked from
   one that did not. Your call — it is the only thing on this page that sends
   anything up, and the honest answer either way is a one-line copy change.

2. **Is the $99/year Apple Developer account in budget now?** It gates code
   signing, notarization and auto-update. Everything else here can be built
   without it, but the first unsigned `.dmg` you hand somebody is a Gatekeeper
   warning you cannot take back.

**And one I would settle before writing any code:** does the MVP include the
trace and policy engine, or not? §12 argues it must. If you agree, the MVP is
"what exists today, plus the catalogue server", and the build order in §10
stands unchanged.

---

## 16. What to produce next

The review asks for HLD, LLD, an ER diagram, an API specification and the
monorepo layout before coding. Three of those five are worth writing; two are
ceremony.

| Artefact | Status |
|---|---|
| **Postgres schema + migrations** | **Done** — `infrastructure/supabase/migrations/0001_catalogue.sql`, applied and tested. |
| **API specification** | **Done** — `apps/api/openapi.yaml`, with four tests that fail if it drifts from the code. |
| **Monorepo skeleton** | **Done** — npm workspaces, not pnpm; see §13 for why. |
| Separate HLD document | No — §0–§3 *is* the HLD. A second copy is a thing to keep in sync. |
| Separate LLD document | No — for a solo developer, the schema and the OpenAPI spec are the low-level design. Prose about them goes stale the first time you change a column. |

An ER diagram is worth having, but as a `mermaid` block inside the schema file
rather than a separate artefact — then it lives next to the DDL it describes and
gets updated in the same commit.

## 17. What real Postgres found

The schema and both query layers are now proven against Postgres 18 — PGlite
compiled to WASM, behind the wire protocol, so `postgres.js` connects to it
exactly as it would to Supabase. 42 integration tests.

This mattered more than expected. **Three bugs survived unit testing against a
fake and were found within minutes of the first real connection**, which is the
argument for doing this before rather than after picking a host.

**1. A duplicate key in a batch failed the whole statement.**
`ON CONFLICT DO UPDATE` cannot touch the same row twice in one statement — it
errors with *"cannot affect row a second time"*. The registry has returned the
same name twice across a page boundary, and batches are 500 rows. One duplicate
anywhere would fail the `registry` stage, which is critical, which aborts the
entire weekly run. Fixed with `DISTINCT ON` and an ordinal carried in the
payload so *last occurrence wins* is deterministic rather than planner-dependent.

**2. Change detection was unsound, and flaky.**
The upsert inferred *"did this row change?"* afterwards by testing
`updated_at = now()`. `now()` is the transaction timestamp, so an insert and a
re-upsert landing in the same clock tick made an **unchanged row look changed**.
It failed about one run in five. The consequence of believing it: every weekly
sync marks all 28,346 entries changed and pushes the whole catalogue into every
client's next delta — a technically correct result that is completely useless.

Fixed by removing the inference. A `classified` CTE decides against the
pre-statement snapshot, once, and that decision both sets `updated_at` and
reports the counts. 60 consecutive same-tick upserts, 0 wrong.

**3. Search pagination did nothing.**
`offset ${cursor ? 0 : 0}` — a no-op left in by hand. The endpoint handed out a
`nextCursor` and then ignored it, so page two returned page one. Worse, the
cursor encoded `updated_at|key` while search is ordered by *relevance*, so a
keyset cursor could not express a position in it at all.

Search now pages by offset, which is right here for the reason it is usually
wrong: the result set is small and nobody pages fifty deep into a search. The
offset is wrapped so it stays opaque and capped at 1000 so a hand-written cursor
cannot ask for a deep scan. Delta keeps its keyset cursor. `decodeCursor` and
`decodeOffset` refuse each other's format, and there is a test for that.

Two of the three were caught by tests written *before* the code — the duplicate
key and the same-tick upsert. The third existed because no test asked for page
two; there are now three, one against Postgres and two against the memory
repository, because the two implementations paging differently would make the
route tests prove nothing about production.
