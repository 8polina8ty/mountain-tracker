-- MANUAL REVIEW / MANUAL DEPLOYMENT ONLY. DO NOT APPLY in the preparation task.
-- Additive generated-route contract. No changes to Phase 11 or mountain_routes.
-- Apply with the separately reviewed generated_route_canary_approval.sql only
-- after checking deployed catalog/grants. Infrastructure deployment publishes 0 routes.
begin;

create table public.generated_route_publication_approvals (
  publication_id text primary key check (publication_id ~ '^[a-f0-9]{64}$'),
  request_hash text not null unique check (request_hash ~ '^[a-f0-9]{64}$'),
  manifest_hash text not null check (manifest_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now()
);
alter table public.generated_route_publication_approvals enable row level security;
revoke all on public.generated_route_publication_approvals from public, anon, authenticated, service_role;
grant select on public.generated_route_publication_approvals to service_role;

create table public.generated_route_publication_provenance (
  id uuid primary key default gen_random_uuid(),
  mountain_route_id bigint not null unique references public.mountain_routes(id) on delete restrict,
  mountain_id bigint not null references public.mountains(id) on delete restrict,
  publication_contract_version text not null check (publication_contract_version = 'mountain-tracker-generated-route-publication/v1'),
  publication_idempotency_key text not null unique,
  publication_status text not null check (publication_status = 'ACTIVE'),
  publication_id text not null unique references public.generated_route_publication_approvals(publication_id),
  generated_route_identity text not null,
  dataset_fingerprint text not null check (dataset_fingerprint ~ '^[a-f0-9]{64}$'),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  -- The compact canonical request holds all source, corpus, policies, graph/cache,
  -- summit/start identities, geometry/file hashes, paths, and safety evidence.
  -- It contains NO geometry arrays, raw tracks, credentials, or giant cache data.
  canonical_request jsonb not null check (jsonb_typeof(canonical_request) = 'object'),
  created_at timestamptz not null default now(),
  unique (generated_route_identity, mountain_id, dataset_fingerprint, publication_contract_version)
);
alter table public.generated_route_publication_provenance enable row level security;
revoke all on public.generated_route_publication_provenance from public, anon, authenticated, service_role;
grant select on public.generated_route_publication_provenance to service_role;

create function public.publish_generated_mountain_route(p_request jsonb)
returns table (action text, mountain_route_id bigint)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  v_contract constant text := 'mountain-tracker-generated-route-publication/v1';
  v_text text := p_request ->> 'canonicalRequest';
  v_hash text := p_request ->> 'requestHash';
  v_request jsonb;
  v_route jsonb;
  v_provenance jsonb;
  v_existing public.generated_route_publication_provenance%rowtype;
  v_mountain public.mountains%rowtype;
  v_id bigint;
  v_key text;
  v_field text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'GENERATED_PUBLICATION_SERVICE_ROLE_REQUIRED';
  end if;
  if jsonb_typeof(p_request) is distinct from 'object'
    or not (p_request ?& array['canonicalRequest','requestHash'])
    or (select count(*) from jsonb_object_keys(p_request)) <> 2
    or v_text is null or octet_length(v_text) > 65536
    or v_hash is null or v_hash !~ '^[a-f0-9]{64}$'
    or encode(extensions.digest(convert_to(v_text,'UTF8'),'sha256'),'hex') is distinct from v_hash
  then raise exception 'GENERATED_CANONICAL_REQUEST_INVALID'; end if;
  v_request := v_text::jsonb;
  v_route := v_request -> 'mountainRoute';
  v_provenance := v_request -> 'provenance';
  if jsonb_typeof(v_request) is distinct from 'object'
    or jsonb_typeof(v_route) is distinct from 'object'
    or jsonb_typeof(v_provenance) is distinct from 'object'
    or v_request ->> 'contract' is distinct from v_contract
    or not (v_request ?& array['contract','publicationId','publicationIdempotencyKey','mountainRoute','provenance'])
    or (select count(*) from jsonb_object_keys(v_request)) <> 5
    or v_request ->> 'publicationId' !~ '^[a-f0-9]{64}$'
  then raise exception 'GENERATED_CONTRACT_INVALID'; end if;
  -- Exact canonical-byte approval prevents adding/changing ANY field, unknown
  -- metadata, URL, safety decision, distance, source, identity or file hash.
  -- service_role cannot modify this allowlist. Only a separately authorized
  -- manual deployment can approve a new locked manifest.
  perform 1 from public.generated_route_publication_approvals a
    where a.publication_id = v_request ->> 'publicationId' and a.request_hash = v_hash
    for share;
  if not found then raise exception 'GENERATED_REQUEST_NOT_MANUALLY_APPROVED'; end if;
  v_key := v_contract || ':' || (v_request ->> 'publicationId');
  if v_request ->> 'publicationIdempotencyKey' is distinct from v_key
    or v_provenance ->> 'publicationStatus' is distinct from 'ACTIVE'
    or v_provenance ->> 'storageBucket' is distinct from 'route-gpx'
    or v_provenance #> '{source}' is distinct from
      '{"name":"OpenStreetMap","license":"ODbL-1.0","attribution":"© OpenStreetMap contributors","url":"https://www.openstreetmap.org/copyright"}'::jsonb
    or v_provenance #>> '{safety,decision}' is distinct from 'SAFE'
    or v_provenance #> '{safety,autoEligible}' is distinct from 'true'::jsonb
    or v_provenance #> '{safety,fabricatedGapCount}' is distinct from '0'::jsonb
    or v_provenance #> '{safety,boundaryLimited}' is distinct from 'false'::jsonb
    or v_provenance #> '{safety,connected}' is distinct from 'true'::jsonb
    or v_provenance #> '{safety,deterministic}' is distinct from 'true'::jsonb
    or v_provenance #>> '{safety,solverStatus}' is distinct from 'RECONSTRUCTED'
    or coalesce(v_provenance ->> 'startContext','') not in ('BASE_START','HUT_START')
    or coalesce(v_provenance ->> 'routeCategory','') not in ('STANDARD_ASCENT','HUT_ASCENT')
    or v_provenance ->> 'routeCategory' is distinct from
       (case when v_provenance ->> 'startContext' = 'HUT_START' then 'HUT_ASCENT' else 'STANDARD_ASCENT' end)
    or coalesce(v_provenance #>> '{summitAttachment,tier}','') not in ('DIRECT','EXTENDED')
    or v_provenance #> '{summitAttachment,autoEligible}' is distinct from 'true'::jsonb
  then raise exception 'GENERATED_STRICT_GATE_FAILED'; end if;
  foreach v_field in array array['sourceCandidateHash','resultHash','datasetFingerprint','pilotCorpusHash','adaptivePolicyHash',
    'summitPolicyHash','graphHash','graphCacheIdentityHash','extractionIdentityHash','reconstructionManifestHash',
    'routePathHash','geometryHash','geojsonSha256','gpxSha256'] loop
    if coalesce(v_provenance ->> v_field,'') !~ '^[a-f0-9]{64}$' then raise exception 'GENERATED_HASH_MISSING:%',v_field; end if;
  end loop;
  if not (v_route ?& array['mountain_id','name','start_location','route_type','distance_km','difficulty_system','difficulty_value',
    'elevation_gain_m','duration_minutes','description','best_season','equipment','warnings','created_by','source_name','source_url','is_verified','geojson_url','gpx_url'])
    or (select count(*) from jsonb_object_keys(v_route)) <> 19
    or v_route ->> 'route_type' is distinct from 'hiking'
    or v_route -> 'is_verified' is distinct from 'true'::jsonb
    or v_route ->> 'source_name' is distinct from 'OpenStreetMap'
    or v_route ->> 'source_url' is distinct from 'https://www.openstreetmap.org/copyright'
    or v_route ->> 'start_location' is distinct from v_provenance #>> '{start,name}'
    or v_route ->> 'name' is distinct from (v_provenance #>> '{start,name}') || ' → ' || (v_provenance #>> '{summit,name}')
    or length(btrim(v_provenance #>> '{start,name}')) not between 2 and 200
    or (v_route ->> 'distance_km')::numeric not between 0.000001 and 100
  then raise exception 'GENERATED_MOUNTAIN_ROUTE_MAPPING_INVALID'; end if;
  foreach v_field in array array['difficulty_system','difficulty_value','elevation_gain_m','duration_minutes','description','best_season','equipment','warnings','created_by'] loop
    if v_route -> v_field is distinct from 'null'::jsonb then raise exception 'GENERATED_UNKNOWN_FIELD_MUST_BE_NULL:%',v_field; end if;
  end loop;
  foreach v_field in array array['geojson','gpx'] loop
    if v_provenance #>> array['storagePaths',v_field] is distinct from
         'generated/' || (v_request ->> 'publicationId') || '/route.' || v_field
      or (v_provenance ->> (v_field || 'Bytes'))::bigint not between 1 and 10485760
      or coalesce(v_route ->> (v_field || '_url'),'') !~ '^https://[^/@?#]+/storage/v1/object/public/route-gpx/generated/[a-f0-9]{64}/route\.(gpx|geojson)$'
      or right(v_route ->> (v_field || '_url'),length(v_provenance #>> array['storagePaths',v_field])) is distinct from v_provenance #>> array['storagePaths',v_field]
    then raise exception 'GENERATED_STORAGE_MAPPING_INVALID'; end if;
  end loop;
  -- A mountain row lock serializes this RPC for a mountain, including retries
  -- with changed publication IDs. Phase 11 remains an independent contract;
  -- deployments must not run concurrent unrelated publishers for this canary.
  select * into strict v_mountain from public.mountains where id = (v_route ->> 'mountain_id')::bigint for update;
  if v_mountain.osm_id is distinct from (v_provenance #>> '{summit,osmId}')::bigint
    or v_provenance #>> '{summit,osmObjectType}' is distinct from 'node'
    or abs(v_mountain.longitude - (v_provenance #>> '{summit,coordinate,0}')::double precision) > 0.00005
    or abs(v_mountain.latitude - (v_provenance #>> '{summit,coordinate,1}')::double precision) > 0.00005
  then raise exception 'GENERATED_MOUNTAIN_IDENTITY_DRIFT'; end if;
  select * into v_existing from public.generated_route_publication_provenance where publication_idempotency_key = v_key for update;
  if found then
    if v_existing.request_hash is distinct from v_hash or v_existing.canonical_request is distinct from v_request
      or v_existing.publication_status is distinct from 'ACTIVE'
      or not exists (select 1 from public.mountain_routes m where m.id = v_existing.mountain_route_id
        and (to_jsonb(m) - array['id','created_at','updated_at']) = v_route)
    then raise exception 'GENERATED_CHANGED_HASH_OR_ROW_FAIL_CLOSED'; end if;
    return query select 'UNCHANGED'::text,v_existing.mountain_route_id; return;
  end if;
  if exists (select 1 from public.generated_route_publication_provenance p
    where p.generated_route_identity = v_provenance ->> 'generatedRouteIdentity'
      and p.mountain_id = v_mountain.id and p.dataset_fingerprint = v_provenance ->> 'datasetFingerprint')
    or exists (select 1 from public.mountain_routes m where m.mountain_id = v_mountain.id and m.is_verified)
  then raise exception 'GENERATED_EXISTING_ROUTE_COLLISION'; end if;
  insert into public.mountain_routes (mountain_id,name,start_location,route_type,distance_km,
    difficulty_system,difficulty_value,elevation_gain_m,duration_minutes,description,best_season,equipment,warnings,created_by,
    source_name,source_url,is_verified,geojson_url,gpx_url)
  values (v_mountain.id,v_route->>'name',v_route->>'start_location','hiking',(v_route->>'distance_km')::numeric,
    null,null,null,null,null,null,null,null,null,'OpenStreetMap',v_route->>'source_url',true,v_route->>'geojson_url',v_route->>'gpx_url')
  returning id into v_id;
  insert into public.generated_route_publication_provenance
    (mountain_route_id,mountain_id,publication_contract_version,publication_idempotency_key,publication_status,publication_id,
      generated_route_identity,dataset_fingerprint,request_hash,canonical_request)
  values (v_id,v_mountain.id,v_contract,v_key,'ACTIVE',v_request->>'publicationId',
    v_provenance->>'generatedRouteIdentity',v_provenance->>'datasetFingerprint',v_hash,v_request);
  return query select 'CREATED'::text,v_id;
end;
$function$;
revoke all on function public.publish_generated_mountain_route(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.publish_generated_mountain_route(jsonb) to service_role;
comment on function public.publish_generated_mountain_route(jsonb) is
  'Exact manually approved generated canary request; service-only, atomic route/provenance insert, unchanged retry, no Storage operations.';
commit;
