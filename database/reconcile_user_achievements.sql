-- Achievement System v2, Phase C.
-- Deployment order: apply get_achievement_snapshot.sql first, then this artifact.
-- Existing (user_id, achievement_id) uniqueness and unlocked_at default semantics
-- are required by the legacy writer and are intentionally preserved here.

create or replace function public.is_registered_achievement_id(candidate text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $function$
  select candidate = any (array[
    'first-ascent', 'five-ascents', 'ten-ascents',
    'twenty-five-ascents', 'fifty-ascents',
    'summits-100', 'summits-250', 'summits-500', 'summits-750', 'summits-1000',
    'summit-elevation-total-1000', 'summit-elevation-total-5000',
    'ten-thousand-height', 'summit-elevation-total-25000',
    'summit-elevation-total-50000', 'summit-elevation-total-100000',
    'summit-elevation-total-250000', 'summit-elevation-total-500000',
    'summit-elevation-total-750000', 'summit-elevation-total-1000000',
    'summit-height-500', 'summit-height-1000', 'summit-height-1500',
    'above-clouds', 'summit-height-2500', 'summit-height-3000',
    'summit-height-3500', 'summit-height-4000',
    'altitude-zone-below-1000', 'altitude-zone-1000-1499',
    'altitude-zone-1500-1999', 'altitude-zone-2000-2499',
    'altitude-zone-2500-2999', 'altitude-zone-3000-3499',
    'altitude-zone-3500-plus', 'altitude-zones-3', 'altitude-zones-5',
    'altitude-zones-7',
    'countries-2', 'countries-3', 'countries-5', 'countries-10',
    'countries-15', 'countries-20', 'countries-30',
    'gps-tracks-1', 'gps-tracks-5', 'gps-tracks-10', 'gps-tracks-25',
    'gps-tracks-50', 'gps-tracks-100', 'gps-tracks-250', 'gps-tracks-500',
    'gps-distance-km-10', 'gps-distance-km-50', 'gps-distance-km-100',
    'gps-distance-km-250', 'gps-distance-km-500', 'gps-distance-km-1000',
    'gps-distance-km-2500', 'gps-distance-km-5000', 'gps-distance-km-10000',
    'gps-elevation-gain-1000', 'gps-elevation-gain-5000',
    'gps-elevation-gain-10000', 'gps-elevation-gain-25000',
    'gps-elevation-gain-50000', 'gps-elevation-gain-100000',
    'gps-elevation-gain-250000', 'gps-elevation-gain-500000',
    'gps-elevation-gain-1000000',
    'gps-linked-summits-1', 'gps-linked-summits-5',
    'gps-linked-summits-10', 'gps-linked-summits-25',
    'gps-linked-summits-50', 'gps-linked-summits-100',
    'gps-linked-summits-250', 'gps-linked-summits-500',
    'active-months-1', 'active-months-3', 'active-months-6',
    'active-months-12', 'active-months-24', 'active-months-36',
    'active-months-60', 'active-months-120',
    'active-years-2', 'active-years-3', 'active-years-5',
    'active-years-10', 'active-years-15',
    'summits-in-year-5', 'summits-in-year-10',
    'summits-in-year-25', 'summits-in-year-50',
    'calendar-months-represented-3', 'calendar-months-represented-6',
    'calendar-months-represented-9', 'calendar-months-represented-12',
    'ascent-photos-1', 'ascent-photos-5', 'ascent-photos-10',
    'ascent-photos-25', 'ascent-photos-50', 'ascent-photos-100',
    'favorites-1', 'favorites-5', 'favorites-10', 'favorites-25',
    'zugspitze'
  ]::text[]);
$function$;

alter table public.user_achievements
  add column if not exists grant_source text not null default 'legacy',
  add column if not exists definition_version integer not null default 1,
  -- Legacy rows and future legacy inserts are treated as already handled by the
  -- existing presentation flow. The v2 RPC explicitly inserts NULL instead.
  add column if not exists notified_at timestamptz null default now();

do $constraints$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.user_achievements'::regclass
      and conname = 'user_achievements_grant_source_check'
  ) then
    alter table public.user_achievements
      add constraint user_achievements_grant_source_check
      check (grant_source in ('legacy', 'event', 'reconciliation', 'backfill'));
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.user_achievements'::regclass
      and conname = 'user_achievements_definition_version_check'
  ) then
    alter table public.user_achievements
      add constraint user_achievements_definition_version_check
      check (definition_version > 0);
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.user_achievements'::regclass
      and conname = 'user_achievements_registered_id_check'
  ) then
    alter table public.user_achievements
      add constraint user_achievements_registered_id_check
      check (public.is_registered_achievement_id(achievement_id));
  end if;
end
$constraints$;

create or replace function public.reconcile_user_achievements(
  requested_achievement_ids text[]
)
returns table (
  achievement_id text,
  unlocked_at timestamptz,
  grant_source text,
  definition_version integer,
  notified_at timestamptz
)
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
#variable_conflict use_column
declare
  current_user_id uuid := auth.uid();
  invalid_ids text[];
begin
  if current_user_id is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  select array_agg(distinct requested_id order by requested_id)
  into invalid_ids
  from unnest(coalesce(requested_achievement_ids, array[]::text[]))
    as requested(requested_id)
  where requested_id is null
    or not public.is_registered_achievement_id(requested_id);

  if invalid_ids is not null then
    raise exception 'The request contains an unregistered achievement ID.'
      using errcode = '22023';
  end if;

  return query
  insert into public.user_achievements as user_achievement (
    user_id,
    achievement_id,
    grant_source,
    definition_version,
    notified_at
  )
  select
    current_user_id,
    requested.requested_id,
    'reconciliation',
    2,
    null
  from (
    select distinct requested_id
    from unnest(coalesce(requested_achievement_ids, array[]::text[]))
      as input(requested_id)
  ) as requested
  on conflict (user_id, achievement_id) do nothing
  returning
    user_achievement.achievement_id,
    user_achievement.unlocked_at,
    user_achievement.grant_source,
    user_achievement.definition_version,
    user_achievement.notified_at;
end;
$function$;

revoke all on function public.reconcile_user_achievements(text[]) from public;
grant execute on function public.reconcile_user_achievements(text[]) to authenticated;
