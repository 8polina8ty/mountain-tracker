-- Phase 11B targeted repair #2 for PostgreSQL 42P17 GPS evidence recursion.
-- MANUAL DEPLOYMENT ONLY. This removes one obsolete SELECT policy and changes
-- no data, privileges, table ownership, RLS configuration, or other policies.

begin;

do $preflight$
declare
  day_tracks_rls_enabled boolean;
  collaboration_policy_is_terminating boolean;
  linked_activity_policy_exists boolean;
begin
  select c.relrowsecurity
  into day_tracks_rls_enabled
  from pg_catalog.pg_class c
  where c.oid = 'public.expedition_project_day_tracks'::regclass;

  if day_tracks_rls_enabled is distinct from true then
    raise exception 'Repair requires RLS enabled on public.expedition_project_day_tracks.';
  end if;

  select exists (
    select 1
    from pg_catalog.pg_policy policy
    where policy.polrelid = 'public.expedition_project_day_tracks'::regclass
      and policy.polname = 'expedition_project_day_tracks_collaboration_select'
      and pg_catalog.pg_get_expr(policy.polqual, policy.polrelid)
        like '%can_view_expedition_project%'
  ) into collaboration_policy_is_terminating;

  if not collaboration_policy_is_terminating then
    raise exception 'Canonical collaboration-aware day-track SELECT policy is missing or unsafe.';
  end if;

  select exists (
    select 1
    from pg_catalog.pg_policy policy
    where policy.polrelid = 'public.gps_activities'::regclass
      and policy.polname = 'gps_activities_linked_project_select'
  ) into linked_activity_policy_exists;

  if not linked_activity_policy_exists then
    raise exception 'Expected gps_activities linked-project SELECT policy is missing.';
  end if;
end;
$preflight$;

drop policy if exists expedition_project_day_tracks_select_owned
  on public.expedition_project_day_tracks;

commit;
