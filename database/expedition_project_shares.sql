-- Phase 10 manual artifact. Creates a narrow owner-controlled sharing model
-- without granting anon access to private source tables or Storage.
begin;

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

alter table public.expedition_project_shares enable row level security;
create policy expedition_project_shares_select_owned on public.expedition_project_shares for select to authenticated using (user_id = auth.uid());
create policy expedition_project_shares_insert_owned on public.expedition_project_shares for insert to authenticated with check (
  user_id = auth.uid() and exists (select 1 from public.expedition_projects p where p.id = expedition_project_shares.project_id and p.user_id = auth.uid() and p.status in ('completed','archived'))
);
create policy expedition_project_shares_update_owned on public.expedition_project_shares for update to authenticated using (user_id = auth.uid()) with check (
  user_id = auth.uid() and exists (select 1 from public.expedition_projects p where p.id = expedition_project_shares.project_id and p.user_id = auth.uid() and p.status in ('completed','archived'))
);
create policy expedition_project_shares_delete_owned on public.expedition_project_shares for delete to authenticated using (user_id = auth.uid());
revoke all on public.expedition_project_shares from public, anon;
grant select, insert, update, delete on public.expedition_project_shares to authenticated;

create or replace function public.resolve_public_expedition_share(requested_slug text)
returns table(project_id uuid, owner_id uuid)
language sql stable security definer set search_path = '' as $function$
  select s.project_id, s.user_id
  from public.expedition_project_shares s
  join public.expedition_projects p on p.id = s.project_id and p.user_id = s.user_id
  where s.public_slug = requested_slug and s.is_enabled = true and p.status in ('completed','archived')
  limit 1;
$function$;
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
  from public.expedition_project_shares s
  join public.expedition_projects p on p.id = s.project_id and p.user_id = s.user_id
  where s.public_slug = requested_slug
    and s.is_enabled = true
    and p.status in ('completed','archived')
  limit 1;
$function$;
revoke all on function public.get_public_expedition_report(text) from public, anon, authenticated;
grant execute on function public.get_public_expedition_report(text) to service_role;

commit;
