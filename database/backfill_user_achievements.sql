-- Achievement System v2, Phase F.
-- Deployment order: Phase B snapshot, Phase C reconciliation, Phase E
-- notifications, then this manual-only backfill function.

create or replace function public.backfill_user_achievements(
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
    'backfill',
    2,
    now()
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

revoke all on function public.backfill_user_achievements(text[]) from public;
revoke execute on function public.backfill_user_achievements(text[]) from anon;
grant execute on function public.backfill_user_achievements(text[]) to authenticated;
