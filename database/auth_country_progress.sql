-- MANUAL DEPLOYMENT ONLY. Review auth_country_progress_review.md first.
-- Based on the production contract supplied by the user, 2026-09-24.
-- No backfill, username migration, profile recreation or global ranking rewrite.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- This explicit allow-list is checked against Lib/countries.ts by the validator.
create or replace function public.is_residence_country(code text)
returns boolean language sql immutable security invoker set search_path = ''
as $fn$
  select coalesce(code = any(pg_catalog.string_to_array(
    'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW', ' ')), false);
$fn$;

create or replace function public.is_canonical_profile_username(value text)
returns boolean language sql immutable security invoker set search_path = ''
as $fn$
  select coalesce(value = pg_catalog.btrim(value)
    and value ~ '^[A-Za-z0-9_][A-Za-z0-9_.-]{1,18}[A-Za-z0-9_]$', false);
$fn$;

alter table public.profiles add column if not exists country_code text;
-- Constant false preserves access for every existing row without an UPDATE/backfill.
alter table public.profiles add column if not exists onboarding_required boolean not null default false;
-- Only future profiles default to pending. Reapplying does not reset old values.
alter table public.profiles alter column onboarding_required set default true;
do $block$ begin
  if not exists (select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.profiles'::regclass and conname = 'profiles_residence_country_valid') then
    alter table public.profiles add constraint profiles_residence_country_valid
      check (country_code is null or public.is_residence_country(country_code));
  end if;
end $block$;

revoke truncate on table public.profiles from anon, authenticated;

-- Public-safe predicate: no actor argument, no private row is returned.
create or replace function public.auth_country_can_write()
returns boolean language sql stable security definer set search_path = ''
as $fn$
  select exists (select 1 from public.profiles p where p.id = auth.uid()
    and (not p.onboarding_required or
      (public.is_canonical_profile_username(p.username) and public.is_residence_country(p.country_code))));
$fn$;

-- INVOKER is deliberate: direct PostgREST writes run as authenticated, whereas
-- reviewed SECURITY DEFINER RPCs run as their postgres owner. No spoofable GUC.
create or replace function public.guard_auth_country_profile()
returns trigger language plpgsql security invoker set search_path = ''
as $fn$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op <> 'UPDATE' then raise exception 'profile_protected' using errcode = '42501'; end if;
    if new.id is distinct from old.id or new.username is distinct from old.username
      or new.country_code is distinct from old.country_code
      or new.onboarding_required is distinct from old.onboarding_required then
      raise exception 'profile_protected' using errcode = '42501';
    end if;
    if old.onboarding_required then raise exception 'profile_incomplete' using errcode = '42501'; end if;
    return new; -- Preserves existing owner avatar/display-name/updated_at updates and RLS.
  end if;
  if tg_op = 'DELETE' then return old; end if;
  if new.username is not null and (tg_op = 'INSERT' or new.username is distinct from old.username) then
    if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
      raise exception 'username_claim_requires_read_committed' using errcode = '25000';
    end if;
    if not public.is_canonical_profile_username(new.username) then
      raise exception 'username_invalid' using errcode = '22023';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.lower(new.username), 73021));
    if exists (select 1 from public.profiles p
      where pg_catalog.lower(p.username) = pg_catalog.lower(new.username) and p.id <> new.id) then
      raise exception 'username_unavailable' using errcode = '23505';
    end if;
  end if;
  return new;
end;
$fn$;
create or replace trigger auth_country_profile_guard
before insert or update or delete on public.profiles
for each row execute function public.guard_auth_country_profile();

-- Retains on_auth_user_created and the same profile ID. Metadata is only a UI
-- prefill hint; claiming a username happens after authentication, under a lock.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = ''
as $fn$
begin
  insert into public.profiles (id, username, display_name, onboarding_required)
  values (new.id, null, null, true);
  return new;
end;
$fn$;

create or replace function public.is_profile_username_available(requested_username text)
returns boolean language sql stable security definer set search_path = ''
as $fn$
  select public.is_canonical_profile_username(pg_catalog.btrim(requested_username))
    and not exists (select 1 from public.profiles p
      where pg_catalog.lower(p.username) = pg_catalog.lower(pg_catalog.btrim(requested_username))
        and p.id is distinct from auth.uid());
$fn$;

create or replace function public.complete_user_profile(requested_username text, requested_country_code text)
returns void language plpgsql security definer set search_path = ''
as $fn$
declare actor uuid := auth.uid(); profile public.profiles%rowtype;
  clean_username text := pg_catalog.btrim(requested_username);
begin
  if actor is null then raise exception 'auth_required' using errcode = '42501'; end if;
  select * into profile from public.profiles where id = actor for update;
  if not found then raise exception 'profile_missing' using errcode = 'P0002'; end if;
  if not public.is_canonical_profile_username(clean_username) then
    raise exception 'username_invalid' using errcode = '22023'; end if;
  if not public.is_residence_country(requested_country_code) then
    raise exception 'country_invalid' using errcode = '22023'; end if;
  if not profile.onboarding_required or (public.is_canonical_profile_username(profile.username)
    and public.is_residence_country(profile.country_code)) then
    if profile.username = clean_username and profile.country_code = requested_country_code then
      if profile.onboarding_required then
        update public.profiles set onboarding_required = false, updated_at = pg_catalog.now() where id = actor;
      end if;
      return;
    end if;
    raise exception 'profile_already_completed' using errcode = '42501';
  end if;
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'username_claim_requires_read_committed' using errcode = '25000';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.lower(clean_username), 73021));
  -- Any other owner, including multiple case variants, fails closed.
  if exists (select 1 from public.profiles p where pg_catalog.lower(p.username) = pg_catalog.lower(clean_username)
    and p.id <> actor) then raise exception 'username_unavailable' using errcode = '23505'; end if;
  update public.profiles set username = clean_username,
    display_name = case when nullif(pg_catalog.btrim(display_name), '') is null then clean_username else display_name end,
    country_code = requested_country_code, onboarding_required = false, updated_at = pg_catalog.now()
  where id = actor;
end;
$fn$;

create or replace function public.update_my_residence_country(requested_country_code text)
returns void language plpgsql security definer set search_path = ''
as $fn$
declare actor uuid := auth.uid(); profile public.profiles%rowtype;
begin
  if actor is null then raise exception 'auth_required' using errcode = '42501'; end if;
  if not public.is_residence_country(requested_country_code) then
    raise exception 'country_invalid' using errcode = '22023'; end if;
  select * into profile from public.profiles where id = actor for update;
  if not found then raise exception 'profile_missing' using errcode = 'P0002'; end if;
  if profile.onboarding_required then raise exception 'profile_incomplete' using errcode = '42501'; end if;
  update public.profiles set country_code = requested_country_code, updated_at = pg_catalog.now()
  where id = actor and country_code is distinct from requested_country_code;
end;
$fn$;

-- DB-level protection also covers writes inside existing SECURITY DEFINER RPCs.
-- No existing policy/RPC is replaced. SELECT and unauthenticated trusted system
-- jobs are unaffected. Review the attachment inventory before manual deployment.
create or replace function public.guard_auth_country_write()
returns trigger language plpgsql security definer set search_path = ''
as $fn$
begin
  if auth.uid() is not null and not public.auth_country_can_write() then
    raise exception 'profile_incomplete' using errcode = '42501';
  end if;
  return null;
end;
$fn$;
do $block$
declare target record;
begin
  for target in select n.nspname, c.relname from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
      and c.relname <> 'profiles'
  loop
    execute pg_catalog.format('create or replace trigger auth_country_write_guard before insert or update or delete on %I.%I for each statement execute function public.guard_auth_country_write()', target.nspname, target.relname);
  end loop;
end $block$;

-- Additive restrictive policies: existing bucket/path/owner policies still apply.
-- No storage table triggers or service-role policy changes.
drop policy if exists auth_country_storage_insert on storage.objects;
create policy auth_country_storage_insert on storage.objects as restrictive for insert to authenticated
with check ((select public.auth_country_can_write()));
drop policy if exists auth_country_storage_update on storage.objects;
create policy auth_country_storage_update on storage.objects as restrictive for update to authenticated
using ((select public.auth_country_can_write())) with check ((select public.auth_country_can_write()));
drop policy if exists auth_country_storage_delete on storage.objects;
create policy auth_country_storage_delete on storage.objects as restrictive for delete to authenticated
using ((select public.auth_country_can_write()));

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

-- Wrap, do not reimplement, get_user_ranking: even future repeated-ascent SUM
-- semantics and associated highest-name selection remain exactly its semantics.
create or replace function public.get_my_country_ranking(
  search text default '', sort_mode text default 'ascents', page_offset integer default 0, result_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path = ''
as $fn$
declare actor uuid := auth.uid(); country text; result jsonb;
  page_size integer := least(greatest(coalesce(result_limit, 20), 1), 50);
begin
  if actor is null then raise exception 'auth_required' using errcode = '42501'; end if;
  if char_length(coalesce(search, '')) > 100 or page_offset is null or page_offset < 0 or page_offset > 10000
    or sort_mode is null or sort_mode not in ('ascents','total-height','highest-mountain','achievements') then
    raise exception 'filters_invalid' using errcode = '22023'; end if;
  select p.country_code into country from public.profiles p where p.id = actor;
  if not public.is_residence_country(country) then
    return pg_catalog.jsonb_build_object('countryCode', null, 'items', '[]'::jsonb, 'hasMore', false); end if;
  with ranked as (
    select r.user_id, r.username, r.avatar_url, r.ascents_count, r.total_height,
      r.highest_mountain_height, r.highest_mountain_name, r.achievements_count,
      row_number() over (order by
        case when sort_mode = 'total-height' then r.total_height end desc nulls last,
        case when sort_mode = 'highest-mountain' then r.highest_mountain_height end desc nulls last,
        case when sort_mode = 'achievements' then r.achievements_count end desc nulls last,
        r.ascents_count desc, r.total_height desc, r.highest_mountain_height desc,
        r.achievements_count desc, r.username asc, r.user_id asc) as position
    from public.get_user_ranking() r join public.profiles p on p.id = r.user_id
    where p.country_code = country and (coalesce(pg_catalog.btrim(search), '') = ''
      or pg_catalog.strpos(pg_catalog.lower(coalesce(r.username, '')), pg_catalog.lower(pg_catalog.btrim(search))) > 0)
  ), window_rows as (select * from ranked order by position offset page_offset limit page_size + 1),
  page_rows as (select * from window_rows order by position limit page_size)
  select pg_catalog.jsonb_build_object('countryCode', country,
    'items', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) order by position) from page_rows p), '[]'::jsonb),
    'hasMore', (select count(*) from window_rows) > page_size and page_offset + page_size <= 10000)
  into result;
  return result;
end;
$fn$;

-- Explicit ownership, no helper with a caller-supplied actor, no PUBLIC execute.
alter function public.handle_new_user() owner to postgres;
alter function public.auth_country_can_write() owner to postgres;
alter function public.guard_auth_country_write() owner to postgres;
alter function public.complete_user_profile(text,text) owner to postgres;
alter function public.update_my_residence_country(text) owner to postgres;
alter function public.is_profile_username_available(text) owner to postgres;
alter function public.get_my_country_mountain_progress() owner to postgres;
alter function public.list_my_country_mountains(text,double precision,double precision,text,bigint,integer) owner to postgres;
alter function public.get_my_country_ranking(text,text,integer,integer) owner to postgres;

revoke all on function public.handle_new_user(), public.guard_auth_country_profile(), public.guard_auth_country_write() from public, anon, authenticated;
revoke all on function public.is_residence_country(text), public.is_canonical_profile_username(text), public.auth_country_can_write(),
  public.is_profile_username_available(text), public.complete_user_profile(text,text), public.update_my_residence_country(text),
  public.get_my_country_mountain_progress(), public.list_my_country_mountains(text,double precision,double precision,text,bigint,integer),
  public.get_my_country_ranking(text,text,integer,integer) from public, anon, authenticated;
-- Pure validators and availability reveal only boolean results over public usernames.
grant execute on function public.is_residence_country(text), public.is_canonical_profile_username(text),
  public.is_profile_username_available(text) to anon, authenticated;
grant execute on function public.auth_country_can_write(), public.complete_user_profile(text,text),
  public.update_my_residence_country(text), public.get_my_country_mountain_progress(),
  public.list_my_country_mountains(text,double precision,double precision,text,bigint,integer),
  public.get_my_country_ranking(text,text,integer,integer) to authenticated;

-- No speculative mountain indexes: inspect EXPLAIN before adding one.
notify pgrst, 'reload schema';
commit;
