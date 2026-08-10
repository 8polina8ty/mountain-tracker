-- Achievement System v2, Phase B.
-- Reviewed SQL artifact: apply manually through the project's Supabase SQL workflow.
-- This function is read-only, accepts no user identifier, and remains SECURITY INVOKER
-- so table privileges and row-level security continue to apply to the authenticated caller.

create or replace function public.get_achievement_snapshot()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
with ascent_base as (
  select
    a.id,
    a.mountain_id,
    a.image_url,
    a.gps_activity_id,
    coalesce(a.climbed_at::date, a.created_at::date) as ascent_date,
    case
      when m.height is not null
        and m.height::text not in ('NaN', 'Infinity', '-Infinity')
      then m.height::double precision
      else null
    end as summit_elevation_m,
    nullif(btrim(m.country_code), '') as country_code
  from public.ascents as a
  left join public.mountains as m on m.id = a.mountain_id
  where a.user_id = auth.uid()
),
ascent_totals as (
  select
    count(*)::bigint as records,
    count(distinct mountain_id)::bigint as unique_mountain_ids,
    coalesce(sum(summit_elevation_m), 0)::double precision as summit_elevation_total_m,
    coalesce(max(summit_elevation_m), 0)::double precision as maximum_summit_elevation_m,
    count(distinct country_code)::bigint as distinct_country_codes,
    count(distinct to_char(ascent_date, 'YYYY-MM'))::bigint as distinct_active_months,
    count(distinct extract(year from ascent_date))::bigint as distinct_active_years,
    count(distinct extract(month from ascent_date))::bigint as calendar_months_represented,
    count(*) filter (
      where image_url is not null and btrim(image_url) <> ''
    )::bigint as photo_count,
    count(*) filter (where gps_activity_id is not null)::bigint as gps_linked_count
  from ascent_base
),
ascent_year_counts as (
  select
    extract(year from ascent_date)::integer::text as year_key,
    count(*)::bigint as ascent_count
  from ascent_base
  where ascent_date is not null
  group by extract(year from ascent_date)::integer
),
ascent_years as (
  select coalesce(
    jsonb_object_agg(year_key, ascent_count order by year_key),
    '{}'::jsonb
  ) as ascents_by_year
  from ascent_year_counts
),
ascent_zone_values as (
  select distinct case
    when summit_elevation_m < 1000 then 'below-1000'
    when summit_elevation_m < 1500 then '1000-1499'
    when summit_elevation_m < 2000 then '1500-1999'
    when summit_elevation_m < 2500 then '2000-2499'
    when summit_elevation_m < 3000 then '2500-2999'
    when summit_elevation_m < 3500 then '3000-3499'
    else '3500-plus'
  end as altitude_zone
  from ascent_base
  where summit_elevation_m is not null
),
ascent_zones as (
  select coalesce(
    jsonb_agg(
      altitude_zone
      order by array_position(
        array[
          'below-1000', '1000-1499', '1500-1999', '2000-2499',
          '2500-2999', '3000-3499', '3500-plus'
        ],
        altitude_zone
      )
    ),
    '[]'::jsonb
  ) as altitude_zones
  from ascent_zone_values
),
ready_gps as (
  select
    case
      when distance_m is not null
        and distance_m::text not in ('NaN', 'Infinity', '-Infinity')
        and distance_m >= 0
      then distance_m::double precision
      else 0
    end as distance_m,
    case
      when elevation_gain_m is not null
        and elevation_gain_m::text not in ('NaN', 'Infinity', '-Infinity')
        and elevation_gain_m >= 0
      then elevation_gain_m::double precision
      else 0
    end as elevation_gain_m,
    case
      when maximum_elevation_m is not null
        and maximum_elevation_m::text not in ('NaN', 'Infinity', '-Infinity')
        and maximum_elevation_m >= 0
      then maximum_elevation_m::double precision
      else null
    end as maximum_elevation_m
  from public.gps_activities
  where user_id = auth.uid()
    and processing_status = 'ready'
),
gps_totals as (
  select
    count(*)::bigint as ready_track_count,
    coalesce(sum(distance_m), 0)::double precision as total_distance_m,
    coalesce(sum(elevation_gain_m), 0)::double precision as total_elevation_gain_m,
    max(maximum_elevation_m)::double precision as maximum_elevation_m
  from ready_gps
),
gps_confirmed as (
  select count(distinct coalesce(mountain_id, detected_mountain_id))::bigint
    as confirmed_mountain_count
  from public.gps_activities
  where user_id = auth.uid()
    and processing_status = 'ready'
    and gps_verified is true
    and detection_status = 'confirmed'
    and coalesce(mountain_id, detected_mountain_id) is not null
),
planning_totals as (
  select count(*)::bigint as favorite_count
  from public.favorite_mountains
  where user_id = auth.uid()
)
select jsonb_build_object(
  'generatedAt', statement_timestamp(),
  'ascents', jsonb_build_object(
    'records', ascent_totals.records,
    'uniqueMountainIds', ascent_totals.unique_mountain_ids,
    'summitElevationTotalM', ascent_totals.summit_elevation_total_m,
    'maximumSummitElevationM', ascent_totals.maximum_summit_elevation_m,
    'distinctCountryCodes', ascent_totals.distinct_country_codes,
    'altitudeZones', ascent_zones.altitude_zones,
    'ascentsByYear', ascent_years.ascents_by_year,
    'distinctActiveMonths', ascent_totals.distinct_active_months,
    'distinctActiveYears', ascent_totals.distinct_active_years,
    'calendarMonthsRepresented', ascent_totals.calendar_months_represented,
    'photoCount', ascent_totals.photo_count,
    'gpsLinkedCount', ascent_totals.gps_linked_count
  ),
  'gps', jsonb_build_object(
    'readyTrackCount', gps_totals.ready_track_count,
    'totalDistanceM', gps_totals.total_distance_m,
    'totalElevationGainM', gps_totals.total_elevation_gain_m,
    'maximumElevationM', gps_totals.maximum_elevation_m,
    'confirmedMountainCount', gps_confirmed.confirmed_mountain_count
  ),
  'planning', jsonb_build_object(
    'favoriteCount', planning_totals.favorite_count
  )
)
from ascent_totals
cross join ascent_years
cross join ascent_zones
cross join gps_totals
cross join gps_confirmed
cross join planning_totals;
$function$;

revoke all on function public.get_achievement_snapshot() from public;
grant execute on function public.get_achievement_snapshot() to authenticated;
