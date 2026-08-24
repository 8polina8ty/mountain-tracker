-- REVIEWED MANUAL OPERATIONAL REPAIR ARTIFACT. Do not execute automatically.
-- Installs a service-role-only helper for recovering missing association rows on
-- an existing published route whose immutable GPX and GeoJSON paths are intact.
-- This helper never updates or deletes the route or any Storage object.

begin;

create or replace function public.repair_mountain_community_route_associations(
  requested_route_id uuid,
  requested_associations jsonb
)
returns void
language plpgsql volatile security invoker set search_path = ''
as $$
declare
  route_mountain_id bigint;
  route_status text;
  route_gpx_path text;
  route_geojson_path text;
  association_count integer;
  distinct_mountain_count integer;
  primary_count integer;
  primary_mountain_id bigint;
begin
  if requested_route_id is null then
    raise exception 'invalid recovery route id' using errcode = '22023';
  end if;

  if pg_catalog.jsonb_typeof(requested_associations) is distinct from 'array' or
     pg_catalog.jsonb_array_length(requested_associations) = 0 then
    raise exception 'invalid recovery associations' using errcode = '22023';
  end if;

  select
    route.mountain_id,
    route.status,
    route.published_gpx_path,
    route.published_geojson_path
  into
    route_mountain_id,
    route_status,
    route_gpx_path,
    route_geojson_path
  from public.mountain_community_routes as route
  where route.id = requested_route_id
  for update;

  if not found then
    raise exception 'recovery route does not exist' using errcode = '22023';
  end if;

  if route_status <> 'published' or
     route_gpx_path is distinct from (requested_route_id::text || '/route.gpx') or
     route_geojson_path is distinct from (requested_route_id::text || '/route.geojson') then
    raise exception 'route is not eligible for immutable association recovery' using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.mountain_community_route_mountains as existing_association
    where existing_association.route_id = requested_route_id
  ) then
    raise exception 'route associations already exist; manual review required' using errcode = '22023';
  end if;

  select
    pg_catalog.count(*),
    pg_catalog.count(distinct association.mountain_id),
    pg_catalog.count(*) filter (where association.is_primary),
    pg_catalog.max(association.mountain_id) filter (where association.is_primary)
  into
    association_count,
    distinct_mountain_count,
    primary_count,
    primary_mountain_id
  from pg_catalog.jsonb_to_recordset(requested_associations) as association(
    mountain_id bigint,
    distance_m integer,
    confidence numeric,
    is_primary boolean
  );

  if association_count <> distinct_mountain_count or
     primary_count <> 1 or
     primary_mountain_id <> route_mountain_id then
    raise exception 'invalid recovery association cardinality' using errcode = '22023';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_to_recordset(requested_associations) as association(
      mountain_id bigint,
      distance_m integer,
      confidence numeric,
      is_primary boolean
    )
    where association.mountain_id is null or association.mountain_id <= 0 or
      association.distance_m is null or association.distance_m < 0 or
      association.confidence is null or association.confidence < 0 or association.confidence > 1 or
      association.is_primary is null or
      (association.is_primary and association.distance_m > 300) or
      (not association.is_primary and (
        association.distance_m > 100 or association.confidence < 0.75
      ))
  ) then
    raise exception 'invalid recovery association values' using errcode = '22023';
  end if;

  insert into public.mountain_community_route_mountains (
    route_id, mountain_id, distance_m, confidence, is_primary
  )
  select
    requested_route_id,
    association.mountain_id,
    association.distance_m,
    association.confidence,
    association.is_primary
  from pg_catalog.jsonb_to_recordset(requested_associations) as association(
    mountain_id bigint,
    distance_m integer,
    confidence numeric,
    is_primary boolean
  );
end;
$$;

revoke all on function public.repair_mountain_community_route_associations(
  uuid, jsonb
) from public, anon, authenticated;

grant execute on function public.repair_mountain_community_route_associations(
  uuid, jsonb
) to service_role;

commit;
