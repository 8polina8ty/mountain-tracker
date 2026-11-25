-- Phase 12A external source-track staging contract.
-- REVIEWED MANUAL-DEPLOYMENT ARTIFACT. DO NOT EXECUTE AUTOMATICALLY.
-- Depends on gpx_source_registry.sql and gpx_import_runs.sql.
-- This table is not gps_activities and has no user_id or fake ownership.

begin;

create table public.gpx_source_tracks (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.gpx_source_registry(id) on delete restrict,
  import_run_id uuid not null references public.gpx_import_runs(id) on delete restrict,
  source_snapshot_key text not null check (char_length(source_snapshot_key) between 1 and 200),
  source_native_id text not null check (char_length(source_native_id) between 1 and 500),
  canonical_source_record_key text not null check (char_length(canonical_source_record_key) <= 200),
  source_url text not null check (
    source_url ~ '^https?://'
    and source_url !~ '^https?://[^/]*@'
    and char_length(source_url) <= 1000
  ),
  download_url text check (
    download_url is null
    or (
      download_url ~ '^https?://'
      and download_url !~ '^https?://[^/]*@'
      and char_length(download_url) <= 2000
    )
  ),
  retrieved_at timestamptz,
  source_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(source_metadata) = 'object'),

  raw_content_hash text check (raw_content_hash is null or raw_content_hash ~ '^[0-9a-f]{64}$'),
  source_record_hash text check (source_record_hash is null or source_record_hash ~ '^[0-9a-f]{64}$'),
  record_idempotency_key text not null unique check (record_idempotency_key ~ '^[0-9a-f]{64}$'),
  raw_storage_path text check (raw_storage_path is null or raw_storage_path ~ '^sources/[a-z0-9._-]+/[0-9a-f-]+/raw\.gpx$'),

  geometry_geojson jsonb,
  normalized_geometry_hash text
    check (normalized_geometry_hash is null or normalized_geometry_hash ~ '^[0-9a-f]{64}$'),
  direction_neutral_geometry_hash text
    check (direction_neutral_geometry_hash is null or direction_neutral_geometry_hash ~ '^[0-9a-f]{64}$'),
  point_count integer check (point_count is null or point_count between 2 and 250000),
  distance_m double precision check (distance_m is null or distance_m >= 0),
  elevation_gain_m double precision check (elevation_gain_m is null or elevation_gain_m >= 0),
  minimum_elevation_m double precision,
  maximum_elevation_m double precision,
  started_at timestamptz,
  finished_at timestamptz,
  bounding_box jsonb check (bounding_box is null or jsonb_typeof(bounding_box) = 'object'),
  start_coordinate jsonb check (start_coordinate is null or jsonb_typeof(start_coordinate) = 'array'),
  end_coordinate jsonb check (end_coordinate is null or jsonb_typeof(end_coordinate) = 'array'),

  processing_status text not null default 'DISCOVERED'
    check (processing_status in (
      'DISCOVERED','DOWNLOADED','PARSED','NORMALIZED','MATCHED','DEDUPLICATED',
      'QUALIFIED','REVIEW_REQUIRED','APPROVED','REJECTED','PROCESSING_FAILED',
      'PUBLISHED','WITHDRAWN'
    )),
  quality_status text not null default 'PENDING'
    check (quality_status in ('PENDING','PASSED','REVIEW_REQUIRED','REJECTED')),
  publication_status text not null default 'NOT_EVALUATED'
    check (publication_status in ('NOT_EVALUATED','WITHHELD','ELIGIBLE','PUBLISHED','WITHDRAWN')),
  mountain_match_outcome text
    check (mountain_match_outcome is null or mountain_match_outcome in ('DIRECT','AMBIGUOUS','NO_SUMMIT')),
  route_semantic text not null default 'UNCLASSIFIED'
    check (route_semantic in (
      'SUMMIT_ASCENT','SUMMIT_DESCENT','OUT_AND_BACK','LOOP','TRAVERSE',
      'MULTI_SUMMIT','RIDGE_ROUTE','PASSING_NEAR_SUMMIT',
      'NOT_MOUNTAIN_ROUTE','UNCLASSIFIED'
    )),
  start_context text not null default 'UNCLASSIFIED'
    check (start_context in (
      'BASE_START','HUT_START','HIGH_MOUNTAIN_START','AMBIGUOUS_START','UNCLASSIFIED'
    )),
  privacy_status text not null default 'PENDING'
    check (privacy_status in ('PENDING','SANITIZED','REVIEW_REQUIRED','REJECTED')),
  quality_flags jsonb not null default '[]'::jsonb check (jsonb_typeof(quality_flags) = 'array'),
  processing_error jsonb check (processing_error is null or jsonb_typeof(processing_error) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),

  unique (source_id, source_snapshot_key, source_native_id),
  check (minimum_elevation_m is null or maximum_elevation_m is null or minimum_elevation_m <= maximum_elevation_m),
  check (started_at is null or finished_at is null or started_at <= finished_at),
  check (
    geometry_geojson is null
    or (
      jsonb_typeof(geometry_geojson) = 'object'
      and geometry_geojson ->> 'type' in ('LineString','MultiLineString')
    )
  ),
  check (
    publication_status <> 'ELIGIBLE'
    or (
      processing_status in ('APPROVED','PUBLISHED')
      and quality_status = 'PASSED'
      and privacy_status = 'SANITIZED'
    )
  )
);

create index gpx_source_tracks_resume_idx
  on public.gpx_source_tracks (import_run_id, processing_status, id);
create index gpx_source_tracks_raw_hash_idx
  on public.gpx_source_tracks (raw_content_hash) where raw_content_hash is not null;
create index gpx_source_tracks_geometry_hash_idx
  on public.gpx_source_tracks (normalized_geometry_hash) where normalized_geometry_hash is not null;
create index gpx_source_tracks_direction_hash_idx
  on public.gpx_source_tracks (direction_neutral_geometry_hash)
  where direction_neutral_geometry_hash is not null;

alter table public.gpx_source_tracks enable row level security;
revoke all on public.gpx_source_tracks from public, anon, authenticated;
grant select, insert, update on public.gpx_source_tracks to service_role;

comment on table public.gpx_source_tracks is
  'Service-only external GPX staging with source-native identity, two geometry '
  'identity levels, resumable status, quality, privacy, and publication gates.';

commit;
