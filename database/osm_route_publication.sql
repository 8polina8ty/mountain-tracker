-- Phase 11 controlled OSM route publication contract.
-- REVIEW ONLY. DO NOT APPLY without separate explicit authorization.
-- Applying this file creates publication infrastructure but publishes zero routes.

begin;

create extension if not exists pgcrypto with schema extensions;

do $schema_guard$
declare
  v_missing text[];
begin
  select array_agg(expected.column_name order by expected.column_name)
  into v_missing
  from (values
    ('id'), ('mountain_id'), ('name'), ('start_location'), ('route_type'),
    ('difficulty_system'), ('difficulty_value'), ('distance_km'),
    ('elevation_gain_m'), ('duration_minutes'), ('description'), ('best_season'),
    ('equipment'), ('warnings'), ('gpx_url'), ('source_name'), ('source_url'),
    ('is_verified'), ('created_by'), ('created_at'), ('updated_at'), ('geojson_url')
  ) as expected(column_name)
  where not exists (
    select 1 from information_schema.columns actual
    where actual.table_schema = 'public'
      and actual.table_name = 'mountain_routes'
      and actual.column_name = expected.column_name
  );
  if v_missing is not null then
    raise exception 'PHASE11_MOUNTAIN_ROUTES_SCHEMA_MISMATCH:%', v_missing;
  end if;
end;
$schema_guard$;

create table public.osm_route_publication_provenance (
  id uuid primary key default gen_random_uuid(),
  mountain_route_id bigint not null unique
    references public.mountain_routes(id) on delete restrict,
  staging_route_id uuid not null unique
    references public.osm_route_import_staging(id) on delete restrict,
  publication_contract_version text not null
    check (publication_contract_version = 'mountain-tracker-osm-publication/v1'),
  publication_idempotency_key text not null unique,
  publication_status text not null default 'ACTIVE'
    check (publication_status = 'ACTIVE'),
  provider text not null check (provider = 'openstreetmap'),
  canonical_relation_id text not null check (canonical_relation_id ~ '^[1-9][0-9]*$'),
  source_relation_ids jsonb not null check (jsonb_typeof(source_relation_ids) = 'array'),
  staging_payload_hash text not null check (staging_payload_hash ~ '^[0-9a-f]{64}$'),
  candidate_content_hash text not null check (candidate_content_hash ~ '^[0-9a-f]{64}$'),
  candidate_set_content_hash text not null check (candidate_set_content_hash ~ '^[0-9a-f]{64}$'),
  candidate_manifest_hash text not null check (candidate_manifest_hash ~ '^[0-9a-f]{64}$'),
  dataset_fingerprint text not null check (dataset_fingerprint ~ '^[0-9a-f]{64}$'),
  geometry_hash text not null check (geometry_hash ~ '^[0-9a-f]{64}$'),
  target_payload_hash text not null check (target_payload_hash ~ '^[0-9a-f]{64}$'),
  qa_status text not null check (qa_status = 'VISUALLY_APPROVED'),
  qa_decision_version bigint not null check (qa_decision_version > 0),
  qa_reviewer_user_id uuid not null references auth.users(id) on delete restrict,
  qa_reviewed_at timestamptz not null,
  qa_reviewer_note text,
  qa_history_snapshot jsonb not null check (jsonb_typeof(qa_history_snapshot) = 'array'),
  qa_history_hash text not null check (qa_history_hash ~ '^[0-9a-f]{64}$'),
  source_url text not null,
  source_license text not null,
  source_attribution text not null,
  topology jsonb not null check (jsonb_typeof(topology) = 'object'),
  audit_evidence jsonb not null check (jsonb_typeof(audit_evidence) = 'object'),
  published_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp(),
  constraint osm_route_publication_canonical_contract_key
    unique (provider, canonical_relation_id, publication_contract_version)
);

create index osm_route_publication_provenance_staging_idx
  on public.osm_route_publication_provenance (staging_route_id);

alter table public.osm_route_publication_provenance enable row level security;
revoke all on public.osm_route_publication_provenance
  from public, anon, authenticated, service_role;
grant select on public.osm_route_publication_provenance to service_role;

create or replace function public.publish_approved_osm_route(p_request jsonb)
returns table (action text, mountain_route_id bigint)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_contract constant text := 'mountain-tracker-osm-publication/v1';
  v_candidate_text text := p_request ->> 'candidateCanonicalJson';
  v_manifest_text text := p_request ->> 'manifestCanonicalJson';
  v_target_text text := p_request ->> 'mountainRouteCanonicalJson';
  v_geometry_text text := p_request ->> 'geometryCanonicalJson';
  v_history_text text := p_request ->> 'qaHistoryCanonicalJson';
  v_candidate jsonb;
  v_manifest jsonb;
  v_target jsonb := p_request -> 'mountainRoutePayload';
  v_provenance jsonb := p_request -> 'provenancePayload';
  v_staging public.osm_route_import_staging%rowtype;
  v_qa public.osm_staging_route_visual_qa%rowtype;
  v_summit public.osm_route_import_summit_staging%rowtype;
  v_existing public.osm_route_publication_provenance%rowtype;
  v_history jsonb;
  v_route_id bigint;
  v_expected_url text;
  v_expected_warning text;
begin
  if jsonb_typeof(p_request) <> 'object'
    or v_candidate_text is null
    or v_manifest_text is null
    or v_target_text is null
    or v_geometry_text is null
    or v_history_text is null
    or jsonb_typeof(v_target) <> 'object'
    or jsonb_typeof(v_provenance) <> 'object'
  then raise exception using errcode = '22023', message = 'PHASE11_REQUEST_INVALID';
  end if;
  if encode(extensions.digest(convert_to(v_candidate_text, 'UTF8'), 'sha256'), 'hex')
       <> p_request ->> 'candidateContentHash'
    or encode(extensions.digest(convert_to(v_manifest_text, 'UTF8'), 'sha256'), 'hex')
       <> p_request ->> 'candidateManifestHash'
    or encode(extensions.digest(convert_to(v_target_text, 'UTF8'), 'sha256'), 'hex')
       <> v_provenance ->> 'target_payload_hash'
    or encode(extensions.digest(convert_to(v_geometry_text, 'UTF8'), 'sha256'), 'hex')
       <> v_provenance ->> 'geometry_hash'
    or encode(extensions.digest(convert_to(v_history_text, 'UTF8'), 'sha256'), 'hex')
       <> v_provenance ->> 'qa_history_hash'
  then raise exception using errcode = '23514', message = 'PHASE11_CANONICAL_HASH_DRIFT';
  end if;
  v_candidate := v_candidate_text::jsonb;
  v_manifest := v_manifest_text::jsonb;
  if v_target is distinct from v_target_text::jsonb
    or v_candidate -> 'originalGeometry' is distinct from v_geometry_text::jsonb
    or v_provenance -> 'qa_history_snapshot' is distinct from v_history_text::jsonb
  then raise exception using errcode = '23514', message = 'PHASE11_CANONICAL_CONTENT_DRIFT';
  end if;
  if not exists (
    select 1 from jsonb_array_elements(v_manifest -> 'records') record
    where record ->> 'stagingRouteId' = v_candidate ->> 'stagingRouteId'
      and record ->> 'sourceRelationId' = v_candidate ->> 'sourceRelationId'
      and record ->> 'canonicalRouteSourceId' = v_candidate ->> 'canonicalRouteSourceId'
      and (record ->> 'mountainId')::bigint = (v_candidate #>> '{summit,mountainId}')::bigint
      and record ->> 'payloadHash' = v_candidate ->> 'payloadHash'
      and (record ->> 'qaDecisionVersion')::bigint = (v_candidate #>> '{qaDecision,version}')::bigint
      and record ->> 'candidateContentHash' = p_request ->> 'candidateContentHash'
  ) then raise exception using errcode = '23514', message = 'PHASE11_MANIFEST_MEMBERSHIP_FAILED';
  end if;

  select * into strict v_staging
  from public.osm_route_import_staging
  where id = (v_candidate ->> 'stagingRouteId')::uuid
  for update;
  if v_staging.contract_version <> 'mountain-tracker-osm-route/v1'
    or v_staging.provider <> 'openstreetmap'
    or v_staging.idempotency_key <> v_candidate ->> 'idempotencyKey'
    or v_staging.source_relation_id <> v_candidate ->> 'sourceRelationId'
    or v_staging.canonical_source_id <> v_candidate ->> 'canonicalRouteSourceId'
    or v_staging.payload_hash <> v_candidate ->> 'payloadHash'
    or v_staging.route_name is distinct from v_candidate ->> 'routeName'
    or v_staging.semantic_type <> 'summit_route'
    or v_staging.matched_primary_mountain_id <> (v_candidate #>> '{summit,mountainId}')::bigint
    or v_staging.import_eligibility <> 'AUTO_IMPORT_READY'
    or v_staging.geometry_geojson is distinct from v_candidate -> 'originalGeometry'
  then raise exception using errcode = '23514', message = 'PHASE11_STAGING_DRIFT';
  end if;

  select * into strict v_summit
  from public.osm_route_import_summit_staging
  where staging_route_id = v_staging.id
    and peak_osm_id = v_candidate #>> '{summit,peakOsmId}'
    and mountain_id = (v_candidate #>> '{summit,mountainId}')::bigint
    and mountain_match_classification = 'EXACT_MOUNTAIN_MATCH'
    and final_association = 'CONFIRMED';
  if (select count(*) from public.osm_route_import_summit_staging where staging_route_id = v_staging.id) <> 1
  then raise exception using errcode = '23514', message = 'PHASE11_SUMMIT_COUNT_DRIFT';
  end if;

  select * into strict v_qa from public.osm_staging_route_visual_qa
  where staging_route_id = v_staging.id for update;
  if v_qa.status <> 'VISUALLY_APPROVED'
    or v_qa.version <> (v_candidate #>> '{qaDecision,version}')::bigint
    or v_qa.reviewer_user_id <> (v_candidate #>> '{qaDecision,reviewerUserId}')::uuid
    or v_qa.reviewed_at <> (v_candidate #>> '{qaDecision,reviewedAt}')::timestamptz
    or v_qa.reviewer_note is distinct from v_candidate #>> '{qaDecision,reviewerNote}'
  then raise exception using errcode = '23514', message = 'PHASE11_QA_DRIFT';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', history.id,
    'stagingRouteId', history.staging_route_id,
    'oldStatus', history.old_status,
    'newStatus', history.new_status,
    'reviewerNote', history.reviewer_note,
    'reviewerUserId', history.reviewer_user_id,
    'decisionVersion', history.decision_version,
    'occurredAt', history.occurred_at
  ) order by history.decision_version, history.id), '[]'::jsonb)
  into v_history from public.osm_staging_route_visual_qa_history history
  where history.staging_route_id = v_staging.id;
  if v_history is distinct from v_provenance -> 'qa_history_snapshot'
    or jsonb_array_length(v_history) = 0
    or (v_history -> -1 ->> 'decisionVersion')::bigint <> v_qa.version
  then raise exception using errcode = '23514', message = 'PHASE11_QA_HISTORY_DRIFT';
  end if;

  if not exists (select 1 from public.mountains where id = v_staging.matched_primary_mountain_id)
  then raise exception using errcode = '23503', message = 'PHASE11_MOUNTAIN_MISSING';
  end if;
  v_expected_url := format('/api/osm-route-publications/openstreetmap/relation/%s/geojson', v_staging.canonical_source_id);
  v_expected_warning := case v_candidate #>> '{topology,classification}'
    when 'BRANCHING' then 'OpenStreetMap route topology is BRANCHING. Displayed Start and Finish are inferred physical endpoints; endpoint selection is ambiguous.'
    when 'DISCONNECTED' then 'OpenStreetMap route geometry is DISCONNECTED. No artificial global Start or Finish is displayed.'
    when 'AMBIGUOUS' then 'OpenStreetMap route topology is ambiguous. No artificial global Start or Finish is displayed.'
    else null end;
  if (v_target ->> 'mountain_id')::bigint <> v_staging.matched_primary_mountain_id
    or v_target ->> 'name' <> v_staging.route_name
    or v_target ->> 'route_type' <> 'hiking'
    or (v_target ->> 'distance_km')::numeric <> round(v_staging.distance_meters::numeric) / 1000
    or v_target ->> 'source_name' <> 'OpenStreetMap'
    or v_target ->> 'source_url' <> v_candidate #>> '{provenance,sourceUrl}'
    or (v_target ->> 'is_verified')::boolean is not true
    or v_target ->> 'geojson_url' <> v_expected_url
    or v_target ->> 'warnings' is distinct from v_expected_warning
    or v_target -> 'start_location' <> 'null'::jsonb
    or v_target -> 'difficulty_system' <> 'null'::jsonb
    or v_target -> 'difficulty_value' <> 'null'::jsonb
    or v_target -> 'elevation_gain_m' <> 'null'::jsonb
    or v_target -> 'duration_minutes' <> 'null'::jsonb
    or v_target -> 'description' <> 'null'::jsonb
    or v_target -> 'best_season' <> 'null'::jsonb
    or v_target -> 'equipment' <> 'null'::jsonb
    or v_target -> 'gpx_url' <> 'null'::jsonb
    or v_target -> 'created_by' <> 'null'::jsonb
  then raise exception using errcode = '23514', message = 'PHASE11_TARGET_MAPPING_DRIFT';
  end if;

  select * into v_existing from public.osm_route_publication_provenance
  where publication_idempotency_key = v_provenance ->> 'publication_idempotency_key'
  for update;
  if found then
    if v_existing.staging_payload_hash = v_provenance ->> 'staging_payload_hash'
      and v_existing.candidate_content_hash = v_provenance ->> 'candidate_content_hash'
      and v_existing.candidate_set_content_hash = v_provenance ->> 'candidate_set_content_hash'
      and v_existing.candidate_manifest_hash = v_provenance ->> 'candidate_manifest_hash'
      and v_existing.dataset_fingerprint = v_provenance ->> 'dataset_fingerprint'
      and v_existing.geometry_hash = v_provenance ->> 'geometry_hash'
      and v_existing.qa_decision_version = (v_provenance ->> 'qa_decision_version')::bigint
      and v_existing.qa_history_hash = v_provenance ->> 'qa_history_hash'
      and v_existing.target_payload_hash = v_provenance ->> 'target_payload_hash'
    then return query select 'UNCHANGED'::text, v_existing.mountain_route_id; return;
    end if;
    raise exception using errcode = '23514', message = 'PHASE11_EXISTING_PUBLICATION_DRIFT';
  end if;
  if exists (select 1 from public.mountain_routes where source_url = v_target ->> 'source_url')
  then raise exception using errcode = '23505', message = 'PHASE11_LEGACY_SOURCE_DUPLICATE';
  end if;

  insert into public.mountain_routes (
    mountain_id, name, start_location, route_type, difficulty_system,
    difficulty_value, distance_km, elevation_gain_m, duration_minutes,
    description, best_season, equipment, warnings, gpx_url, source_name,
    source_url, is_verified, created_by, geojson_url
  ) values (
    (v_target ->> 'mountain_id')::bigint, v_target ->> 'name', null, 'hiking', null,
    null, (v_target ->> 'distance_km')::numeric, null, null,
    null, null, null, nullif(v_target ->> 'warnings', ''), null, 'OpenStreetMap',
    v_target ->> 'source_url', true, null, v_target ->> 'geojson_url'
  ) returning id into v_route_id;

  insert into public.osm_route_publication_provenance (
    mountain_route_id, staging_route_id, publication_contract_version,
    publication_idempotency_key, provider, canonical_relation_id,
    source_relation_ids, staging_payload_hash, candidate_content_hash,
    candidate_set_content_hash, candidate_manifest_hash, dataset_fingerprint,
    geometry_hash, target_payload_hash, qa_status, qa_decision_version,
    qa_reviewer_user_id, qa_reviewed_at, qa_reviewer_note, qa_history_snapshot,
    qa_history_hash, source_url, source_license, source_attribution, topology,
    audit_evidence
  ) values (
    v_route_id, v_staging.id, v_contract,
    v_provenance ->> 'publication_idempotency_key', 'openstreetmap',
    v_staging.canonical_source_id, v_provenance -> 'source_relation_ids',
    v_staging.payload_hash, v_provenance ->> 'candidate_content_hash',
    v_provenance ->> 'candidate_set_content_hash', v_provenance ->> 'candidate_manifest_hash',
    v_provenance ->> 'dataset_fingerprint', v_provenance ->> 'geometry_hash',
    v_provenance ->> 'target_payload_hash', 'VISUALLY_APPROVED', v_qa.version,
    v_qa.reviewer_user_id, v_qa.reviewed_at, v_qa.reviewer_note, v_history,
    v_provenance ->> 'qa_history_hash', v_candidate #>> '{provenance,sourceUrl}',
    v_candidate #>> '{provenance,license}', v_candidate #>> '{provenance,attribution}',
    v_candidate -> 'topology', v_provenance -> 'audit_evidence'
  );
  return query select 'CREATED'::text, v_route_id;
exception
  when no_data_found then
    raise exception using errcode = 'P0002', message = 'PHASE11_REQUIRED_ROW_MISSING';
  when too_many_rows then
    raise exception using errcode = '23514', message = 'PHASE11_REQUIRED_ROW_NOT_UNIQUE';
end;
$function$;

revoke all on function public.publish_approved_osm_route(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.publish_approved_osm_route(jsonb) to service_role;

comment on table public.osm_route_publication_provenance is
  'Service-only Phase 11 traceability from mountain_routes to immutable OSM staging and QA evidence.';
comment on function public.publish_approved_osm_route(jsonb) is
  'Atomic fail-closed publication of one exact manifest-locked VISUALLY_APPROVED OSM route.';

commit;
