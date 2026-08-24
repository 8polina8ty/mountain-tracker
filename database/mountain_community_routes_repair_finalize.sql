-- REVIEWED MANUAL FINALIZATION ARTIFACT. Do not execute automatically.
-- Run only after the dry-run has been reviewed and the approved GeoJSON backfill
-- has completed successfully.

do $$
begin
  -- Guard 1: All published routes must have GeoJSON snapshots
  if exists (
    select 1
    from public.mountain_community_routes
    where status = 'published' and published_geojson_path is null
  ) then
    raise exception 'cannot finalize: community routes still lack GeoJSON snapshots';
  end if;

  -- Guard 2: All published routes must have at least one mountain association
  if exists (
    select 1
    from public.mountain_community_routes as r
    where r.status = 'published'
      and not exists (
        select 1 from public.mountain_community_route_mountains as assoc
        where assoc.route_id = r.id
      )
  ) then
    raise exception 'cannot finalize: published community routes missing mountain associations';
  end if;

  -- Guard 3: Every published route must have EXACTLY ONE is_primary=true association
  if exists (
    select 1
    from public.mountain_community_routes as r
    where r.status = 'published'
      and (
        select count(*) from public.mountain_community_route_mountains as assoc
        where assoc.route_id = r.id and assoc.is_primary
      ) <> 1
  ) then
    raise exception 'cannot finalize: published community routes must have exactly one primary mountain association';
  end if;

  -- Guard 4: The primary association mountain_id must equal mountain_community_routes.mountain_id
  if exists (
    select 1
    from public.mountain_community_routes as r
    inner join public.mountain_community_route_mountains as assoc
      on assoc.route_id = r.id and assoc.is_primary
    where r.status = 'published'
      and r.mountain_id <> assoc.mountain_id
  ) then
    raise exception 'cannot finalize: primary association mountain_id does not match route.mountain_id';
  end if;

  -- Guard 5: No duplicate GeoJSON paths
  if exists (
    select published_geojson_path
    from public.mountain_community_routes
    where status = 'published'
    group by published_geojson_path
    having count(*) > 1
  ) then
    raise exception 'cannot finalize: duplicate community route GeoJSON snapshot paths';
  end if;

  -- All guards passed: enforce NOT NULL and final uniqueness
  alter table public.mountain_community_routes
    alter column published_geojson_path set not null;

  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conname = 'mountain_community_routes_geojson_path_unique'
      and conrelid = 'public.mountain_community_routes'::regclass
  ) then
    alter table public.mountain_community_routes
      add constraint mountain_community_routes_geojson_path_unique
      unique (published_geojson_path);
  end if;
end;
$$;
