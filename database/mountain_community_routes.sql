-- REVIEWED MANUAL-DEPLOYMENT ARTIFACT. Do not execute automatically.
-- Deploy after the canonical gps_activities table and activity-tracks bucket exist.
-- PRE-DEPLOYMENT CHECK: this artifact is intended for a first deployment. Before
-- executing it, confirm that public.mountain_community_routes and the
-- community-route-tracks bucket do not already exist in an incompatible partial
-- state. If either does, stop and reconcile it manually; this artifact does not
-- drop or replace unknown production objects.

create table if not exists public.mountain_community_routes (
  id uuid primary key default gen_random_uuid(),
  mountain_id bigint not null references public.mountains(id) on delete cascade,
  gps_activity_id bigint not null references public.gps_activities(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  summary text check (summary is null or char_length(summary) <= 300),
  description text check (description is null or char_length(description) <= 8000),
  start_location text check (start_location is null or char_length(start_location) <= 200),
  route_type text check (route_type is null or route_type in ('hiking','mountaineering','via_ferrata','climbing','ski_touring','mixed','other')),
  difficulty_system text check (difficulty_system is null or char_length(difficulty_system) <= 40),
  difficulty_value text check (difficulty_value is null or char_length(difficulty_value) <= 40),
  best_season text check (best_season is null or char_length(best_season) <= 500),
  equipment text check (equipment is null or char_length(equipment) <= 4000),
  warnings text check (warnings is null or char_length(warnings) <= 4000),
  conditions_notes text check (conditions_notes is null or char_length(conditions_notes) <= 4000),
  author_name text not null,
  validation_distance_m integer not null check (validation_distance_m between 0 and 300),
  validation_confidence numeric(5,4) not null check (validation_confidence between 0 and 1),
  distance_m integer not null check (distance_m >= 0),
  elevation_gain_m integer not null check (elevation_gain_m >= 0),
  duration_seconds integer check (duration_seconds is null or duration_seconds >= 0),
  activity_date timestamptz,
  status text not null default 'published' check (status in ('published', 'removed')),
  published_gpx_path text not null,
  published_geojson_path text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz not null default now(),
  constraint mountain_community_routes_gps_activity_unique unique (gps_activity_id),
  constraint mountain_community_routes_snapshot_path_unique unique (published_gpx_path),
  constraint mountain_community_routes_geojson_path_unique unique (published_geojson_path)
);

create table if not exists public.mountain_community_route_mountains (
  route_id uuid not null references public.mountain_community_routes(id) on delete cascade,
  mountain_id bigint not null references public.mountains(id) on delete cascade,
  distance_m integer not null check (distance_m >= 0),
  confidence numeric(5,4) not null check (confidence between 0 and 1),
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (route_id, mountain_id)
);

create unique index if not exists mountain_community_route_mountains_primary_unique
  on public.mountain_community_route_mountains (route_id)
  where is_primary;

create index if not exists mountain_community_routes_public_list_idx
  on public.mountain_community_routes (mountain_id, published_at desc, id)
  where status = 'published';

alter table public.mountain_community_routes enable row level security;

drop policy if exists mountain_community_routes_public_select on public.mountain_community_routes;
create policy mountain_community_routes_public_select
  on public.mountain_community_routes for select
  to anon, authenticated
  using (status = 'published' or user_id = auth.uid());

drop policy if exists mountain_community_routes_owner_delete on public.mountain_community_routes;
-- Owner removal is not exposed in this stage. When implemented, use an
-- authenticated server endpoint with an explicit ownership check rather than
-- granting browser DELETE access to the base table.

-- Deliberately no browser INSERT or UPDATE policy. Publication fields are written
-- only by trusted server code after revalidation.

alter table public.mountain_community_route_mountains enable row level security;

revoke all privileges on table public.mountain_community_route_mountains
  from anon, authenticated;

-- No browser policies on the relation table. Public access only through safe RPCs.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'community-route-tracks',
  'community-route-tracks',
  false,
  26214400,
  array['application/gpx+xml', 'application/xml', 'text/xml', 'application/octet-stream', 'application/geo+json']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Deliberately no storage.objects policies for this bucket. The service-role
-- server publication/download paths are the only readers and writers.

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

revoke select, insert, update, delete on public.mountain_community_routes from anon, authenticated;

revoke all on function public.list_published_mountain_community_routes(bigint, integer, integer) from public;
revoke all on function public.get_published_mountain_community_route(uuid, bigint) from public;
grant execute on function public.list_published_mountain_community_routes(bigint, integer, integer) to anon, authenticated;
grant execute on function public.get_published_mountain_community_route(uuid, bigint) to anon, authenticated;
