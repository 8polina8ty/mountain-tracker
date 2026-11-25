-- MANUAL DEPLOYMENT ONLY. Apply after database/mountain_countries.sql and border seed.
-- Replaces country progress + list RPCs to use mountain_countries membership.
-- Keep mountains.country_code as legacy primary; do not alter it.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Same definitions as in auth_country_progress.sql after multi-country migration
create or replace function public.get_my_country_mountain_progress()
returns jsonb language plpgsql stable security definer set search_path = ''
as $fn$
declare actor uuid := auth.uid(); country text; result jsonb;
begin
  if actor is null then raise exception 'auth_required' using errcode = '42501'; end if;
  select p.country_code into country from public.profiles p where p.id = actor;
  if not public.is_residence_country(country) then
    return pg_catalog.jsonb_build_object('countryCode', null, 'totalMountains', 0,
      'climbedMountains', 0, 'remainingMountains', 0, 'progressPercent', null);
  end if;
  with eligible as (
    select m.id from public.mountains m
    where exists (select 1 from public.mountain_countries mc where mc.mountain_id = m.id and mc.country_code = country)
  ),
  totals as (
    select (select count(distinct id) from eligible) as total,
      (select count(distinct a.mountain_id) from public.ascents a
        join eligible e on e.id = a.mountain_id where a.user_id = actor) as climbed
  ) select pg_catalog.jsonb_build_object('countryCode', country, 'totalMountains', total,
    'climbedMountains', climbed, 'remainingMountains', greatest(total - climbed, 0),
    'progressPercent', case when total > 0 then climbed::numeric / total * 100 else null end)
  into result from totals;
  return result;
end;
$fn$;

create or replace function public.list_my_country_mountains(
  search text default '', min_height double precision default null, max_height double precision default null,
  climbed_filter text default 'all', after_id bigint default null, result_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path = ''
as $fn$
declare actor uuid := auth.uid(); country text; result jsonb;
  page_size integer := least(greatest(coalesce(result_limit, 20), 1), 50);
begin
  if actor is null then raise exception 'auth_required' using errcode = '42501'; end if;
  if char_length(coalesce(search, '')) > 100 or climbed_filter is null or climbed_filter not in ('all','climbed','unclimbed')
    or (min_height is not null and min_height::text in ('NaN','Infinity','-Infinity'))
    or (max_height is not null and max_height::text in ('NaN','Infinity','-Infinity'))
    or min_height > max_height then raise exception 'filters_invalid' using errcode = '22023'; end if;
  select p.country_code into country from public.profiles p where p.id = actor;
  if not public.is_residence_country(country) then
    return pg_catalog.jsonb_build_object('countryCode', null, 'items', '[]'::jsonb, 'nextCursor', null); end if;
  with candidates as (
    select m.id, m.name, m.name_de, m.height, m.country_code,
      exists (select 1 from public.ascents a where a.user_id = actor and a.mountain_id = m.id) as climbed
    from public.mountains m where exists (select 1 from public.mountain_countries mc where mc.mountain_id = m.id and mc.country_code = country)
      and (after_id is null or m.id > after_id)
      and (min_height is null or m.height >= min_height) and (max_height is null or m.height <= max_height)
      and (coalesce(pg_catalog.btrim(search), '') = ''
        or pg_catalog.strpos(pg_catalog.lower(coalesce(m.name, '')), pg_catalog.lower(pg_catalog.btrim(search))) > 0
        or pg_catalog.strpos(pg_catalog.lower(coalesce(m.name_de, '')), pg_catalog.lower(pg_catalog.btrim(search))) > 0)
  ), window_rows as (
    select * from candidates where climbed_filter = 'all'
      or (climbed_filter = 'climbed' and climbed) or (climbed_filter = 'unclimbed' and not climbed)
    order by id limit page_size + 1
  ), page_rows as (select * from window_rows order by id limit page_size)
  select pg_catalog.jsonb_build_object('countryCode', country,
    'items', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', id::text, 'name', name, 'nameDe', name_de, 'height', height,
      'countryCode', country, 'climbed', climbed) order by id) from page_rows), '[]'::jsonb),
    'nextCursor', case when (select count(*) from window_rows) > page_size
      then (select max(id)::text from page_rows) else null end) into result;
  return result;
end;
$fn$;

alter function public.get_my_country_mountain_progress() owner to postgres;
alter function public.list_my_country_mountains(text,double precision,double precision,text,bigint,integer) owner to postgres;
revoke all on function public.get_my_country_mountain_progress(), public.list_my_country_mountains(text,double precision,double precision,text,bigint,integer) from public, anon, authenticated;
grant execute on function public.get_my_country_mountain_progress(), public.list_my_country_mountains(text,double precision,double precision,text,bigint,integer) to authenticated;

notify pgrst, 'reload schema';
commit;
