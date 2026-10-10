-- Worker tables are staging. Public reads only change when publication commits.
create table if not exists published_registry_servers (like registry_servers including all);
create table if not exists published_curated (like curated including all);
create or replace view published_catalogue_entries as
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
from published_registry_servers r
left join published_curated c on c.key = r.key
where r.deleted_at is null;
