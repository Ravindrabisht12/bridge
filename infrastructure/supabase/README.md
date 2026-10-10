# Catalogue database

Postgres. Public data about third-party MCP servers, plus our own editorial
judgements about them. **Nothing about any user** — no traces, no policies, no
tokens, no record of what anyone installed. See `SERVICE-ARCHITECTURE.md` §0.

## Entity relationships

```mermaid
erDiagram
    registry_servers ||--o| curated : "curated by key"
    registry_servers ||--o{ probes  : "verified by"
    snapshots        }o--|| registry_servers : "exports"

    registry_servers {
        text        key PK "reverse-DNS registry name"
        text        namespace
        text        title
        text        description
        text        version
        text        status
        jsonb       packages "local execution"
        jsonb       remotes  "hosted endpoints"
        integer     downloads "weekly, npm or PyPI"
        timestamptz source_updated_at "registry's clock"
        timestamptz updated_at "OURS — the delta cursor key"
        timestamptz deleted_at "soft delete, so deltas can say gone"
        tsvector    search_tsv "weighted: title A, namespace B, desc C"
    }

    curated {
        text        key PK_FK
        boolean     is_first_party "requires vendor_domain AND evidence"
        text        vendor_domain "the domain that proves it"
        text        icon_asset "path on OUR cdn"
        text        category
        text        pricing_tier "free|freemium|paid|unknown"
        text        evidence "mcp-oauth|mcp-open|manual|unverified"
        integer     featured_rank
        timestamptz verified_at
    }

    probes {
        bigserial   id PK
        text        key FK
        text        endpoint
        text        outcome "ok|auth-required|refused|timeout|error"
        jsonb       detail
        timestamptz probed_at
    }

    snapshots {
        text        digest PK "content addressed"
        text        url
        integer     entry_count
        text        cursor "first delta after this snapshot"
        boolean     is_current "unique partial index"
    }

    sync_runs {
        bigserial   id PK
        text        stage "registry|downloads|probe|icons|publish"
        integer     fetched
        integer     added
        integer     changed
        integer     removed
        text        error
    }

    app_releases {
        text        version PK
        text        minimum_supported
        jsonb       downloads "per platform, with sha512"
        boolean     is_current "unique partial index"
    }
```

## Why the split between `registry_servers` and `curated`

The worker owns `registry_servers` and replaces rows freely. Humans own
`curated`. If they shared a table, every weekly sync would have to be careful
not to overwrite a judgement — and one day it would not be careful enough.

Two constraints on `curated` are load-bearing rather than decorative:

- `curated_first_party_needs_domain` — you cannot mark something first-party
  without naming the domain that makes it so.
- `curated_first_party_needs_evidence` — you cannot mark something first-party
  while its evidence is `unverified`. A verified seal with no probe behind it is
  the one piece of bad data that would actively mislead a user, so the database
  refuses it rather than trusting the code above it.

## Why `updated_at` is ours, not the registry's

Deltas answer "what changed since cursor X". If that used the registry's own
timestamp, an edit to `curated` — a new category, a new icon, a first-party
verification — would never reach a client, because the registry's clock did not
move. So `catalogue_entries.updated_at` is `greatest(registry, curated)`.

## Proven against real Postgres

The schema is not hypothetical. `@bridge/pgtest` boots PGlite — Postgres 18
compiled to WASM — behind the wire protocol, so `postgres.js` connects to it
exactly as it would to Supabase. Every migration is replayed and both query
layers run against it:

```sh
npm run test:api      # 23 integration tests, incl. the view and the constraints
npm run test:worker   # 19 integration tests, incl. the upsert and soft deletes
```

Applying it for the first time found three bugs that no amount of unit testing
against a fake would have caught. They are recorded in `SERVICE-ARCHITECTURE.md`
§17.

## Applying migrations

```sh
supabase db push                       # against a linked project
supabase db reset                      # local, replays every migration
psql "$DATABASE_URL" -f infrastructure/supabase/migrations/0001_catalogue.sql
```

Migrations are append-only and numbered. Never edit one that has been applied to
an environment you do not own — write `0002_...` instead.
