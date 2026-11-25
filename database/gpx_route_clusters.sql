-- Phase 12A global external-GPX deduplication and route-family lineage.
-- REVIEWED MANUAL-DEPLOYMENT ARTIFACT. DO NOT EXECUTE AUTOMATICALLY.
-- Depends on gpx_source_tracks.sql. Clusters cross sources and import runs so
-- provenance survives canonicalization and later source refreshes.

begin;

create table public.gpx_route_clusters (
  id uuid primary key default gen_random_uuid(),
  canonical_track_id uuid not null references public.gpx_source_tracks(id) on delete restrict,
  cluster_fingerprint text not null unique check (cluster_fingerprint ~ '^[0-9a-f]{64}$'),
  clustering_version text not null check (char_length(clustering_version) between 1 and 100),
  cluster_status text not null default 'ACTIVE'
    check (cluster_status in ('ACTIVE','MERGED','WITHDRAWN')),
  route_family_semantic text not null default 'UNCLASSIFIED',
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create table public.gpx_route_cluster_members (
  cluster_id uuid not null references public.gpx_route_clusters(id) on delete cascade,
  track_id uuid not null references public.gpx_source_tracks(id) on delete restrict,
  relationship_to_canonical text not null
    check (relationship_to_canonical in (
      'CANONICAL','RAW_DUPLICATE','GEOMETRY_DUPLICATE','REVERSED_DUPLICATE',
      'NEAR_DUPLICATE','ROUTE_FAMILY_MEMBER'
    )),
  deduplication_level text not null
    check (deduplication_level in (
      'RAW_HASH','NORMALIZED_GEOMETRY','REVERSED_GEOMETRY',
      'NEAR_DUPLICATE','ROUTE_FAMILY'
    )),
  similarity_metrics jsonb not null check (jsonb_typeof(similarity_metrics) = 'object'),
  similarity_confidence numeric(5,4) check (similarity_confidence between 0 and 1),
  created_at timestamptz not null default clock_timestamp(),
  primary key (cluster_id, track_id)
);

create unique index gpx_route_cluster_membership_unique
  on public.gpx_route_cluster_members (track_id);
create unique index gpx_route_cluster_canonical_member_unique
  on public.gpx_route_cluster_members (cluster_id)
  where relationship_to_canonical = 'CANONICAL';

alter table public.gpx_route_clusters enable row level security;
alter table public.gpx_route_cluster_members enable row level security;
revoke all on public.gpx_route_clusters from public, anon, authenticated;
revoke all on public.gpx_route_cluster_members from public, anon, authenticated;
grant select, insert, update on public.gpx_route_clusters to service_role;
grant select, insert, update, delete on public.gpx_route_cluster_members to service_role;

comment on table public.gpx_route_clusters is
  'Global canonical route clusters. Duplicate source tracks remain as immutable '
  'provenance-bearing members rather than being deleted.';

commit;

