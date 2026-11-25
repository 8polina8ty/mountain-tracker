-- MANUAL REVIEW / MANUAL DEPLOYMENT ONLY. Never run automatically.
-- Requires the deployed generated_route_publication.sql contract.
-- Infrastructure only: publishes/replaces zero routes; no Storage mutations.
-- Apply with generated_route_replacement_approval.sql after catalog/grant review.
-- This deliberately supports only the nine human-approved V2 replacements.
begin;

create table public.generated_route_replacement_approvals (
  request_hash text primary key check (request_hash ~ '^[a-f0-9]{64}$'),
  manifest_hash text not null check (manifest_hash ~ '^[a-f0-9]{64}$'),
  mountain_id bigint not null unique check (mountain_id in (138,150,796,12895,49632,51088,55190,69594,73101)),
  mountain_route_id bigint not null unique references public.mountain_routes(id) on delete restrict,
  canonical_request text not null check (octet_length(canonical_request) between 1 and 262144),
  keep_guard jsonb not null check (jsonb_typeof(keep_guard) = 'object'),
  created_at timestamptz not null default now(),
  check (encode(extensions.digest(convert_to(canonical_request,'UTF8'),'sha256'),'hex') = request_hash)
);
alter table public.generated_route_replacement_approvals enable row level security;
revoke all on public.generated_route_replacement_approvals from public, anon, authenticated, service_role;
grant select on public.generated_route_replacement_approvals to service_role;

create table public.generated_route_replacement_audit (
  request_hash text primary key references public.generated_route_replacement_approvals(request_hash) on delete restrict,
  manifest_hash text not null,
  mountain_id bigint not null check (mountain_id in (138,150,796,12895,49632,51088,55190,69594,73101)),
  mountain_route_id bigint not null unique references public.mountain_routes(id) on delete restrict,
  old_route jsonb not null, old_provenance jsonb not null,
  new_route jsonb not null, new_provenance jsonb not null,
  replaced_at timestamptz not null default now()
);
alter table public.generated_route_replacement_audit enable row level security;
revoke all on public.generated_route_replacement_audit from public, anon, authenticated, service_role;
grant select on public.generated_route_replacement_audit to service_role;

create function public.replace_approved_generated_mountain_route(p_request jsonb)
returns table (action text, mountain_route_id bigint)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  v_approval public.generated_route_replacement_approvals%rowtype;
  v_audit public.generated_route_replacement_audit%rowtype;
  v_mountain public.mountains%rowtype;
  v_current public.mountain_routes%rowtype;
  v_provenance public.generated_route_publication_provenance%rowtype;
  v_keep public.mountain_routes%rowtype;
  v_keep_provenance public.generated_route_publication_provenance%rowtype;
  v_request jsonb; v_new jsonb; v_route jsonb; v_evidence jsonb;
  v_old_route jsonb; v_old_provenance jsonb; v_object storage.objects%rowtype;
  v_hash text := p_request ->> 'requestHash';
  v_manifest text := p_request ->> 'manifestHash';
  v_text text := p_request ->> 'canonicalRequest';
  v_kind text; v_field text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'REPLACEMENT_SERVICE_ROLE_REQUIRED';
  end if;
  if jsonb_typeof(p_request) is distinct from 'object'
    or not (p_request ?& array['canonicalRequest','requestHash','manifestHash'])
    or (select count(*) from jsonb_object_keys(p_request)) <> 3
    or v_text is null or octet_length(v_text) not between 1 and 262144
    or v_hash is null or v_hash !~ '^[a-f0-9]{64}$'
    or v_manifest is null or v_manifest !~ '^[a-f0-9]{64}$'
    or encode(extensions.digest(convert_to(v_text,'UTF8'),'sha256'),'hex') is distinct from v_hash
  then raise exception 'REPLACEMENT_CANONICAL_ENVELOPE_INVALID'; end if;

  select * into strict v_approval from public.generated_route_replacement_approvals a
    where a.request_hash = v_hash and a.manifest_hash = v_manifest and a.canonical_request = v_text for share;
  v_request := v_text::jsonb;
  v_new := v_request -> 'newPublication'; v_route := v_new -> 'mountainRoute'; v_evidence := v_new -> 'provenance';
  if v_request ->> 'contract' is distinct from 'mountain-tracker/generated-route-replacement/v1'
    or v_request ->> 'humanApproval' is distinct from 'APPROVE_NEW_V2'
    or v_request ->> 'policyVersion' is distinct from 'mountain-tracker/base-access-start-policy/v2'
    or (v_request ->> 'mountainId')::bigint is distinct from v_approval.mountain_id
    or v_approval.mountain_id = 50473
    or v_approval.mountain_id not in (138,150,796,12895,49632,51088,55190,69594,73101)
    or (v_request ->> 'expectedCurrentMountainRouteId')::bigint is distinct from v_approval.mountain_route_id
    or (v_route ->> 'mountain_id')::bigint is distinct from v_approval.mountain_id
    or (v_request #>> '{expectedOldRoute,id}')::bigint is distinct from v_approval.mountain_route_id
    or (v_request #>> '{expectedOldRoute,mountain_id}')::bigint is distinct from v_approval.mountain_id
    or (v_request #>> '{expectedOldProvenance,mountain_route_id}')::bigint is distinct from v_approval.mountain_route_id
    or (v_request #>> '{expectedOldProvenance,mountain_id}')::bigint is distinct from v_approval.mountain_id
  then raise exception 'REPLACEMENT_SCOPE_OR_APPROVAL_INVALID'; end if;

  -- Guard only; Jenabran never appears in a mutation statement or upload plan.
  select * into strict v_keep from public.mountain_routes where id = 125 and mountain_id = 50473 for share;
  select * into strict v_keep_provenance from public.generated_route_publication_provenance p where p.mountain_route_id = 125 and p.mountain_id = 50473 for share;
  if v_keep.distance_km is distinct from 7.44::numeric or not v_keep.is_verified
    or to_jsonb(v_keep) is distinct from to_jsonb(jsonb_populate_record(null::public.mountain_routes, v_approval.keep_guard #> '{routes,0}'))
    or to_jsonb(v_keep_provenance) is distinct from to_jsonb(jsonb_populate_record(null::public.generated_route_publication_provenance, v_approval.keep_guard #> '{provenance,0}'))
    or (select count(*) from public.mountain_routes where mountain_id = 50473 and is_verified) <> 1
    or (select count(*) from public.generated_route_publication_provenance where mountain_id = 50473) <> 1
  then raise exception 'KEEP_50473_CHANGED'; end if;

  select * into strict v_mountain from public.mountains where id = v_approval.mountain_id for update;
  select * into strict v_current from public.mountain_routes where id = v_approval.mountain_route_id and mountain_id = v_approval.mountain_id for update;
  select * into strict v_provenance from public.generated_route_publication_provenance p where p.mountain_route_id = v_current.id and p.mountain_id = v_mountain.id for update;
  if (select count(*) from public.mountain_routes where mountain_id = v_mountain.id and is_verified) <> 1
    or (select count(*) from public.generated_route_publication_provenance where mountain_id = v_mountain.id) <> 1
  then raise exception 'REPLACEMENT_ACTIVE_ROUTE_COUNT'; end if;

  -- Exact resume proof after a lost response; never repeat a committed update.
  select * into v_audit from public.generated_route_replacement_audit where request_hash = v_hash;
  if found then
    if v_audit.manifest_hash is distinct from v_manifest or v_audit.mountain_route_id is distinct from v_current.id
      or v_audit.mountain_id is distinct from v_mountain.id
      or v_audit.new_route is distinct from to_jsonb(v_current)
      or v_audit.new_provenance is distinct from to_jsonb(v_provenance)
    then raise exception 'REPLACEMENT_COMMITTED_STATE_DRIFT'; end if;
    return query select 'UNCHANGED'::text, v_current.id; return;
  end if;
  if exists (select 1 from public.generated_route_replacement_audit a where a.mountain_route_id = v_current.id)
    or to_jsonb(v_current) is distinct from to_jsonb(jsonb_populate_record(null::public.mountain_routes, v_request -> 'expectedOldRoute'))
    or to_jsonb(v_provenance) is distinct from to_jsonb(jsonb_populate_record(null::public.generated_route_publication_provenance, v_request -> 'expectedOldProvenance'))
    or v_provenance.publication_status is distinct from 'ACTIVE'
    or not exists (select 1 from public.generated_route_publication_approvals a where a.publication_id = v_provenance.publication_id and a.request_hash = v_provenance.request_hash)
  then raise exception 'REPLACEMENT_EXPECTED_OLD_STATE_DRIFT'; end if;

  if v_new ->> 'contract' is distinct from 'mountain-tracker-generated-route-publication/v1'
    or coalesce(v_new ->> 'publicationId','') !~ '^[a-f0-9]{64}$'
    or v_new ->> 'publicationId' is not distinct from v_provenance.publication_id
    or v_new ->> 'publicationIdempotencyKey' is distinct from 'mountain-tracker-generated-route-publication/v1:' || (v_new ->> 'publicationId')
    or v_evidence ->> 'startRole' is distinct from 'PRIMARY_BASE_ACCESS'
    or v_evidence #>> '{accessEvidence,policyVersion}' is distinct from 'mountain-tracker/base-access-start-policy/v2'
    or v_evidence #>> '{safety,decision}' is distinct from 'SAFE'
    or v_evidence #> '{safety,connected}' is distinct from 'true'::jsonb
    or v_evidence #> '{safety,deterministic}' is distinct from 'true'::jsonb
    or v_evidence #> '{safety,fabricatedGapCount}' is distinct from '0'::jsonb
    or v_evidence ->> 'startContext' is distinct from 'BASE_START'
    or coalesce(v_evidence ->> 'routeCategory','') not in ('STANDARD_ASCENT','REMOTE_APPROACH')
    or coalesce(v_evidence #>> '{summitAttachment,tier}','') not in ('DIRECT','EXTENDED')
    or v_evidence #> '{summitAttachment,autoEligible}' is distinct from 'true'::jsonb
    or v_evidence ->> 'publicationStatus' is distinct from 'ACTIVE'
    or v_evidence ->> 'storageBucket' is distinct from 'route-gpx'
    or v_route -> 'is_verified' is distinct from 'true'::jsonb
    or v_route ->> 'route_type' is distinct from 'hiking'
    or v_route ->> 'source_name' is distinct from 'OpenStreetMap'
    or v_route ->> 'source_url' is distinct from 'https://www.openstreetmap.org/copyright'
    or (v_route ->> 'distance_km')::numeric is distinct from (v_request ->> 'preciseDistanceKm')::numeric
    or round((v_route ->> 'distance_km')::numeric,2) is distinct from (v_request ->> 'productionDistanceKm')::numeric
    or coalesce((v_route ->> 'distance_km')::numeric,0) not between 0.01 and 100
    or v_mountain.osm_id is distinct from (v_evidence #>> '{summit,osmId}')::bigint
    or v_evidence #>> '{summit,osmObjectType}' is distinct from 'node'
    or abs(v_mountain.longitude - (v_evidence #>> '{summit,coordinate,0}')::double precision) > 0.00005
    or abs(v_mountain.latitude - (v_evidence #>> '{summit,coordinate,1}')::double precision) > 0.00005
  then raise exception 'REPLACEMENT_V2_CONTRACT_INVALID'; end if;
  foreach v_field in array array['difficulty_system','difficulty_value','elevation_gain_m','duration_minutes','description','best_season','equipment','warnings','created_by'] loop
    if v_route -> v_field is distinct from 'null'::jsonb then raise exception 'REPLACEMENT_UNKNOWN_METRIC:%',v_field; end if;
  end loop;

  -- Metadata is checked here; the bounded executor must also hash fetched bytes
  -- and verify public delivery before invoking this RPC. No Storage DELETE exists.
  foreach v_kind in array array['gpx','geojson'] loop
    if v_evidence #>> array['storagePaths',v_kind] is distinct from 'generated/' || (v_new ->> 'publicationId') || '/route.' || v_kind
      or v_route ->> (v_kind || '_url') is not distinct from v_request #>> array['expectedOldRoute',v_kind || '_url']
      or v_route ->> (v_kind || '_url') is distinct from
        split_part(v_request #>> array['expectedOldRoute',v_kind || '_url'], '/storage/v1/object/public/route-gpx/', 1)
        || '/storage/v1/object/public/route-gpx/' || (v_evidence #>> array['storagePaths',v_kind])
      or coalesce(v_evidence ->> (v_kind || 'Sha256'),'') !~ '^[a-f0-9]{64}$'
      or coalesce((v_evidence ->> (v_kind || 'Bytes'))::bigint,0) not between 1 and 10485760
    then raise exception 'REPLACEMENT_STORAGE_MAPPING_INVALID'; end if;
    select * into strict v_object from storage.objects where bucket_id = 'route-gpx' and name = v_evidence #>> array['storagePaths',v_kind] for share;
   if (v_object.metadata ->> 'size')::bigint
     is distinct from (v_evidence ->> (v_kind || 'Bytes'))::bigint
  or split_part(v_object.metadata ->> 'mimetype', ';', 1)
     is distinct from (
       case
         when v_kind = 'gpx' then 'application/gpx+xml'
         else 'application/geo+json'
       end
     )
then
  raise exception 'REPLACEMENT_STORAGE_METADATA_MISMATCH';
end if;
  end loop;

  v_old_route := to_jsonb(v_current); v_old_provenance := to_jsonb(v_provenance);
  -- The old approval remains. The new approval and route/provenance/audit switch
  -- commit together; a failure rolls all database changes back.
  insert into public.generated_route_publication_approvals(publication_id,request_hash,manifest_hash)
    values (v_new ->> 'publicationId',v_request ->> 'newPublicationRequestHash',v_manifest);
  update public.mountain_routes set
    name = v_route ->> 'name', start_location = v_route ->> 'start_location',
    distance_km = (v_route ->> 'distance_km')::numeric,
    gpx_url = v_route ->> 'gpx_url', geojson_url = v_route ->> 'geojson_url',
    is_verified = true, updated_at = now()
    where id = v_approval.mountain_route_id and mountain_id = v_approval.mountain_id and mountain_id <> 50473
    returning * into strict v_current;
  update public.generated_route_publication_provenance p set
    publication_id = v_new ->> 'publicationId', publication_idempotency_key = v_new ->> 'publicationIdempotencyKey',
    generated_route_identity = v_evidence ->> 'generatedRouteIdentity', dataset_fingerprint = v_evidence ->> 'datasetFingerprint',
    request_hash = v_request ->> 'newPublicationRequestHash', canonical_request = v_new
    where p.id = v_provenance.id and p.mountain_route_id = v_current.id and p.mountain_id = v_mountain.id and p.mountain_id <> 50473
    returning p.* into strict v_provenance;
  if (to_jsonb(v_current) - array['id','created_at','updated_at']) is distinct from
      jsonb_set(v_route,'{distance_km}',to_jsonb((v_request ->> 'productionDistanceKm')::numeric))
    or v_current.id is distinct from v_approval.mountain_route_id or v_current.mountain_id is distinct from v_approval.mountain_id
    or v_provenance.publication_status is distinct from 'ACTIVE' or v_provenance.canonical_request is distinct from v_new
  then raise exception 'REPLACEMENT_POST_UPDATE_MISMATCH'; end if;
  insert into public.generated_route_replacement_audit(request_hash,manifest_hash,mountain_id,mountain_route_id,old_route,old_provenance,new_route,new_provenance)
    values (v_hash,v_manifest,v_mountain.id,v_current.id,v_old_route,v_old_provenance,to_jsonb(v_current),to_jsonb(v_provenance));
  return query select 'REPLACED'::text,v_current.id;
end;
$function$;
revoke all on function public.replace_approved_generated_mountain_route(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.replace_approved_generated_mountain_route(jsonb) to service_role;
comment on function public.replace_approved_generated_mountain_route(jsonb) is
  'Nine manually approved V2 replacements only. Exact manifest/request and old-state CAS, immutable 50473, same route row, append-only audit, idempotent retry, no Storage mutations.';
commit;
