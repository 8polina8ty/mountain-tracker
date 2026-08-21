-- Phase 12: narrow anonymous public-expedition discovery boundary.
-- MANUAL REVIEW AND DEPLOYMENT ONLY. Apply after Phase 10 sharing artifacts.
begin;
create or replace function public.search_public_expeditions(
  search_text text default null, filter_year integer default null,
  minimum_distance_m bigint default null, maximum_distance_m bigint default null,
  required_evidence boolean default false, filter_status text default null,
  sort_mode text default 'recent', cursor_value numeric default null,
  cursor_slug text default null, result_limit integer default 21
)
returns table(public_slug text,name text,status text,start_date date,end_date date,day_count integer,
  mountain_names text[],verified_mountain_count integer,days_with_gps_evidence integer,unique_track_count integer,
  total_distance_m bigint,total_elevation_gain_m bigint,total_duration_seconds bigint,sort_value numeric)
language sql stable security definer set search_path='' as $function$
with eligible as (
 select s.public_slug,p.id,p.name,p.status,p.start_date,p.end_date,s.updated_at
 from public.expedition_project_shares s join public.expedition_projects p on p.id=s.project_id and p.user_id=s.user_id
 where s.is_enabled=true and p.status in ('completed','archived')
), cards as (
 select e.*,
  (select count(*)::integer from public.expedition_project_days d where d.project_id=e.id) day_count,
  coalesce((select array_agg(coalesce(m.name_de,m.name) order by pm.sort_order,pm.mountain_id) from public.expedition_project_mountains pm join public.mountains m on m.id=pm.mountain_id where pm.project_id=e.id),'{}'::text[]) mountain_names,
  (select count(distinct pm.mountain_id)::integer from public.expedition_project_mountains pm where pm.project_id=e.id and exists(select 1 from public.expedition_project_day_tracks dt join public.gps_activities ga on ga.id=dt.gps_activity_id where dt.project_id=e.id and ga.detected_mountain_id=pm.mountain_id and ga.gps_verified=true)) verified_mountain_count,
  (select count(distinct dt.project_day_id)::integer from public.expedition_project_day_tracks dt where dt.project_id=e.id) days_with_gps_evidence,
  (select count(distinct dt.gps_activity_id)::integer from public.expedition_project_day_tracks dt where dt.project_id=e.id) unique_track_count,
  coalesce((select sum(x.distance_m)::bigint from (select distinct on(dt.gps_activity_id) ga.distance_m from public.expedition_project_day_tracks dt join public.gps_activities ga on ga.id=dt.gps_activity_id where dt.project_id=e.id order by dt.gps_activity_id) x),0) total_distance_m,
  coalesce((select sum(x.elevation_gain_m)::bigint from (select distinct on(dt.gps_activity_id) ga.elevation_gain_m from public.expedition_project_day_tracks dt join public.gps_activities ga on ga.id=dt.gps_activity_id where dt.project_id=e.id order by dt.gps_activity_id) x),0) total_elevation_gain_m,
  coalesce((select sum(x.duration_seconds)::bigint from (select distinct on(dt.gps_activity_id) ga.duration_seconds from public.expedition_project_day_tracks dt join public.gps_activities ga on ga.id=dt.gps_activity_id where dt.project_id=e.id order by dt.gps_activity_id) x),0) total_duration_seconds
 from eligible e
), filtered as (
 select c.*,case sort_mode when 'distance' then c.total_distance_m when 'elevation' then c.total_elevation_gain_m when 'duration' then c.total_duration_seconds else extract(epoch from c.updated_at) end::numeric sort_value
 from cards c where length(coalesce(btrim(search_text),''))<=80
  and (coalesce(btrim(search_text),'')='' or c.name ilike '%'||btrim(search_text)||'%' or exists(select 1 from unnest(c.mountain_names) n where n ilike '%'||btrim(search_text)||'%'))
  and (filter_year is null or filter_year between 1900 and 2200 and extract(year from c.start_date)=filter_year)
  and (filter_status is null or filter_status in ('completed','archived') and c.status=filter_status)
  and (minimum_distance_m is null or minimum_distance_m between 0 and 10000000 and c.total_distance_m>=minimum_distance_m)
  and (maximum_distance_m is null or maximum_distance_m between 0 and 10000000 and c.total_distance_m<=maximum_distance_m)
  and (not coalesce(required_evidence,false) or c.days_with_gps_evidence>0)
  and sort_mode in ('recent','distance','elevation','duration')
)
select f.public_slug,f.name,f.status,f.start_date,f.end_date,f.day_count,f.mountain_names,f.verified_mountain_count,f.days_with_gps_evidence,f.unique_track_count,f.total_distance_m,f.total_elevation_gain_m,f.total_duration_seconds,f.sort_value
from filtered f where cursor_value is null or (f.sort_value,f.public_slug)<(cursor_value,cursor_slug)
order by f.sort_value desc,f.public_slug desc limit least(greatest(coalesce(result_limit,21),1),21);
$function$;
alter function public.search_public_expeditions(text,integer,bigint,bigint,boolean,text,text,numeric,text,integer) owner to postgres;
revoke all on function public.search_public_expeditions(text,integer,bigint,bigint,boolean,text,text,numeric,text,integer) from public,authenticated;
grant execute on function public.search_public_expeditions(text,integer,bigint,bigint,boolean,text,text,numeric,text,integer) to anon,authenticated;
commit;
