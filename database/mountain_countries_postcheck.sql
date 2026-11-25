-- Read-only post-deploy verification for mountain_countries (no PII)
-- A) All mountains with country_code represented
select count(*) as mountains_total from public.mountains;
select count(*) as mountains_with_country from public.mountains where country_code is not null;
select count(*) as mountain_countries_total from public.mountain_countries;
select count(distinct mountain_id) as distinct_mountain_ids from public.mountain_countries;

-- B) Zugspitze memberships (AT primary + DE secondary)
select mountain_id, country_code, is_primary, source, created_at
from public.mountain_countries where mountain_id = 1 order by country_code;

select id, name, name_de, height, country_code as legacy_primary
from public.mountains where id = 1;

-- C) Germany membership includes Zugspitze
select m.id, m.name, m.name_de, m.height, mc.country_code, mc.is_primary
from public.mountains m join public.mountain_countries mc on mc.mountain_id=m.id
where mc.country_code='DE' and (lower(coalesce(m.name,'')) like '%zugspitze%' or lower(coalesce(m.name_de,'')) like '%zugspitze%');

-- Austria membership includes Zugspitze
select m.id, m.name, m.name_de, m.height, mc.country_code, mc.is_primary
from public.mountains m join public.mountain_countries mc on mc.mountain_id=m.id
where mc.country_code='AT' and (lower(coalesce(m.name,'')) like '%zugspitze%');

-- D) No duplicate (PK ensures, verify)
select mountain_id, country_code, count(*) from public.mountain_countries group by mountain_id,country_code having count(*)>1;

-- E) Auth residence RPC sanity (run as authenticated user, replaces :uid with auth.uid())
-- These should return same countryCode as profile for the caller:
-- select public.get_my_country_mountain_progress();
-- select public.list_my_country_mountains(search=>'Zugspitze');
