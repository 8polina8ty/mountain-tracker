-- Phase 12A external GPX source/provenance registry.
-- REVIEWED MANUAL-DEPLOYMENT ARTIFACT. DO NOT EXECUTE AUTOMATICALLY.
-- Creates zero source rows and performs zero publication writes.
--
-- Deployment order:
--   1. gpx_source_registry.sql
--   2. gpx_import_runs.sql
--   3. gpx_source_tracks.sql
--   4. gpx_track_mountain_associations.sql
--   5. gpx_route_clusters.sql
--   6. gpx_import_qa.sql

begin;

create extension if not exists pgcrypto with schema extensions;

create table public.gpx_source_registry (
  id uuid primary key default gen_random_uuid(),
  source_key text not null unique
    check (
      source_key ~ '^[a-z0-9]+([._-][a-z0-9]+)*$'
      and char_length(source_key) <= 100
    ),
  source_name text not null check (char_length(source_name) between 1 and 200),
  homepage_url text not null check (
    homepage_url ~ '^https?://'
    and homepage_url !~ '^https?://[^/]*@'
    and char_length(homepage_url) <= 1000
  ),
  geographic_scope text not null check (char_length(geographic_scope) between 1 and 500),
  access_method text not null
    check (access_method in ('API','BULK_DOWNLOAD','MANUAL_SNAPSHOT')),
  license_identifier text check (license_identifier is null or char_length(license_identifier) <= 200),
  license_url text check (
    license_url is null
    or (
      license_url ~ '^https?://'
      and license_url !~ '^https?://[^/]*@'
      and char_length(license_url) <= 1000
    )
  ),
  license_status text not null
    check (license_status in ('ALLOWED','REVIEW_REQUIRED','BLOCKED')),
  access_permission_status text not null
    check (access_permission_status in ('ALLOWED','REVIEW_REQUIRED','BLOCKED')),
  redistribution_permission_status text not null
    check (redistribution_permission_status in ('ALLOWED','REVIEW_REQUIRED','BLOCKED')),
  attribution_required boolean not null,
  attribution_text text check (attribution_text is null or char_length(attribution_text) <= 2000),
  source_url_retention_required boolean not null default true,
  source_url_retention_permission text not null
    check (source_url_retention_permission in ('ALLOWED','REVIEW_REQUIRED','BLOCKED')),
  raw_gpx_retention_permission text not null
    check (raw_gpx_retention_permission in ('ALLOWED','REVIEW_REQUIRED','BLOCKED')),
  normalized_geometry_publication_permission text not null
    check (normalized_geometry_publication_permission in ('ALLOWED','REVIEW_REQUIRED','BLOCKED')),
  source_policy_status text not null
    check (source_policy_status in ('ALLOWED','REVIEW_REQUIRED','BLOCKED')),
  policy_evidence jsonb not null check (jsonb_typeof(policy_evidence) = 'object'),
  last_verified_at timestamptz not null,
  reviewed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (not attribution_required or nullif(btrim(attribution_text), '') is not null),
  check (
    source_policy_status <> 'ALLOWED'
    or (
      license_status = 'ALLOWED'
      and access_permission_status = 'ALLOWED'
      and redistribution_permission_status = 'ALLOWED'
      and source_url_retention_permission = 'ALLOWED'
      and normalized_geometry_publication_permission = 'ALLOWED'
    )
  )
);

create index gpx_source_registry_policy_idx
  on public.gpx_source_registry (source_policy_status, last_verified_at);

alter table public.gpx_source_registry enable row level security;
revoke all on public.gpx_source_registry from public, anon, authenticated;
grant select, insert, update on public.gpx_source_registry to service_role;

comment on table public.gpx_source_registry is
  'Service-only Phase 12 registry. Downloadable does not imply redistributable; '
  'only explicit ALLOWED source policies may enter ingestion.';

commit;
