-- GENERATED — reviewed border memberships — MANUAL REVIEW REQUIRED BEFORE APPLYING
-- Source: data/border-peaks/real-run/review.jsonl + manifest data/border-peaks/real-run/third-manual-batch/review-decisions.jsonl
-- Generated: 2026-09-25T15:45:37.880Z
-- Each row preserves existing primary; secondary is_primary=false; ON CONFLICT DO NOTHING.
-- Validate mountain identity after generation: compare id/name/height/country_code with preflight.
-- Approval via separate manifest with candidate_hash binding; original REVIEW remains immutable.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Abort the whole transaction on identity drift or an already-present DE membership.
-- Live read-only identity/membership check completed at 2026-09-25T15:43:25.027Z.
do $preflight$
declare
  expected record;
begin
  for expected in
    select * from (values
      (21::bigint, 'Östliche Plattspitze'::text, 2680::numeric, 'AT'::text),
      (20::bigint, 'Mittlere Plattspitze'::text, 2680::numeric, 'AT'::text),
      (8::bigint, 'Südliche Wetterspitze'::text, 2746::numeric, 'AT'::text),
      (19::bigint, 'Leutascher Dreitorspitze'::text, 2682::numeric, 'AT'::text),
      (75::bigint, 'Bayerländerturm'::text, 2507::numeric, 'AT'::text),
      (100::bigint, 'Scharnitzspitze'::text, 2461::numeric, 'AT'::text),
      (89::bigint, 'Musterstein'::text, 2478::numeric, 'AT'::text),
      (129::bigint, 'Rotplattenspitze'::text, 2399::numeric, 'AT'::text)
    ) as approved(id, name, height, country_code)
  loop
    if not exists (
      select 1 from public.mountains m
      where m.id = expected.id
        and m.name is not distinct from expected.name
        and m.height is not distinct from expected.height
        and m.country_code is not distinct from expected.country_code
    ) then
      raise exception 'Third border batch BLOCKED: identity mismatch for mountain % (%)', expected.id, expected.name;
    end if;
    if exists (
      select 1 from public.mountain_countries mc
      where mc.mountain_id = expected.id and mc.country_code = 'DE'
    ) then
      raise exception 'Third border batch BLOCKED: DE membership already exists for mountain %', expected.id;
    end if;
  end loop;
end;
$preflight$;
insert into public.mountain_countries (mountain_id, country_code, is_primary, source) values (21, 'DE', false, 'William & Mary geoLab') on conflict (mountain_id, country_code) do nothing; -- Östliche Plattspitze AT→DE 3m reviewed_by=user (external manual review; approval in task instruction)
insert into public.mountain_countries (mountain_id, country_code, is_primary, source) values (20, 'DE', false, 'William & Mary geoLab') on conflict (mountain_id, country_code) do nothing; -- Mittlere Plattspitze AT→DE 20m reviewed_by=user (external manual review; approval in task instruction)
insert into public.mountain_countries (mountain_id, country_code, is_primary, source) values (8, 'DE', false, 'William & Mary geoLab') on conflict (mountain_id, country_code) do nothing; -- Südliche Wetterspitze AT→DE 10m reviewed_by=user (external manual review; approval in task instruction)
insert into public.mountain_countries (mountain_id, country_code, is_primary, source) values (19, 'DE', false, 'William & Mary geoLab') on conflict (mountain_id, country_code) do nothing; -- Leutascher Dreitorspitze AT→DE 10m reviewed_by=user (external manual review; approval in task instruction)
insert into public.mountain_countries (mountain_id, country_code, is_primary, source) values (75, 'DE', false, 'William & Mary geoLab') on conflict (mountain_id, country_code) do nothing; -- Bayerländerturm AT→DE 11m reviewed_by=user (external manual review; approval in task instruction)
insert into public.mountain_countries (mountain_id, country_code, is_primary, source) values (100, 'DE', false, 'William & Mary geoLab') on conflict (mountain_id, country_code) do nothing; -- Scharnitzspitze AT→DE 11m reviewed_by=user (external manual review; approval in task instruction)
insert into public.mountain_countries (mountain_id, country_code, is_primary, source) values (89, 'DE', false, 'William & Mary geoLab') on conflict (mountain_id, country_code) do nothing; -- Musterstein AT→DE 20m reviewed_by=user (external manual review; approval in task instruction)
insert into public.mountain_countries (mountain_id, country_code, is_primary, source) values (129, 'DE', false, 'William & Mary geoLab') on conflict (mountain_id, country_code) do nothing; -- Rotplattenspitze AT→DE 3m reviewed_by=user (external manual review; approval in task instruction)
commit;
