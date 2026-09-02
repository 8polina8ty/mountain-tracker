-- Phase 8 OSM route staging schema.
-- REVIEW AND APPLY MANUALLY. This file is not a production-route migration and
-- deliberately contains no promotion path into public.mountain_routes.

create table if not exists public.osm_route_import_staging (
  id uuid primary key default gen_random_uuid(),
  contract_version text not null,
  idempotency_key text not null unique,
  provider text not null check (provider = 'openstreetmap'),
  source_relation_id text not null,
  canonical_source_id text not null,
  dataset_version text not null,
  payload_hash text not null,
  route_name text,
  semantic_type text not null,
  quality_score double precision not null check (quality_score between 0 and 100),
  geometry_geojson jsonb not null,
  distance_meters double precision not null check (distance_meters > 0),
  matched_primary_mountain_id bigint references public.mountains(id) on delete restrict,
  audit_flags jsonb not null default '[]'::jsonb,
  import_eligibility text not null check (import_eligibility = 'AUTO_IMPORT_READY'),
  payload jsonb not null,
  staged_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, canonical_source_id, contract_version),
  check (source_relation_id = canonical_source_id),
  check (jsonb_typeof(geometry_geojson) = 'object'),
  check (jsonb_typeof(audit_flags) = 'array'),
  check (jsonb_typeof(payload) = 'object')
);

create table if not exists public.osm_route_import_summit_staging (
  id uuid primary key default gen_random_uuid(),
  staging_route_id uuid not null references public.osm_route_import_staging(id) on delete cascade,
  peak_osm_id text not null,
  mountain_id bigint not null references public.mountains(id) on delete restrict,
  mountain_match_classification text not null
    check (mountain_match_classification = 'EXACT_MOUNTAIN_MATCH'),
  final_association text not null check (final_association = 'CONFIRMED'),
  final_confidence double precision not null check (final_confidence between 0 and 1),
  minimum_geometry_distance_meters double precision not null,
  endpoint_distance_meters double precision not null,
  evidence jsonb not null default '[]'::jsonb,
  payload jsonb not null,
  unique (staging_route_id, peak_osm_id),
  check (jsonb_typeof(evidence) = 'array'),
  check (jsonb_typeof(payload) = 'object')
);

create index if not exists osm_route_import_staging_source_relation_idx
  on public.osm_route_import_staging (source_relation_id);

create index if not exists osm_route_import_summit_staging_mountain_idx
  on public.osm_route_import_summit_staging (mountain_id);

-- Route and summit replacement is one database transaction. A changed payload
-- cannot leave a route with deleted, partial, or stale summit associations.
create or replace function public.stage_osm_route_import(
  p_route jsonb,
  p_summits jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_route_id uuid;
begin
  if jsonb_typeof(p_route) <> 'object' then
    raise exception 'p_route must be a JSON object';
  end if;
  if jsonb_typeof(p_summits) <> 'array' or jsonb_array_length(p_summits) = 0 then
    raise exception 'p_summits must be a non-empty JSON array';
  end if;

  insert into public.osm_route_import_staging (
    contract_version,
    idempotency_key,
    provider,
    source_relation_id,
    canonical_source_id,
    dataset_version,
    payload_hash,
    route_name,
    semantic_type,
    quality_score,
    geometry_geojson,
    distance_meters,
    matched_primary_mountain_id,
    audit_flags,
    import_eligibility,
    payload
  ) values (
    p_route ->> 'contract_version',
    p_route ->> 'idempotency_key',
    p_route ->> 'provider',
    p_route ->> 'source_relation_id',
    p_route ->> 'canonical_source_id',
    p_route ->> 'dataset_version',
    p_route ->> 'payload_hash',
    p_route ->> 'route_name',
    p_route ->> 'semantic_type',
    (p_route ->> 'quality_score')::double precision,
    p_route -> 'geometry_geojson',
    (p_route ->> 'distance_meters')::double precision,
    nullif(p_route ->> 'matched_primary_mountain_id', '')::bigint,
    p_route -> 'audit_flags',
    p_route ->> 'import_eligibility',
    p_route -> 'payload'
  )
  on conflict (idempotency_key) do update set
    contract_version = excluded.contract_version,
    provider = excluded.provider,
    source_relation_id = excluded.source_relation_id,
    canonical_source_id = excluded.canonical_source_id,
    dataset_version = excluded.dataset_version,
    payload_hash = excluded.payload_hash,
    route_name = excluded.route_name,
    semantic_type = excluded.semantic_type,
    quality_score = excluded.quality_score,
    geometry_geojson = excluded.geometry_geojson,
    distance_meters = excluded.distance_meters,
    matched_primary_mountain_id = excluded.matched_primary_mountain_id,
    audit_flags = excluded.audit_flags,
    import_eligibility = excluded.import_eligibility,
    payload = excluded.payload,
    updated_at = now()
  returning id into v_route_id;

  delete from public.osm_route_import_summit_staging
  where staging_route_id = v_route_id;

  insert into public.osm_route_import_summit_staging (
    staging_route_id,
    peak_osm_id,
    mountain_id,
    mountain_match_classification,
    final_association,
    final_confidence,
    minimum_geometry_distance_meters,
    endpoint_distance_meters,
    evidence,
    payload
  )
  select
    v_route_id,
    summit ->> 'peak_osm_id',
    (summit ->> 'mountain_id')::bigint,
    summit ->> 'mountain_match_classification',
    summit ->> 'final_association',
    (summit ->> 'final_confidence')::double precision,
    (summit ->> 'minimum_geometry_distance_meters')::double precision,
    (summit ->> 'endpoint_distance_meters')::double precision,
    summit -> 'evidence',
    summit -> 'payload'
  from jsonb_array_elements(p_summits) as summit;

  return v_route_id;
end;
$$;

alter table public.osm_route_import_staging enable row level security;
alter table public.osm_route_import_summit_staging enable row level security;

-- No user-facing RLS policies are intentionally created. Only a trusted service
-- role may inspect or modify these isolated staging records after manual deploy.
revoke all on public.osm_route_import_staging from public, anon, authenticated;
revoke all on public.osm_route_import_summit_staging from public, anon, authenticated;
revoke all on function public.stage_osm_route_import(jsonb, jsonb)
  from public, anon, authenticated;

grant all on public.osm_route_import_staging to service_role;
grant all on public.osm_route_import_summit_staging to service_role;
grant execute on function public.stage_osm_route_import(jsonb, jsonb)
  to service_role;

comment on table public.osm_route_import_staging is
  'Service-only Phase 8 OSM route staging. Never queried as a public route source.';
comment on table public.osm_route_import_summit_staging is
  'Exact Mountain Tracker summit matches for Phase 8 staged OSM routes.';

comment on function public.stage_osm_route_import(jsonb, jsonb) is
  'Service-only atomic upsert of one reviewed Phase 8 route and its complete summit set.';
