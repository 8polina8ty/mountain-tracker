-- Global border-peak discovery export contract — READ ONLY.
-- No INSERT/UPDATE/DELETE. Do not export user/private data.
-- Mountain JSONL must be ordered by id so --resume checkpoints are deterministic.

-- Baseline / freshness check:
select
  count(*) as mountain_count,
  count(*) filter (where latitude is not null and longitude is not null) as geocoded_mountain_count,
  count(distinct country_code) filter (where country_code is not null) as country_count
from public.mountains;

-- Required mountain fields:
select
  id,
  name,
  name_de,
  latitude,
  longitude,
  height,
  country_code
from public.mountains
where latitude is not null
  and longitude is not null
  and country_code is not null
order by id;

-- Existing memberships snapshot:
select
  mountain_id,
  country_code,
  is_primary
from public.mountain_countries
order by mountain_id, country_code;

-- psql JSONL examples (read-only):
-- psql "$DATABASE_URL" -At -c "
--   select jsonb_build_object(
--     'id', id,
--     'name', name,
--     'name_de', name_de,
--     'latitude', latitude,
--     'longitude', longitude,
--     'height', height,
--     'primaryCountryCode', country_code
--   )::text
--   from public.mountains
--   where latitude is not null
--     and longitude is not null
--     and country_code is not null
--   order by id;
-- " > data/border-peaks/mountains-global.jsonl
--
-- psql "$DATABASE_URL" -At -c "
--   select jsonb_build_object(
--     'mountain_id', mountain_id,
--     'country_code', country_code,
--     'is_primary', is_primary
--   )::text
--   from public.mountain_countries
--   order by mountain_id, country_code;
-- " > data/border-peaks/existing-memberships-global.jsonl
