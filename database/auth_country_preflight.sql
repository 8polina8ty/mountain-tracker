-- Read-only production inspection. Run manually in the Supabase SQL editor.
-- Return every result set (schema and aggregate counts only; no user rows).
-- No auth tokens, email addresses, metadata or credentials are selected.
begin transaction read only;
set local statement_timeout = '20s';

select c.table_schema, c.table_name, c.column_name, c.data_type,
       c.udt_name, c.is_nullable, c.column_default
from information_schema.columns c
where (c.table_schema = 'public' and c.table_name in ('profiles','ascents','mountains'))
order by c.table_name, c.ordinal_position;

select n.nspname as schema_name, c.relname as table_name,
       c.relrowsecurity as rls_enabled, c.relforcerowsecurity as force_rls
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('profiles','ascents','mountains');

select conrelid::regclass::text as table_name, conname,
       pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid in ('public.profiles'::regclass, 'public.ascents'::regclass,
                   'public.mountains'::regclass)
order by conrelid::regclass::text, conname;

select tablename, indexname, indexdef from pg_indexes
where schemaname = 'public' and tablename in ('profiles','ascents','mountains')
order by tablename, indexname;

select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
from pg_policies where schemaname = 'public'
and tablename in ('profiles','ascents','mountains')
order by tablename, policyname;

select table_name, grantee, privilege_type from information_schema.table_privileges
where table_schema = 'public' and table_name in ('profiles','ascents','mountains')
and grantee in ('anon','authenticated','service_role','PUBLIC')
order by table_name, grantee, privilege_type;

select table_name, column_name, grantee, privilege_type
from information_schema.column_privileges
where table_schema = 'public' and table_name = 'profiles'
and grantee in ('anon','authenticated','service_role','PUBLIC')
order by column_name, grantee, privilege_type;

select t.tgrelid::regclass::text as table_name, t.tgname,
       pg_get_triggerdef(t.oid) as trigger_definition,
       p.oid::regprocedure::text as function_name, p.prosecdef as security_definer,
       p.proconfig, pg_get_functiondef(p.oid) as function_definition
from pg_trigger t join pg_proc p on p.oid = t.tgfoid
where not t.tgisinternal and t.tgrelid in
('auth.users'::regclass, 'public.profiles'::regclass, 'public.ascents'::regclass)
order by table_name, t.tgname;

select p.oid::regprocedure::text as function_name, p.prosecdef,
       p.proconfig, p.proacl, pg_get_functiondef(p.oid) as definition
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prokind = 'f'
and (p.proname in ('get_user_ranking','get_mountains_in_bounds','get_achievement_snapshot')
     or p.proname ~ '(profile|username|onboard)')
order by function_name;

-- Aggregate legacy compatibility audit: deliberately no usernames or user IDs.
select count(*) as profile_count,
       count(*) filter (where username is null or btrim(username) = '') as missing_username,
       count(*) filter (where username is not null and
          (username <> btrim(username) or
           username !~ '^[A-Za-z0-9_][A-Za-z0-9_.-]{1,18}[A-Za-z0-9_]$')) as legacy_username
from public.profiles;
select count(*) as case_insensitive_collision_groups from (
  select lower(btrim(username)) from public.profiles where username is not null
  group by lower(btrim(username)) having count(*) > 1
) collisions;

-- Raw codes stay raw: reveals NULL, lowercase, composite and non-ISO values.
select country_code, count(*) as mountain_count
from public.mountains group by country_code order by count(*) desc, country_code;

select count(*) as duplicate_user_mountain_groups from (
  select user_id, mountain_id from public.ascents
  group by user_id, mountain_id having count(*) > 1
) duplicates;

commit;
