-- Read-only preflight for mountain_countries migration. No PII, no writes.
begin transaction read only;
set local statement_timeout = '20s';

-- Mountains schema
select table_name, column_name, data_type, udt_name, is_nullable
from information_schema.columns
where table_schema='public' and table_name='mountains'
order by ordinal_position;

-- Existing country distribution
select country_code, count(*) as cnt
from public.mountains group by country_code order by cnt desc, country_code;

-- Zugspitze production fact
select id, name, name_de, height, country_code
from public.mountains where id = 1;

select id, name, name_de, height, country_code
from public.mountains
where lower(coalesce(name,'')) like '%zugspitze%' or lower(coalesce(name_de,'')) like '%zugspitze%';

-- Current RPC definitions (before patch)
select p.proname, pg_get_functiondef(p.oid) as definition
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('get_my_country_mountain_progress','list_my_country_mountains')
order by p.proname;

-- Existing mountain_countries if any
select
  to_regclass('public.mountain_countries') as mountain_countries_table;

-- Grants / RLS for reference
select schemaname, tablename, policyname, roles, cmd from pg_policies where tablename='mountains';
select indexname, indexdef from pg_indexes where schemaname='public' and tablename='mountains' order by indexname;

commit;
