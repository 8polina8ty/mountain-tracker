-- REVIEWED MANUAL REPAIR ARTIFACT. Do not execute automatically.
-- Adds an atomic server-only publication boundary without changing existing rows.

create or replace function public.publish_mountain_community_route(
  requested_route_id uuid,
  requested_mountain_id bigint,
  requested_gps_activity_id bigint,
  requested_user_id uuid,
  requested_title text,
  requested_summary text,
  requested_description text,
  requested_start_location text,
  requested_route_type text,
  requested_difficulty_system text,
  requested_difficulty_value text,
  requested_best_season text,
  requested_equipment text,
  requested_warnings text,
  requested_conditions_notes text,
  requested_author_name text,
  requested_validation_distance_m integer,
  requested_validation_confidence numeric,
  requested_distance_m integer,
  requested_elevation_gain_m integer,
  requested_duration_seconds integer,
  requested_activity_date timestamptz,
  requested_published_gpx_path text,
  requested_published_geojson_path text,
  requested_associations jsonb
)
returns table (
  id uuid,
  mountain_id bigint,
  title text,
  author_name text,
  validation_distance_m integer,
  validation_confidence numeric,
  distance_m integer,
  elevation_gain_m integer,
  duration_seconds integer,
  activity_date timestamptz,
  published_at timestamptz
)
language plpgsql volatile security invoker set search_path = ''
as $$
declare
  association_count integer;
  distinct_mountain_count integer;
  primary_count integer;
  primary_distance_m integer;
  primary_confidence numeric;
begin
  if requested_route_id is null or
     requested_mountain_id is null or requested_mountain_id <= 0 or
     requested_gps_activity_id is null or requested_gps_activity_id <= 0 or
     requested_user_id is null then
    raise exception 'invalid publication identity' using errcode = '22023';
  end if;

  if requested_title is null or
     pg_catalog.char_length(requested_title) not between 1 and 120 or
     requested_title <> pg_catalog.btrim(requested_title) or
     requested_author_name is null or
     pg_catalog.char_length(requested_author_name) not between 1 and 80 then
    raise exception 'invalid publication text identity' using errcode = '22023';
  end if;

  if pg_catalog.char_length(requested_summary) > 300 or
     pg_catalog.char_length(requested_description) > 8000 or
     pg_catalog.char_length(requested_start_location) > 200 or
     pg_catalog.char_length(requested_difficulty_system) > 40 or
     pg_catalog.char_length(requested_difficulty_value) > 40 or
     pg_catalog.char_length(requested_best_season) > 500 or
     pg_catalog.char_length(requested_equipment) > 4000 or
     pg_catalog.char_length(requested_warnings) > 4000 or
     pg_catalog.char_length(requested_conditions_notes) > 4000 then
    raise exception 'invalid publication content' using errcode = '22023';
  end if;

  if requested_route_type is not null and requested_route_type not in (
    'hiking', 'mountaineering', 'via_ferrata', 'climbing',
    'ski_touring', 'mixed', 'other'
  ) then
    raise exception 'invalid publication route type' using errcode = '22023';
  end if;

  if requested_validation_distance_m is null or
     requested_validation_distance_m not between 0 and 300 or
     requested_validation_confidence is null or
     requested_validation_confidence < 0.75 or requested_validation_confidence > 1 or
     requested_distance_m is null or requested_distance_m < 0 or
     requested_elevation_gain_m is null or requested_elevation_gain_m < 0 or
     requested_duration_seconds < 0 then
    raise exception 'invalid publication metrics' using errcode = '22023';
  end if;

  if requested_published_gpx_path is distinct from (requested_route_id::text || '/route.gpx') or
     requested_published_geojson_path is distinct from (requested_route_id::text || '/route.geojson') then
    raise exception 'invalid publication snapshot paths' using errcode = '22023';
  end if;

  if pg_catalog.jsonb_typeof(requested_associations) is distinct from 'array' or
     pg_catalog.jsonb_array_length(requested_associations) = 0 then
    raise exception 'invalid publication associations' using errcode = '22023';
  end if;

  select
    pg_catalog.count(*),
    pg_catalog.count(distinct association.mountain_id),
    pg_catalog.count(*) filter (where association.is_primary),
    pg_catalog.max(association.distance_m) filter (where association.is_primary),
    pg_catalog.max(association.confidence) filter (where association.is_primary)
  into
    association_count,
    distinct_mountain_count,
    primary_count,
    primary_distance_m,
    primary_confidence
  from pg_catalog.jsonb_to_recordset(requested_associations) as association(
    mountain_id bigint,
    distance_m integer,
    confidence numeric,
    is_primary boolean
  );

  if association_count <> distinct_mountain_count or primary_count <> 1 then
    raise exception 'invalid publication association cardinality' using errcode = '22023';
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
      association.confidence is null or association.confidence < 0.75 or association.confidence > 1 or
      association.is_primary is null or
      (association.is_primary and (
        association.mountain_id <> requested_mountain_id or association.distance_m > 300
      )) or
      (not association.is_primary and association.distance_m > 100)
  ) then
    raise exception 'invalid publication association values' using errcode = '22023';
  end if;

  if primary_distance_m <> requested_validation_distance_m or
     primary_confidence <> requested_validation_confidence then
    raise exception 'primary association does not match validation' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.gps_activities as activity
    where activity.id = requested_gps_activity_id
      and activity.user_id = requested_user_id
      and activity.processing_status = 'ready'
  ) then
    raise exception 'invalid publication activity ownership' using errcode = '22023';
  end if;

  return query
  with inserted_route as (
    insert into public.mountain_community_routes (
      id, mountain_id, gps_activity_id, user_id, title, summary, description,
      start_location, route_type, difficulty_system, difficulty_value,
      best_season, equipment, warnings, conditions_notes, author_name,
      validation_distance_m, validation_confidence, distance_m,
      elevation_gain_m, duration_seconds, activity_date, status,
      published_gpx_path, published_geojson_path
    ) values (
      requested_route_id, requested_mountain_id, requested_gps_activity_id,
      requested_user_id, requested_title, requested_summary, requested_description,
      requested_start_location, requested_route_type, requested_difficulty_system,
      requested_difficulty_value, requested_best_season, requested_equipment,
      requested_warnings, requested_conditions_notes, requested_author_name,
      requested_validation_distance_m, requested_validation_confidence,
      requested_distance_m, requested_elevation_gain_m, requested_duration_seconds,
      requested_activity_date, 'published', requested_published_gpx_path,
      requested_published_geojson_path
    )
    returning
      mountain_community_routes.id,
      mountain_community_routes.mountain_id,
      mountain_community_routes.title,
      mountain_community_routes.author_name,
      mountain_community_routes.validation_distance_m,
      mountain_community_routes.validation_confidence,
      mountain_community_routes.distance_m,
      mountain_community_routes.elevation_gain_m,
      mountain_community_routes.duration_seconds,
      mountain_community_routes.activity_date,
      mountain_community_routes.published_at
  ),
  inserted_associations as (
    insert into public.mountain_community_route_mountains (
      route_id, mountain_id, distance_m, confidence, is_primary
    )
    select
      inserted_route.id,
      association.mountain_id,
      association.distance_m,
      association.confidence,
      association.is_primary
    from inserted_route
    cross join pg_catalog.jsonb_to_recordset(requested_associations) as association(
      mountain_id bigint,
      distance_m integer,
      confidence numeric,
      is_primary boolean
    )
    returning mountain_community_route_mountains.route_id
  )
  select inserted_route.*
  from inserted_route
  where exists (select 1 from inserted_associations);
end;
$$;

revoke all on function public.publish_mountain_community_route(
  uuid, bigint, bigint, uuid, text, text, text, text, text, text, text, text,
  text, text, text, text, integer, numeric, integer, integer, integer,
  timestamptz, text, text, jsonb
) from public, anon, authenticated;

grant execute on function public.publish_mountain_community_route(
  uuid, bigint, bigint, uuid, text, text, text, text, text, text, text, text,
  text, text, text, text, integer, numeric, integer, integer, integer,
  timestamptz, text, text, jsonb
) to service_role;

create or replace function public.finalize_mountain_community_route_backfill(
  requested_route_id uuid,
  requested_published_geojson_path text,
  requested_associations jsonb
)
returns void
language plpgsql volatile security invoker set search_path = ''
as $$
declare
  route_mountain_id bigint;
  association_count integer;
  distinct_mountain_count integer;
  primary_count integer;
  primary_mountain_id bigint;
begin
  if requested_route_id is null or
     requested_published_geojson_path is distinct from (
       requested_route_id::text || '/route.geojson'
     ) then
    raise exception 'invalid backfill identity or snapshot path' using errcode = '22023';
  end if;

  if pg_catalog.jsonb_typeof(requested_associations) is distinct from 'array' or
     pg_catalog.jsonb_array_length(requested_associations) = 0 then
    raise exception 'invalid backfill associations' using errcode = '22023';
  end if;

  select route.mountain_id
  into route_mountain_id
  from public.mountain_community_routes as route
  where route.id = requested_route_id
    and route.status = 'published'
    and route.published_geojson_path is null
  for update;

  if not found then
    raise exception 'route is not eligible for GeoJSON backfill' using errcode = '22023';
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
    raise exception 'invalid backfill association cardinality' using errcode = '22023';
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
      association.is_primary is null
  ) then
    raise exception 'invalid backfill association values' using errcode = '22023';
  end if;

  update public.mountain_community_routes as route
  set published_geojson_path = requested_published_geojson_path,
      updated_at = pg_catalog.now()
  where route.id = requested_route_id
    and route.status = 'published'
    and route.published_geojson_path is null;

  if not found then
    raise exception 'route GeoJSON backfill update failed' using errcode = '40001';
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
  )
  on conflict (route_id, mountain_id) do update
  set distance_m = excluded.distance_m,
      confidence = excluded.confidence,
      is_primary = excluded.is_primary;
end;
$$;

revoke all on function public.finalize_mountain_community_route_backfill(
  uuid, text, jsonb
) from public, anon, authenticated;

grant execute on function public.finalize_mountain_community_route_backfill(
  uuid, text, jsonb
) to service_role;
