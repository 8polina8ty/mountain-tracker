-- Phase 10 manual artifact. Maintains a narrow owner-controlled sharing model
-- without granting anon access to private source tables or Storage.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table if not exists public.expedition_project_shares (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null unique references public.expedition_projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  public_slug text not null unique,
  is_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint expedition_project_shares_slug_check check (public_slug ~ '^[A-Za-z0-9_-]{32,128}$'),
  constraint expedition_project_shares_project_owner_fk foreign key (project_id, user_id)
    references public.expedition_projects(id, user_id) on delete cascade
);

-- Keep this schema outside the Data API's exposed schemas. The helper follows
-- the caller's RLS, including when called inside the existing public resolvers.
create schema if not exists expedition_sharing_private authorization postgres;
revoke all on schema expedition_sharing_private from public, anon, authenticated;
grant usage on schema expedition_sharing_private to authenticated;

create or replace function expedition_sharing_private.is_eligible(project_uuid uuid, owner_uuid uuid)
returns boolean
language sql stable security invoker set search_path = '' as $function$
  select exists (
    select 1
    from public.expedition_projects p
    join public.expedition_project_day_tracks dt on dt.project_id = p.id and dt.user_id = p.user_id
    join public.gps_activities ga on ga.id = dt.gps_activity_id and ga.user_id = dt.user_id
    where p.id = project_uuid and p.user_id = owner_uuid
      and p.status in ('completed', 'archived') and ga.processing_status = 'ready'
  );
$function$;
revoke all on function expedition_sharing_private.is_eligible(uuid, uuid) from public, anon, authenticated;
grant execute on function expedition_sharing_private.is_eligible(uuid, uuid) to authenticated;

alter table public.expedition_project_shares enable row level security;
drop policy if exists expedition_project_shares_select_owned on public.expedition_project_shares;
drop policy if exists expedition_project_shares_insert_owned on public.expedition_project_shares;
drop policy if exists expedition_project_shares_update_owned on public.expedition_project_shares;
drop policy if exists expedition_project_shares_delete_owned on public.expedition_project_shares;
create policy expedition_project_shares_select_owned on public.expedition_project_shares for select to authenticated using (user_id = auth.uid());
create policy expedition_project_shares_insert_owned on public.expedition_project_shares for insert to authenticated with check (
  user_id = auth.uid() and expedition_sharing_private.is_eligible(project_id, user_id)
);
create policy expedition_project_shares_update_owned on public.expedition_project_shares for update to authenticated using (user_id = auth.uid()) with check (
  -- The composite FK still binds a disabled row to its project owner.
  user_id = auth.uid()
  and case when is_enabled then expedition_sharing_private.is_eligible(project_id, user_id) else true end
);
create policy expedition_project_shares_delete_owned on public.expedition_project_shares for delete to authenticated using (user_id = auth.uid());
revoke all on public.expedition_project_shares from public, anon;
grant select, insert, update, delete on public.expedition_project_shares to authenticated;

create or replace function public.can_enable_expedition_sharing(target_project_id uuid)
returns boolean
language sql stable security invoker set search_path = '' as $function$
  select expedition_sharing_private.is_eligible(target_project_id, auth.uid());
$function$;
revoke all on function public.can_enable_expedition_sharing(uuid) from public, anon, authenticated;
grant execute on function public.can_enable_expedition_sharing(uuid) to authenticated;

-- Keep direct table writes under RLS. This RPC confirms the owner, preserves
-- the existing slug on enable, and reports the actual resulting share state.
create or replace function public.set_expedition_sharing(
  target_project_id uuid, enable_sharing boolean, proposed_slug text default null
)
returns jsonb
language plpgsql volatile security invoker set search_path = '' as $function$
declare
  actor uuid := auth.uid();
  affected_slug text;
begin
  if actor is null or enable_sharing is null or not exists (
    select 1 from public.expedition_projects p
    where p.id = target_project_id and p.user_id = actor
  ) then
    raise exception 'Expedition owner required' using errcode = '42501';
  end if;

  if enable_sharing then
    insert into public.expedition_project_shares as s (project_id, user_id, public_slug, is_enabled)
    values (target_project_id, actor, proposed_slug, true)
    on conflict (project_id) do update set is_enabled = true, updated_at = now()
    where s.user_id = actor
    returning s.public_slug into affected_slug;
    if not found then
      raise exception 'Expedition share was not enabled';
    end if;
    return jsonb_build_object('enabled', true, 'slug', affected_slug);
  end if;

  update public.expedition_project_shares as s set is_enabled = false, updated_at = now()
  where s.project_id = target_project_id and s.user_id = actor and s.is_enabled
  returning s.public_slug into affected_slug;
  if not found and exists (
    select 1 from public.expedition_project_shares s
    where s.project_id = target_project_id and s.user_id = actor and s.is_enabled
  ) then
    raise exception 'Expedition share was not disabled';
  end if;
  return jsonb_build_object('enabled', false);
end;
$function$;
revoke all on function public.set_expedition_sharing(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.set_expedition_sharing(uuid, boolean, text) to authenticated;

create or replace function public.resolve_public_expedition_share(requested_slug text)
returns table(project_id uuid, owner_id uuid)
language sql stable security definer set search_path = '' as $function$
  select s.project_id, s.user_id
  from public.expedition_project_shares s
  where s.public_slug = requested_slug and s.is_enabled = true
    and expedition_sharing_private.is_eligible(s.project_id, s.user_id)
  limit 1;
$function$;
alter function public.resolve_public_expedition_share(text) owner to postgres;
revoke all on function public.resolve_public_expedition_share(text) from public, anon, authenticated;
grant execute on function public.resolve_public_expedition_share(text) to service_role;

create or replace function public.get_public_expedition_report(requested_slug text)
returns jsonb
language sql stable security definer set search_path = '' as $function$
  select jsonb_build_object(
    'name', p.name,
    'status', p.status,
    'startDate', p.start_date,
    'endDate', p.end_date
  )
  from public.resolve_public_expedition_share(requested_slug) s
  join public.expedition_projects p on p.id = s.project_id and p.user_id = s.owner_id;
$function$;
alter function public.get_public_expedition_report(text) owner to postgres;
revoke all on function public.get_public_expedition_report(text) from public, anon, authenticated;
grant execute on function public.get_public_expedition_report(text) to service_role;

commit;
