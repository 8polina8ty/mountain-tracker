-- Phase 11B targeted repair for PostgreSQL 42P17 project/member RLS recursion.
-- MANUAL DEPLOYMENT ONLY. This changes authorization definitions only.

begin;

do $preflight$
declare
  postgres_bypasses_rls boolean;
  invalid_table_count integer;
begin
  select r.rolbypassrls into postgres_bypasses_rls
  from pg_catalog.pg_roles r where r.rolname = 'postgres';
  if postgres_bypasses_rls is distinct from true then
    raise exception 'Repair requires the postgres role with BYPASSRLS.';
  end if;

  select count(*) into invalid_table_count
  from pg_catalog.pg_class c
  where c.oid in (
    'public.expedition_projects'::regclass,
    'public.expedition_project_members'::regclass,
    'public.expedition_project_invitations'::regclass
  ) and (
    c.relowner <> (select r.oid from pg_catalog.pg_roles r where r.rolname = 'postgres')
    or not c.relrowsecurity
    or c.relforcerowsecurity
  );
  if invalid_table_count <> 0 then
    raise exception 'Repair preflight failed: collaboration tables must be postgres-owned with RLS enabled and FORCE RLS disabled.';
  end if;
end;
$preflight$;

create or replace function public.is_expedition_project_owner(requested_project_id uuid)
returns boolean language sql stable security definer set search_path = '' as $function$
  select auth.uid() is not null and exists (
    select 1 from public.expedition_projects p
    where p.id = requested_project_id and p.user_id = auth.uid()
  );
$function$;
alter function public.is_expedition_project_owner(uuid) owner to postgres;
revoke all on function public.is_expedition_project_owner(uuid) from public, anon;
grant execute on function public.is_expedition_project_owner(uuid) to authenticated;

drop policy if exists expedition_project_members_scoped_select on public.expedition_project_members;
create policy expedition_project_members_scoped_select
on public.expedition_project_members for select to authenticated using (
  expedition_project_members.user_id = auth.uid()
  or public.is_expedition_project_owner(expedition_project_members.project_id)
);

drop policy if exists expedition_project_invitations_scoped_select on public.expedition_project_invitations;
create policy expedition_project_invitations_scoped_select
on public.expedition_project_invitations for select to authenticated using (
  expedition_project_invitations.invitee_user_id = auth.uid()
  or public.is_expedition_project_owner(expedition_project_invitations.project_id)
);

create or replace function public.can_view_expedition_project(requested_project_id uuid)
returns boolean language sql stable security definer set search_path = '' as $function$
  select public.is_expedition_project_owner(requested_project_id) or exists (
    select 1 from public.expedition_project_members m
    where m.project_id = requested_project_id and m.user_id = auth.uid()
  );
$function$;
alter function public.can_view_expedition_project(uuid) owner to postgres;

create or replace function public.can_edit_expedition_project(requested_project_id uuid)
returns boolean language sql stable security definer set search_path = '' as $function$
  select auth.uid() is not null and exists (
    select 1 from public.expedition_projects p
    where p.id = requested_project_id and p.status <> 'archived' and (
      public.is_expedition_project_owner(p.id) or exists (
        select 1 from public.expedition_project_members m
        where m.project_id = p.id and m.user_id = auth.uid() and m.role = 'editor'
      )
    )
  );
$function$;
alter function public.can_edit_expedition_project(uuid) owner to postgres;
alter function public.get_expedition_project_access_role(uuid) owner to postgres;

revoke all on function public.can_view_expedition_project(uuid), public.can_edit_expedition_project(uuid) from public, anon;
grant execute on function public.can_view_expedition_project(uuid), public.can_edit_expedition_project(uuid) to authenticated;

commit;
