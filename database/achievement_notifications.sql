-- Achievement System v2, Phase E. Apply only after the Phase B and C artifacts.
-- Both functions are authenticated, current-user scoped, and expose no activity data.

create or replace function public.get_pending_achievement_notifications()
returns table (
  achievement_id text,
  unlocked_at timestamptz,
  grant_source text,
  definition_version integer
)
language sql
stable
security invoker
set search_path = ''
as $function$
  select
    ua.achievement_id,
    ua.unlocked_at,
    ua.grant_source,
    ua.definition_version
  from public.user_achievements as ua
  where ua.user_id = auth.uid()
    and ua.notified_at is null
    and ua.definition_version = 2
    and ua.grant_source <> 'backfill'
  order by ua.unlocked_at, ua.achievement_id;
$function$;

create or replace function public.mark_achievement_notification_notified(
  requested_achievement_id text
)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  if not public.is_registered_achievement_id(requested_achievement_id) then
    raise exception 'Unregistered achievement ID.' using errcode = '22023';
  end if;

  update public.user_achievements
  set notified_at = now()
  where user_id = auth.uid()
    and achievement_id = requested_achievement_id
    and definition_version = 2
    and notified_at is null;

  return found;
end;
$function$;

revoke all on function public.get_pending_achievement_notifications() from public;
revoke all on function public.mark_achievement_notification_notified(text) from public;
grant execute on function public.get_pending_achievement_notifications() to authenticated;
grant execute on function public.mark_achievement_notification_notified(text) to authenticated;
