-- Phase 11C-CAT multi-category publication contract.
-- REVIEW ONLY. DO NOT APPLY without separate explicit authorization.
-- Applying this file changes contract infrastructure but publishes zero routes.
-- The deployed v1 RPC is intentionally left unchanged for existing ACTIVE records.

begin;

do $production_preflight$
declare
  v_route_type_attnum smallint;
  v_route_type_constraint_count integer;
  v_route_type_constraint_definition text;
  v_route_type_values text[];
  v_route_type_default text;
  v_provenance_constraint_definition text;
  v_provenance_contract_values text[];
  v_v1_rpc regprocedure;
  v_v1_rpc_hash text;
begin
  select attributes.attnum, pg_catalog.pg_get_expr(defaults.adbin, defaults.adrelid)
  into strict v_route_type_attnum, v_route_type_default
  from pg_catalog.pg_attribute attributes
  left join pg_catalog.pg_attrdef defaults
    on defaults.adrelid = attributes.attrelid
    and defaults.adnum = attributes.attnum
  where attributes.attrelid = 'public.mountain_routes'::regclass
    and attributes.attname = 'route_type'
    and not attributes.attisdropped
    and attributes.atttypid = 'text'::regtype
    and attributes.attnotnull;
  if v_route_type_default is distinct from '''hiking''::text' then
    raise exception 'PHASE11C_CAT_ROUTE_TYPE_DEFAULT_DRIFT:%', v_route_type_default;
  end if;

  select count(*)
  into v_route_type_constraint_count
  from pg_catalog.pg_constraint constraints
  where constraints.conrelid = 'public.mountain_routes'::regclass
    and constraints.contype = 'c'
    and constraints.conkey @> array[v_route_type_attnum]::smallint[];
  if v_route_type_constraint_count <> 1 then
    raise exception 'PHASE11C_CAT_ROUTE_TYPE_CONSTRAINT_COUNT_DRIFT:%',
      v_route_type_constraint_count;
  end if;

  select pg_catalog.pg_get_constraintdef(constraints.oid, true)
  into strict v_route_type_constraint_definition
  from pg_catalog.pg_constraint constraints
  where constraints.conrelid = 'public.mountain_routes'::regclass
    and constraints.contype = 'c'
    and constraints.conname = 'mountain_routes_route_type_check'
    and constraints.conkey = array[v_route_type_attnum]::smallint[];
  select array_agg(distinct matches[1] order by matches[1])
  into v_route_type_values
  from pg_catalog.regexp_matches(
    v_route_type_constraint_definition,
    $values$'([^']+)'$values$,
    'g'
  ) matches;
  if v_route_type_values is distinct from array[
      'climbing', 'hiking', 'mixed', 'mountaineering',
      'other', 'ski_touring', 'via_ferrata'
    ]::text[]
    or pg_catalog.regexp_replace(
      pg_catalog.lower(v_route_type_constraint_definition), '\s+', '', 'g'
    ) not like 'check(%route_type=any(array[%'
  then
    raise exception 'PHASE11C_CAT_ROUTE_TYPE_TAXONOMY_DRIFT:%',
      v_route_type_constraint_definition;
  end if;

  if (select count(*) from public.mountain_routes) <> 7
    or (select count(*) from public.mountain_routes where route_type = 'hiking') <> 7
  then raise exception 'PHASE11C_CAT_EXISTING_MOUNTAIN_ROUTE_ROWS_DRIFT';
  end if;
  if (select count(*) from public.osm_route_publication_provenance) <> 6
    or (select count(*) from public.osm_route_publication_provenance
        where publication_contract_version = 'mountain-tracker-osm-publication/v1'
          and publication_status = 'ACTIVE') <> 6
  then raise exception 'PHASE11C_CAT_EXISTING_V1_PROVENANCE_DRIFT';
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'osm_route_publication_provenance'
      and column_name in ('activity_classification', 'activity_classification_hash')
  ) then raise exception 'PHASE11C_CAT_V2_COLUMNS_ALREADY_EXIST';
  end if;
  if pg_catalog.to_regprocedure('public.publish_approved_osm_route_v2(jsonb)') is not null
  then raise exception 'PHASE11C_CAT_V2_RPC_ALREADY_EXISTS';
  end if;

  select pg_catalog.pg_get_constraintdef(constraints.oid, true)
  into strict v_provenance_constraint_definition
  from pg_catalog.pg_constraint constraints
  where constraints.conrelid = 'public.osm_route_publication_provenance'::regclass
    and constraints.contype = 'c'
    and constraints.conname =
      'osm_route_publication_proven_publication_contract_version_check';
  select array_agg(distinct matches[1] order by matches[1])
  into v_provenance_contract_values
  from pg_catalog.regexp_matches(
    v_provenance_constraint_definition,
    $values$'([^']+)'$values$,
    'g'
  ) matches;
  if v_provenance_contract_values is distinct from
      array['mountain-tracker-osm-publication/v1']::text[]
    or pg_catalog.regexp_replace(
      pg_catalog.lower(v_provenance_constraint_definition), '\s+', '', 'g'
    ) not like 'check(%publication_contract_version=%'
  then raise exception 'PHASE11C_CAT_V1_CONTRACT_CONSTRAINT_DRIFT:%',
    v_provenance_constraint_definition;
  end if;

  v_v1_rpc := pg_catalog.to_regprocedure('public.publish_approved_osm_route(jsonb)');
  if v_v1_rpc is null then raise exception 'PHASE11C_CAT_V1_RPC_MISSING'; end if;
  v_v1_rpc_hash := encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.pg_get_functiondef(v_v1_rpc), 'UTF8'),
    'sha256'
  ), 'hex');
  if v_v1_rpc_hash <> 'b83896065baea27a5baf3500ff9934df4a50e41866fc4584f95f206ea1afa391'
  then raise exception 'PHASE11C_CAT_V1_RPC_HASH_DRIFT:%', v_v1_rpc_hash;
  end if;
exception
  when no_data_found then
    raise exception 'PHASE11C_CAT_PRODUCTION_SCHEMA_MISMATCH';
  when too_many_rows then
    raise exception 'PHASE11C_CAT_PRODUCTION_SCHEMA_NOT_UNIQUE';
end;
$production_preflight$;

alter table public.osm_route_publication_provenance
  drop constraint osm_route_publication_proven_publication_contract_version_check;
alter table public.osm_route_publication_provenance
  add constraint osm_route_publication_proven_publication_contract_version_check
  check (publication_contract_version in (
    'mountain-tracker-osm-publication/v1',
    'mountain-tracker-osm-publication/v2'
  ));
alter table public.osm_route_publication_provenance
  add column activity_classification jsonb,
  add column activity_classification_hash text;
alter table public.osm_route_publication_provenance
  add constraint osm_route_publication_activity_contract_check check (
    (publication_contract_version = 'mountain-tracker-osm-publication/v1'
      and activity_classification is null
      and activity_classification_hash is null)
    or
    (publication_contract_version = 'mountain-tracker-osm-publication/v2'
      and jsonb_typeof(activity_classification) = 'object'
      and (activity_classification ->> 'schemaVersion')::integer = 1
      and activity_classification ->> 'routeType' in (
        'hiking', 'mountaineering', 'via_ferrata', 'climbing',
        'ski_touring', 'mixed', 'other'
      )
      and coalesce(activity_classification ->> 'semanticType', '') <> ''
      and activity_classification -> 'manualReviewRequired' = 'false'::jsonb
      and jsonb_typeof(activity_classification -> 'confidence') = 'number'
      and (activity_classification ->> 'confidence')::numeric between 0 and 1
      and jsonb_typeof(activity_classification -> 'evidence') = 'array'
      and jsonb_typeof(activity_classification -> 'conflictingTypes') = 'array'
      and activity_classification ->> 'sourceEvidenceHash' ~ '^[0-9a-f]{64}$'
      and activity_classification_hash ~ '^[0-9a-f]{64}$')
  );

create or replace function public.publish_approved_osm_route_v2(p_request jsonb)
returns table (action text, mountain_route_id bigint)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_contract constant text := 'mountain-tracker-osm-publication/v2';
  v_candidate_text text := p_request ->> 'candidateCanonicalJson';
  v_manifest_text text := p_request ->> 'manifestCanonicalJson';
  v_target_text text := p_request ->> 'mountainRouteCanonicalJson';
  v_geometry_text text := p_request ->> 'geometryCanonicalJson';
  v_history_text text := p_request ->> 'qaHistoryCanonicalJson';
  v_activity_text text := p_request ->> 'activityClassificationCanonicalJson';
  v_candidate jsonb;
  v_manifest jsonb;
  v_target jsonb := p_request -> 'mountainRoutePayload';
  v_provenance jsonb := p_request -> 'provenancePayload';
  v_activity jsonb;
  v_staging public.osm_route_import_staging%rowtype;
  v_qa public.osm_staging_route_visual_qa%rowtype;
  v_summit public.osm_route_import_summit_staging%rowtype;
  v_existing public.osm_route_publication_provenance%rowtype;
  v_history jsonb;
  v_route_id bigint;
  v_expected_url text;
  v_expected_warning text;
  v_route_type text;
begin
  if jsonb_typeof(p_request) <> 'object'
    or v_candidate_text is null or v_manifest_text is null
    or v_target_text is null or v_geometry_text is null
    or v_history_text is null or v_activity_text is null
    or jsonb_typeof(v_target) <> 'object'
    or jsonb_typeof(v_provenance) <> 'object'
  then raise exception using errcode = '22023', message = 'PHASE11C_CAT_REQUEST_INVALID';
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
    or encode(extensions.digest(convert_to(v_activity_text, 'UTF8'), 'sha256'), 'hex')
       <> p_request ->> 'activityClassificationHash'
  then raise exception using errcode = '23514', message = 'PHASE11C_CAT_CANONICAL_HASH_DRIFT';
  end if;

  v_candidate := v_candidate_text::jsonb;
  v_manifest := v_manifest_text::jsonb;
  v_activity := v_activity_text::jsonb;
  if v_target is distinct from v_target_text::jsonb
    or v_candidate -> 'originalGeometry' is distinct from v_geometry_text::jsonb
    or v_provenance -> 'qa_history_snapshot' is distinct from v_history_text::jsonb
    or v_provenance -> 'activity_classification' is distinct from v_activity
    or v_provenance ->> 'activity_classification_hash'
       <> p_request ->> 'activityClassificationHash'
    or v_provenance ->> 'publication_contract_version' <> v_contract
  then raise exception using errcode = '23514', message = 'PHASE11C_CAT_CANONICAL_CONTENT_DRIFT';
  end if;

  v_route_type := v_activity ->> 'routeType';
  if v_route_type not in (
      'hiking', 'mountaineering', 'via_ferrata', 'climbing',
      'ski_touring', 'mixed', 'other'
    )
    or (v_activity ->> 'manualReviewRequired')::boolean is not false
    or v_activity ->> 'semanticType' <> v_candidate ->> 'semanticType'
    or v_activity ->> 'sourceEvidenceHash' !~ '^[0-9a-f]{64}$'
  then raise exception using errcode = '23514', message = 'PHASE11C_CAT_ACTIVITY_REVIEW_REQUIRED';
  end if;

  if not exists (
    select 1 from jsonb_array_elements(v_manifest -> 'records') record
    where record ->> 'stagingRouteId' = v_candidate ->> 'stagingRouteId'
      and record ->> 'sourceRelationId' = v_candidate ->> 'sourceRelationId'
      and record ->> 'canonicalRouteSourceId' = v_candidate ->> 'canonicalRouteSourceId'
      and (record ->> 'mountainId')::bigint = (v_candidate #>> '{summit,mountainId}')::bigint
      and record ->> 'semanticType' = v_candidate ->> 'semanticType'
      and record ->> 'routeType' = v_activity ->> 'routeType'
      and record ->> 'activityCanonicalJson' = v_activity_text
      and record ->> 'activityClassificationHash' = p_request ->> 'activityClassificationHash'
      and record ->> 'sourceEvidenceHash' = v_activity ->> 'sourceEvidenceHash'
      and record ->> 'stagingPayloadHash' = v_candidate ->> 'payloadHash'
      and (record ->> 'qaDecisionVersion')::bigint = (v_candidate #>> '{qaDecision,version}')::bigint
      and record ->> 'candidateContentHash' = p_request ->> 'candidateContentHash'
      and record ->> 'targetPayloadHash' = v_provenance ->> 'target_payload_hash'
      and record ->> 'geometryHash' = v_provenance ->> 'geometry_hash'
      and record ->> 'publicationIdempotencyKey' = v_provenance ->> 'publication_idempotency_key'
      and record ->> 'publicationContractVersion' = v_contract
  ) then raise exception using errcode = '23514', message = 'PHASE11C_CAT_MANIFEST_MEMBERSHIP_FAILED';
  end if;

  if v_provenance ->> 'publication_idempotency_key'
       <> (v_candidate ->> 'idempotencyKey') || ':' || v_contract
    or v_provenance ->> 'candidate_manifest_hash'
       <> p_request ->> 'candidateManifestHash'
  then raise exception using errcode = '23514', message = 'PHASE11C_CAT_PUBLICATION_IDENTITY_DRIFT';
  end if;

  select * into strict v_staging from public.osm_route_import_staging
  where id = (v_candidate ->> 'stagingRouteId')::uuid for update;
  if v_staging.contract_version <> 'mountain-tracker-osm-route/v1'
    or v_staging.provider <> 'openstreetmap'
    or v_staging.idempotency_key <> v_candidate ->> 'idempotencyKey'
    or v_staging.source_relation_id <> v_candidate ->> 'sourceRelationId'
    or v_staging.canonical_source_id <> v_candidate ->> 'canonicalRouteSourceId'
    or v_staging.payload_hash <> v_candidate ->> 'payloadHash'
    or v_staging.route_name is distinct from v_candidate ->> 'routeName'
    or v_staging.semantic_type <> v_candidate ->> 'semanticType'
    or v_staging.semantic_type <> 'summit_route'
    or v_staging.matched_primary_mountain_id <> (v_candidate #>> '{summit,mountainId}')::bigint
    or v_staging.import_eligibility <> 'AUTO_IMPORT_READY'
    or v_staging.geometry_geojson is distinct from v_candidate -> 'originalGeometry'
  then raise exception using errcode = '23514', message = 'PHASE11C_CAT_STAGING_DRIFT';
  end if;

  select * into strict v_summit from public.osm_route_import_summit_staging
  where staging_route_id = v_staging.id
    and peak_osm_id = v_candidate #>> '{summit,peakOsmId}'
    and mountain_id = (v_candidate #>> '{summit,mountainId}')::bigint
    and mountain_match_classification = 'EXACT_MOUNTAIN_MATCH'
    and final_association = 'CONFIRMED';
  if (select count(*) from public.osm_route_import_summit_staging where staging_route_id = v_staging.id) <> 1
  then raise exception using errcode = '23514', message = 'PHASE11C_CAT_SUMMIT_COUNT_DRIFT';
  end if;

  select * into strict v_qa from public.osm_staging_route_visual_qa
  where staging_route_id = v_staging.id for update;
  if v_qa.status <> 'VISUALLY_APPROVED'
    or v_qa.version <> (v_candidate #>> '{qaDecision,version}')::bigint
    or v_qa.reviewer_user_id <> (v_candidate #>> '{qaDecision,reviewerUserId}')::uuid
    or v_qa.reviewed_at <> (v_candidate #>> '{qaDecision,reviewedAt}')::timestamptz
    or v_qa.reviewer_note is distinct from v_candidate #>> '{qaDecision,reviewerNote}'
  then raise exception using errcode = '23514', message = 'PHASE11C_CAT_QA_DRIFT';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', history.id, 'stagingRouteId', history.staging_route_id,
    'oldStatus', history.old_status, 'newStatus', history.new_status,
    'reviewerNote', history.reviewer_note, 'reviewerUserId', history.reviewer_user_id,
    'decisionVersion', history.decision_version, 'occurredAt', history.occurred_at
  ) order by history.decision_version, history.id), '[]'::jsonb)
  into v_history from public.osm_staging_route_visual_qa_history history
  where history.staging_route_id = v_staging.id;
  if v_history is distinct from v_provenance -> 'qa_history_snapshot'
    or jsonb_array_length(v_history) = 0
    or (v_history -> -1 ->> 'decisionVersion')::bigint <> v_qa.version
  then raise exception using errcode = '23514', message = 'PHASE11C_CAT_QA_HISTORY_DRIFT';
  end if;

  if not exists (select 1 from public.mountains where id = v_staging.matched_primary_mountain_id)
  then raise exception using errcode = '23503', message = 'PHASE11C_CAT_MOUNTAIN_MISSING';
  end if;
  v_expected_url := format('/api/osm-route-publications/openstreetmap/relation/%s/geojson', v_staging.canonical_source_id);
  v_expected_warning := case v_candidate #>> '{topology,classification}'
    when 'BRANCHING' then 'OpenStreetMap route topology is BRANCHING. Displayed Start and Finish are inferred physical endpoints; endpoint selection is ambiguous.'
    when 'DISCONNECTED' then 'OpenStreetMap route geometry is DISCONNECTED. No artificial global Start or Finish is displayed.'
    when 'AMBIGUOUS' then 'OpenStreetMap route topology is ambiguous. No artificial global Start or Finish is displayed.'
    else null end;
  if (v_target ->> 'mountain_id')::bigint <> v_staging.matched_primary_mountain_id
    or v_target ->> 'name' <> v_staging.route_name
    or v_target ->> 'route_type' <> v_route_type
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
  then raise exception using errcode = '23514', message = 'PHASE11C_CAT_TARGET_MAPPING_DRIFT';
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
      and v_existing.activity_classification_hash = v_provenance ->> 'activity_classification_hash'
      and v_existing.target_payload_hash = v_provenance ->> 'target_payload_hash'
    then return query select 'UNCHANGED'::text, v_existing.mountain_route_id; return;
    end if;
    raise exception using errcode = '23514', message = 'PHASE11C_CAT_EXISTING_PUBLICATION_DRIFT';
  end if;
  if exists (select 1 from public.mountain_routes where source_url = v_target ->> 'source_url')
  then raise exception using errcode = '23505', message = 'PHASE11C_CAT_LEGACY_SOURCE_DUPLICATE';
  end if;

  insert into public.mountain_routes (
    mountain_id, name, start_location, route_type, difficulty_system,
    difficulty_value, distance_km, elevation_gain_m, duration_minutes,
    description, best_season, equipment, warnings, gpx_url, source_name,
    source_url, is_verified, created_by, geojson_url
  ) values (
    (v_target ->> 'mountain_id')::bigint, v_target ->> 'name', null, v_route_type, null,
    null, (v_target ->> 'distance_km')::numeric, null, null, null, null, null,
    nullif(v_target ->> 'warnings', ''), null, 'OpenStreetMap',
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
    audit_evidence, activity_classification, activity_classification_hash
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
    v_candidate -> 'topology', v_provenance -> 'audit_evidence', v_activity,
    v_provenance ->> 'activity_classification_hash'
  );
  return query select 'CREATED'::text, v_route_id;
exception
  when no_data_found then
    raise exception using errcode = 'P0002', message = 'PHASE11C_CAT_REQUIRED_ROW_MISSING';
  when too_many_rows then
    raise exception using errcode = '23514', message = 'PHASE11C_CAT_REQUIRED_ROW_NOT_UNIQUE';
end;
$function$;

revoke all on function public.publish_approved_osm_route_v2(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.publish_approved_osm_route_v2(jsonb) to service_role;

do $production_postflight$
declare
  v_v1_rpc regprocedure;
  v_v1_rpc_hash text;
  v_route_type_definition text;
  v_route_type_values text[];
  v_contract_definition text;
  v_contract_values text[];
begin
  v_v1_rpc := pg_catalog.to_regprocedure('public.publish_approved_osm_route(jsonb)');
  if v_v1_rpc is null then raise exception 'PHASE11C_CAT_V1_RPC_MISSING_POST'; end if;
  v_v1_rpc_hash := encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.pg_get_functiondef(v_v1_rpc), 'UTF8'),
    'sha256'
  ), 'hex');
  if v_v1_rpc_hash <> 'b83896065baea27a5baf3500ff9934df4a50e41866fc4584f95f206ea1afa391'
  then raise exception 'PHASE11C_CAT_V1_RPC_HASH_DRIFT_POST:%', v_v1_rpc_hash;
  end if;

  select pg_catalog.pg_get_constraintdef(constraints.oid, true)
  into strict v_route_type_definition
  from pg_catalog.pg_constraint constraints
  where constraints.conrelid = 'public.mountain_routes'::regclass
    and constraints.contype = 'c'
    and constraints.conname = 'mountain_routes_route_type_check';
  select array_agg(distinct matches[1] order by matches[1])
  into v_route_type_values
  from pg_catalog.regexp_matches(
    v_route_type_definition, $values$'([^']+)'$values$, 'g'
  ) matches;
  if v_route_type_values is distinct from array[
      'climbing', 'hiking', 'mixed', 'mountaineering',
      'other', 'ski_touring', 'via_ferrata'
    ]::text[]
  then raise exception 'PHASE11C_CAT_ROUTE_TYPE_TAXONOMY_DRIFT_POST';
  end if;

  select pg_catalog.pg_get_constraintdef(constraints.oid, true)
  into strict v_contract_definition
  from pg_catalog.pg_constraint constraints
  where constraints.conrelid = 'public.osm_route_publication_provenance'::regclass
    and constraints.contype = 'c'
    and constraints.conname =
      'osm_route_publication_proven_publication_contract_version_check';
  select array_agg(distinct matches[1] order by matches[1])
  into v_contract_values
  from pg_catalog.regexp_matches(
    v_contract_definition, $values$'([^']+)'$values$, 'g'
  ) matches;
  if v_contract_values is distinct from array[
      'mountain-tracker-osm-publication/v1',
      'mountain-tracker-osm-publication/v2'
    ]::text[]
  then raise exception 'PHASE11C_CAT_CONTRACT_VERSION_DRIFT_POST';
  end if;

  if (select count(*) from public.mountain_routes) <> 7
    or (select count(*) from public.mountain_routes where route_type = 'hiking') <> 7
  then raise exception 'PHASE11C_CAT_MOUNTAIN_ROUTE_ROWS_CHANGED';
  end if;
  if (select count(*) from public.osm_route_publication_provenance) <> 6
    or (select count(*) from public.osm_route_publication_provenance
        where publication_contract_version = 'mountain-tracker-osm-publication/v1'
          and publication_status = 'ACTIVE'
          and activity_classification is null
          and activity_classification_hash is null) <> 6
  then raise exception 'PHASE11C_CAT_V1_PROVENANCE_ROWS_CHANGED';
  end if;
  if pg_catalog.to_regprocedure('public.publish_approved_osm_route_v2(jsonb)') is null
  then raise exception 'PHASE11C_CAT_V2_RPC_MISSING_POST';
  end if;
exception
  when no_data_found then
    raise exception 'PHASE11C_CAT_POSTFLIGHT_SCHEMA_MISMATCH';
  when too_many_rows then
    raise exception 'PHASE11C_CAT_POSTFLIGHT_SCHEMA_NOT_UNIQUE';
end;
$production_postflight$;

comment on function public.publish_approved_osm_route_v2(jsonb) is
  'Phase 11C-CAT v2 publisher: separate immutable route role from Mountain Tracker activity taxonomy.';

commit;
