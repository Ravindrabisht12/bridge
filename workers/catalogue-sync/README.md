# catalogue-sync

The weekly job. Not a server: it runs for minutes once a week and needs no
availability, so GitHub Actions schedules it (`.github/workflows/catalogue-sync.yml`).

```sh
npm run sync                       # needs DATABASE_URL
DRY_RUN=true npm run sync          # every stage, refuses to publish
npm run test:worker
```

## Five stages

| Stage | Does | Failure |
|---|---|---|
| `registry` | paginate registry.modelcontextprotocol.io | **aborts the run** — nothing to publish |
| `downloads` | npm + PyPI weekly counts | degrades; a missing number is a missing number |
| `probe` | `initialize` handshake against each vendor's own domain | degrades; `verified_at` just goes stale |
| `icons` | favicon discovery, bytes to object storage | degrades; a missing icon is a monogram |
| `publish` | snapshot + cursor + CDN invalidation | **aborts the run** |

Only `registry` and `publish` are critical. An icon timeout must not cost a week
of catalogue updates — `shouldAbort()` encodes that, and it is tested.

## The guard

`guard.ts` is the most important file here and the smallest.

A snapshot is the only artefact in this system that can destroy something a user
can see. If the registry has an outage and answers a page with `[]`, a naive job
records "0 entries", publishes, and every desktop app replaces a working library
with nothing.

So the publish step can refuse:

- **0 entries — never**, whatever the previous count was.
- **Shrank more than 5%** — refuse and report. That is not a sync, it is an
  incident.
- **Under 20 entries** — judged absolutely, not proportionally. Losing 1 of 10
  is 10% and probably fine; losing 9 of 10 is not, and the curated set lives in
  exactly this range.
- **First publish** — allowed, or the job could never bootstrap.

Ten tests, including the boundary either side of the limit. The CI workflow runs
them *before* the sync, so a broken guard stops the run rather than riding along
with it.

## Verified against the real registry

`DRY_RUN=true FULL=true npm run sync` runs every stage against
registry.modelcontextprotocol.io with an in-memory store and no writes:

```
registry   28346 fetched, +28346 ~0 -0     ~3m40s
downloads   2000 fetched, +0 ~127 -0
probe          0 fetched, +0 ~0 -0         (nothing curated in memory)
publish    28346 fetched                   3.8 MB gzipped snapshot
```

That first real run found three places where `MemoryStore` did not mean the
same thing as the SQL — which matters, because every test in here runs against
the memory store, so a divergence makes the tests worthless:

1. **`probeTargets` was not curated-only.** Postgres joins `curated`; the memory
   store returned every row with a remote, so a dry run would have probed
   28,000 third-party endpoints. Wrong, and rude.
2. **One malformed `url` failed the whole stage.** `new URL()` on registry data
   was unguarded. A registry entry can carry anything.
3. **`downloadTargets` ignored `registryType` and only looked at the first
   package.** The SQL filters to npm and PyPI; the memory store spent 2,000
   requests on `oci` and `mcpb` identifiers that publish no counts.

All three are fixed and each has a test named after what exposed it.

## The icon stage

Discovery is `@bridge/favicon` — the same ranked search the desktop app used,
extracted rather than rewritten: conventional paths, the page's own
`<link rel="icon">` tags and its web manifest, ranked largest-first with real
PNG width read from the IHDR chunk.

A plain `GET /favicon.ico` is not a substitute, and was tried. Replicate answers
404 there, Windsurf's `apple-touch-icon` path serves HTML, and where it does
exist it is usually 16px — a blur in a 46px slot. `.ico` is therefore held back
as an explicit fallback rather than ranked last: it is nearly always tiny, but
it is also the only thing some vendors publish, and capping the attempt list
without separating the two lost Canva, MongoDB and Asana entirely.

Objects are content-addressed, so two vendors sharing a mark share one file and
re-resolving identical bytes is a no-op. Resolving one does bump
`curated.updated_at`, because a new icon is a curation edit and has to reach
clients.

Two bugs already fixed in the ported code that a clean-room version would
reintroduce:

- a page cap that silently truncated the catalogue alphabetically, so
  `io.github.*` — most of the real servers — never arrived. `crawl()` now
  **throws** rather than returning a short result;
- category inference reading the namespace, where every `io.github.*` entry
  contains the word "github" and `dev` swallowed 18,528 of 27,213 entries.
