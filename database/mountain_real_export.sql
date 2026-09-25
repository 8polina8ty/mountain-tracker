-- Read-only export for bounded border discovery — no private data, no writes
-- Required fields: id, name, name_de, latitude, longitude, height, country_code
-- Use WGS84 lon/lat order as stored (longitude, latitude)
-- Run manually via Supabase SQL Editor or psql and save as data/border-peaks/mountains-real.jsonl

-- Example: export 100 DE mountains near Alps for bounded test
-- Replace :limit as needed; keep deterministic order by id
select
  id,
  name,
  name_de,
  latitude,
  longitude,
  height,
  country_code
from public.mountains
where country_code in ('DE','AT','CH','FR','IT','SI','LI')
  and latitude is not null and longitude is not null
order by id
limit 100;

-- To produce JSONL for the pipeline, use:
-- psql "postgresql://..." -At -c "select jsonb_build_object('id',id,'name',name,'name_de',name_de,'latitude',latitude,'longitude',longitude,'height',height,'primaryCountryCode',country_code)::text from public.mountains where country_code in ('DE','AT') order by id limit 100;" > data/border-peaks/mountains-real.jsonl
-- Or via Supabase: run the select, export as CSV, convert to JSONL with name/name_de/primaryCountryCode mapping.
-- Do NOT export emails, user ids, or tokens.
-- Verify freshness: check max(updated_at) if column exists, or count(*).
