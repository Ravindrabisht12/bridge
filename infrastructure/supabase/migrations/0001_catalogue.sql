-- =========================================================================
-- Bridge catalogue — initial schema
--
-- This database holds PUBLIC information about third-party MCP servers, plus
-- our own editorial judgements about them. It holds nothing about any user:
-- no traces, no policies, no tokens, no list of what anyone installed. That
-- boundary is the product, not a preference — see SERVICE-ARCHITECTURE.md §0.
--
-- Anything added here later that names a person needs a deliberate decision,
-- not a migration.
-- =========================================================================

-- ------------------------------------------------------------------ registry
-- A mirror of registry.modelcontextprotocol.io. Owned entirely by the weekly
-- worker: rows are upserted, never edited by hand. Anything a human decides
-- goes in `curated` so a re-sync cannot overwrite it.
create table if not exists registry_servers (
  key             text primary key,
  namespace       text,
  title           text not null,
  description     text not null default '',
  version         text,
  repository_url  text,
  website_url     text,
  status          text not null default 'active',

  packages        jsonb not null default '[]'::jsonb,
  remotes         jsonb not null default '[]'::jsonb,

  downloads       integer,
  downloads_source text check (downloads_source in ('npm', 'pypi')),

  published_at    timestamptz,
  -- The registry's own updated_at, not ours. Used to skip unchanged rows.
  source_updated_at timestamptz,

  -- Ours. Bumped whenever any served field changes, which is what makes the
  -- delta cursor correct: a client asking "what changed since X" is asking
  -- about this column, not about the registry's clock.
  updated_at      timestamptz not null default now(),
  -- Soft delete. A delta has to be able to say "this one is gone" explicitly.
  deleted_at      timestamptz,

  -- Full-text search vector, maintained by trigger below.
  search_tsv      tsvector
);

-- Deltas scan by our updated_at; every other read filters live rows first.
create index if not exists registry_servers_updated_at_idx
  on registry_servers (updated_at) where deleted_at is null;
create index if not exists registry_servers_namespace_idx
  on registry_servers (namespace) where deleted_at is null;
create index if not exists registry_servers_search_idx
  on registry_servers using gin (search_tsv);
-- Substring search on the local name, for the "notion" case where a user types
-- part of a name rather than a word. pg_trgm makes ILIKE '%x%' indexable.
create extension if not exists pg_trgm;
create index if not exists registry_servers_title_trgm_idx
  on registry_servers using gin (title gin_trgm_ops);

-- ------------------------------------------------------------------- curated
-- The editorial layer. This is the actual moat: the registry publishes no
-- popularity signal, no categories, no pricing and no notion of who really
-- owns a server. Separate table so a registry re-sync is free to replace a
-- row above without touching a judgement here.
create table if not exists curated (
  key             text primary key,
  is_first_party  boolean not null default false,
  -- The domain that makes it first-party. Null whenever is_first_party is
  -- false; the check below keeps the two from drifting apart.
  vendor_domain   text,
  icon_domain     text,
  icon_url        text,
  -- Path in object storage once resolved. Served from our CDN, never a
  -- vendor's host, so browsing the library beacons nobody.
  icon_asset      text,
  category        text,
  pricing_tier    text not null default 'unknown'
                    check (pricing_tier in ('free', 'freemium', 'paid', 'unknown')),
  evidence        text not null default 'unverified'
                    check (evidence in ('mcp-oauth', 'mcp-open', 'manual', 'unverified')),
  featured_rank   integer,
  notes           text,
  verified_at     timestamptz,
  updated_at      timestamptz not null default now(),

  constraint curated_first_party_needs_domain
    check (not is_first_party or vendor_domain is not null),
  -- A seal with no probe behind it is the one thing this table must not allow.
  constraint curated_first_party_needs_evidence
    check (not is_first_party or evidence <> 'unverified')
);

create index if not exists curated_featured_idx
  on curated (featured_rank) where featured_rank is not null;
create index if not exists curated_first_party_idx
  on curated (is_first_party) where is_first_party;

-- -------------------------------------------------------------------- probes
-- Verification history. "First-party" is a claim with a date on it, and this
-- is where the date comes from. Append-only.
create table if not exists probes (
  id          bigserial primary key,
  key         text not null,
  endpoint    text not null,
  outcome     text not null
                check (outcome in ('ok', 'auth-required', 'refused', 'timeout', 'error')),
  detail      jsonb,
  probed_at   timestamptz not null default now()
);
create index if not exists probes_key_probed_at_idx on probes (key, probed_at desc);

-- ----------------------------------------------------------------- snapshots
-- Published bulk exports. A row per publish, so a bad snapshot can be rolled
-- back by pointing `is_current` at the previous one rather than regenerating.
create table if not exists snapshots (
  digest        text primary key,
  url           text not null,
  bytes         bigint not null,
  entry_count   integer not null,
  cursor        text not null,
  generated_at  timestamptz not null default now(),
  is_current    boolean not null default false
);
-- Exactly one current snapshot, enforced rather than remembered.
create unique index if not exists snapshots_one_current_idx
  on snapshots (is_current) where is_current;

-- ----------------------------------------------------------------- sync_runs
-- Job audit. Without this you cannot answer "why did 4,000 entries vanish?",
-- which is the question you will eventually have to answer.
create table if not exists sync_runs (
  id           bigserial primary key,
  stage        text not null
                 check (stage in ('registry', 'downloads', 'probe', 'icons', 'publish')),
  started_at   timestamptz not null,
  finished_at  timestamptz,
  fetched      integer not null default 0,
  added        integer not null default 0,
  changed      integer not null default 0,
  removed      integer not null default 0,
  error        text
);
create index if not exists sync_runs_started_at_idx on sync_runs (started_at desc);

-- ---------------------------------------------------------------- sync_state
-- The worker's own bookkeeping: last incremental cursor, previous published
-- entry count, current snapshot cursor. Small and opaque on purpose — anything
-- worth querying belongs in a real column, not a key-value bag.
create table if not exists sync_state (
  key   text primary key,
  value text not null
);

-- ------------------------------------------------------------ app_releases
-- Desktop builds. Separate from electron-updater's own feed: that one is a
-- static file the updater reads, this one is what the app shows a human.
create table if not exists app_releases (
  version           text primary key,
  notes             text,
  notes_url         text,
  minimum_supported text not null,
  published_at      timestamptz not null default now(),
  downloads         jsonb not null default '[]'::jsonb,
  is_current        boolean not null default false
);
create unique index if not exists app_releases_one_current_idx
  on app_releases (is_current) where is_current;

-- =========================================================================
-- Search vector
--
-- Weighted so a name match beats a description match: someone typing "notion"
-- wants Notion, not the forty servers whose description mentions it.
-- =========================================================================
create or replace function registry_servers_search_refresh() returns trigger as $$
begin
  new.search_tsv :=
      setweight(to_tsvector('simple', coalesce(new.title, '')), 'A')
   || setweight(to_tsvector('simple', coalesce(new.namespace, '')), 'B')
   || setweight(to_tsvector('english', coalesce(new.description, '')), 'C');
  return new;
end
$$ language plpgsql;

drop trigger if exists registry_servers_search_tsv on registry_servers;
create trigger registry_servers_search_tsv
  before insert or update of title, namespace, description
  on registry_servers
  for each row execute function registry_servers_search_refresh();

-- =========================================================================
-- The served view
--
-- One place where the registry mirror and the editorial layer are joined, so
-- the API cannot accidentally serve an entry without its curation — and so
-- the column aliases live in SQL rather than being retyped in TypeScript.
--
-- Columns are aliased explicitly. `select r.*, c.*` was a real bug in the
-- desktop app: duplicate `key` and `updated_at` meant a missing overlay row
-- nulled the entry's own key. Two e2e checks still pin that.
-- =========================================================================
create or replace view catalogue_entries as
select
  r.key,
  r.namespace,
  r.title,
  r.description,
  r.version,
  r.repository_url,
  r.website_url,
  r.status,
  r.packages,
  r.remotes,
  r.downloads,
  r.downloads_source,
  r.published_at,
  -- The served updated_at is the later of the two, so a curation edit alone is
  -- enough to push an entry into the next delta.
  greatest(r.updated_at, coalesce(c.updated_at, r.updated_at)) as updated_at,
  coalesce(c.is_first_party, false) as is_first_party,
  c.vendor_domain,
  c.icon_url,
  c.icon_asset,
  c.category,
  coalesce(c.pricing_tier, 'unknown') as pricing_tier,
  coalesce(c.evidence, 'unverified') as evidence,
  c.featured_rank,
  c.verified_at
from registry_servers r
left join curated c on c.key = r.key
where r.deleted_at is null;
