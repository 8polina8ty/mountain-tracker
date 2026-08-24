-- REVIEWED MANUAL REPAIR ARTIFACT. Do not execute automatically.
-- This phase preserves all existing mountain_community_routes rows. It is for
-- the confirmed old/partial deployment, not for a clean database.

alter table public.mountain_community_routes
  add column if not exists summary text,
  add column if not exists description text,
  add column if not exists start_location text,
  add column if not exists route_type text,
  add column if not exists difficulty_system text,
  add column if not exists difficulty_value text,
  add column if not exists best_season text,
  add column if not exists equipment text,
  add column if not exists warnings text,
  add column if not exists conditions_notes text,
  add column if not exists published_geojson_path text;

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conname = 'mountain_community_routes_route_type_check'
      and conrelid = 'public.mountain_community_routes'::regclass
  ) then
    alter table public.mountain_community_routes
      add constraint mountain_community_routes_route_type_check
      check (
        route_type is null or route_type in (
          'hiking', 'mountaineering', 'via_ferrata', 'climbing',
          'ski_touring', 'mixed', 'other'
        )
      ) not valid;
  end if;
end;
$$;

alter table public.mountain_community_routes
  validate constraint mountain_community_routes_route_type_check;

alter table public.mountain_community_routes enable row level security;

revoke all privileges on table public.mountain_community_routes
  from anon, authenticated;

drop policy if exists mountain_community_routes_public_select
  on public.mountain_community_routes;
drop policy if exists mountain_community_routes_owner_delete
  on public.mountain_community_routes;

-- Public metadata is available only through these explicit safe projections.
create or replace function public.list_published_mountain_community_routes(
  requested_mountain_id bigint,
  requested_limit integer default 10,
  requested_offset integer default 0
)
returns table (
  id uuid, mountain_id bigint, title text, summary text,
  author_display_name text, distance_m integer, elevation_gain_m integer,
  duration_seconds integer, validation_distance_m integer,
  validation_confidence numeric, route_type text, difficulty_system text,
  difficulty_value text, published_at timestamptz, updated_at timestamptz,
  total_count bigint
)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if requested_mountain_id is null or requested_mountain_id <= 0 then
    raise exception 'invalid mountain id' using errcode = '22023';
  end if;
  if requested_limit is null or requested_offset is null or requested_offset < 0 then
    raise exception 'invalid pagination' using errcode = '22023';
  end if;
  return query
  select route.id, route.mountain_id, route.title, route.summary,
    route.author_name as author_display_name, route.distance_m,
    route.elevation_gain_m, route.duration_seconds,
    route.validation_distance_m, route.validation_confidence, route.route_type,
    route.difficulty_system, route.difficulty_value, route.published_at,
    route.updated_at, count(*) over () as total_count
  from public.mountain_community_routes as route
  where route.status = 'published' and route.mountain_id = requested_mountain_id
  order by route.published_at desc, route.id
  limit least(greatest(requested_limit, 0), 50)
  offset requested_offset;
end;
$$;

create or replace function public.get_published_mountain_community_route(
  requested_route_id uuid,
  requested_mountain_id bigint
)
returns table (
  id uuid, mountain_id bigint, title text, summary text, description text,
  start_location text, route_type text, difficulty_system text,
  difficulty_value text, best_season text, equipment text, warnings text,
  conditions_notes text, author_display_name text, distance_m integer,
  elevation_gain_m integer, duration_seconds integer,
  validation_distance_m integer, validation_confidence numeric,
  published_at timestamptz, updated_at timestamptz
)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if requested_route_id is null or requested_mountain_id is null or requested_mountain_id <= 0 then
    raise exception 'invalid route identity' using errcode = '22023';
  end if;
  return query
  select route.id, route.mountain_id, route.title, route.summary,
    route.description, route.start_location, route.route_type,
    route.difficulty_system, route.difficulty_value, route.best_season,
    route.equipment, route.warnings, route.conditions_notes,
    route.author_name as author_display_name, route.distance_m,
    route.elevation_gain_m, route.duration_seconds,
    route.validation_distance_m, route.validation_confidence,
    route.published_at, route.updated_at
  from public.mountain_community_routes as route
  where route.id = requested_route_id
    and route.mountain_id = requested_mountain_id
    and route.status = 'published';
end;
$$;

revoke all on function public.list_published_mountain_community_routes(bigint, integer, integer) from public;
revoke all on function public.get_published_mountain_community_route(uuid, bigint) from public;
grant execute on function public.list_published_mountain_community_routes(bigint, integer, integer) to anon, authenticated;
grant execute on function public.get_published_mountain_community_route(uuid, bigint) to anon, authenticated;

do $$
begin
  if not exists (
    select 1 from storage.buckets where id = 'community-route-tracks'
  ) then
    raise exception 'community-route-tracks bucket is missing; stop and reconcile manually';
  end if;
end;
$$;

update storage.buckets
set public = false,
    allowed_mime_types = array[
      'application/gpx+xml', 'application/xml', 'text/xml',
      'application/octet-stream', 'application/geo+json'
    ]
where id = 'community-route-tracks';

-- Deliberately no storage.objects policy is created. Snapshot reads and writes
-- remain limited to reviewed service-role server paths.
