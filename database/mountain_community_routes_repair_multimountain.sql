-- REVIEWED MANUAL REPAIR ARTIFACT. Do not execute automatically.
-- This artifact adds multi-mountain association support to the already-deployed
-- mountain_community_routes schema (after Phase 1 repair has been applied).
-- It preserves all existing route rows and is safe against the current deployed state.

begin;

-- 1. Create the relation table if it doesn't exist
create table if not exists public.mountain_community_route_mountains (
  route_id uuid not null references public.mountain_community_routes(id) on delete cascade,
  mountain_id bigint not null references public.mountains(id) on delete cascade,
  distance_m integer not null check (distance_m >= 0),
  confidence numeric(5,4) not null check (confidence between 0 and 1),
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (route_id, mountain_id)
);

-- 2. Install FKs, checks, indexes safely
create unique index if not exists mountain_community_route_mountains_primary_unique
  on public.mountain_community_route_mountains (route_id)
  where is_primary;

-- 3. Enable RLS on relation table
alter table public.mountain_community_route_mountains enable row level security;

-- 4. Revoke ALL privileges from browser roles
revoke all privileges on table public.mountain_community_route_mountains
  from anon, authenticated;

-- 5. Create no public table policies on relation table (access only through safe RPCs)

-- 6. Adapt safe list/detail RPCs to use the relation table
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
  inner join public.mountain_community_route_mountains as assoc
    on assoc.route_id = route.id
  where route.status = 'published'
    and assoc.mountain_id = requested_mountain_id
  order by route.published_at desc, route.id
  limit least(greatest(requested_limit, 0), 50)
  offset requested_offset;
end;
$$;

drop function if exists public.get_published_mountain_community_route(uuid, bigint);

create function public.get_published_mountain_community_route(
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
  published_at timestamptz, updated_at timestamptz,
  associated_mountains jsonb
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
    route.published_at, route.updated_at,
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'mountain_id', assoc.mountain_id,
        'distance_m', assoc.distance_m,
        'confidence', assoc.confidence,
        'is_primary', assoc.is_primary
      ) order by assoc.is_primary desc, assoc.distance_m)
      from public.mountain_community_route_mountains as assoc
      inner join public.mountains as m on m.id = assoc.mountain_id
      where assoc.route_id = route.id
    ), '[]'::jsonb) as associated_mountains
  from public.mountain_community_routes as route
  inner join public.mountain_community_route_mountains as assoc
    on assoc.route_id = route.id
  where route.id = requested_route_id
    and assoc.mountain_id = requested_mountain_id
    and route.status = 'published';
end;
$$;

-- 7. Revoke/grant execute on updated RPCs
revoke all on function public.list_published_mountain_community_routes(bigint, integer, integer) from public;
revoke all on function public.get_published_mountain_community_route(uuid, bigint) from public;
grant execute on function public.list_published_mountain_community_routes(bigint, integer, integer) to anon, authenticated;
grant execute on function public.get_published_mountain_community_route(uuid, bigint) to anon, authenticated;

-- 8. Preserve all existing route rows - no data manipulation here.
--    The backfill script will populate the relation table.
--    This artifact does NOT require relation rows to already exist before the backfill.

commit;
