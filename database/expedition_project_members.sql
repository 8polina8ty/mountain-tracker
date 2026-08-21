-- Expedition Projects Phase 11A: members, invitations, and roles.
-- MANUAL DEPLOYMENT ONLY. Apply after database/expedition_projects.sql and
-- database/social_profile_contract.sql. Phase 11B will extend collaborator
-- authorization across the private project graph; this artifact does not.

create table if not exists public.expedition_project_members (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.expedition_projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null constraint expedition_project_members_role_check check (role in ('editor', 'viewer')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint expedition_project_members_project_user_unique unique (project_id, user_id)
);

create table if not exists public.expedition_project_invitations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.expedition_projects(id) on delete cascade,
  inviter_user_id uuid not null references auth.users(id) on delete cascade,
  invitee_user_id uuid not null references auth.users(id) on delete cascade,
  role text not null constraint expedition_project_invitations_role_check check (role in ('editor', 'viewer')),
  status text not null default 'pending' constraint expedition_project_invitations_status_check check (status in ('pending', 'accepted', 'declined', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz,
  constraint expedition_project_invitations_distinct_users check (inviter_user_id <> invitee_user_id)
);

create unique index if not exists expedition_project_invitations_one_pending_idx
  on public.expedition_project_invitations (project_id, invitee_user_id)
  where status = 'pending';
create index if not exists expedition_project_members_user_idx on public.expedition_project_members (user_id, updated_at desc, id);
create index if not exists expedition_project_invitations_invitee_pending_idx on public.expedition_project_invitations (invitee_user_id, created_at desc, id) where status = 'pending';
create index if not exists expedition_project_invitations_project_idx on public.expedition_project_invitations (project_id, created_at desc, id);

create or replace function public.set_expedition_collaboration_updated_at()
returns trigger language plpgsql set search_path = '' as $function$
begin new.updated_at = now(); return new; end;
$function$;
drop trigger if exists expedition_project_members_set_updated_at on public.expedition_project_members;
create trigger expedition_project_members_set_updated_at before update on public.expedition_project_members for each row execute function public.set_expedition_collaboration_updated_at();
drop trigger if exists expedition_project_invitations_set_updated_at on public.expedition_project_invitations;
create trigger expedition_project_invitations_set_updated_at before update on public.expedition_project_invitations for each row execute function public.set_expedition_collaboration_updated_at();

alter table public.expedition_project_members enable row level security;
alter table public.expedition_project_invitations enable row level security;

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
create policy expedition_project_members_scoped_select on public.expedition_project_members for select to authenticated using (
  expedition_project_members.user_id = auth.uid()
  or public.is_expedition_project_owner(expedition_project_members.project_id)
);
drop policy if exists expedition_project_invitations_scoped_select on public.expedition_project_invitations;
create policy expedition_project_invitations_scoped_select on public.expedition_project_invitations for select to authenticated using (
  expedition_project_invitations.invitee_user_id = auth.uid()
  or public.is_expedition_project_owner(expedition_project_invitations.project_id)
);

revoke all on public.expedition_project_members, public.expedition_project_invitations from public, anon, authenticated;
grant select on public.expedition_project_members, public.expedition_project_invitations to authenticated;

create or replace function public.get_expedition_project_access_role(requested_project_id uuid)
returns text language sql stable security definer set search_path = '' as $function$
  select case
    when p.user_id = auth.uid() then 'owner'
    when m.role in ('editor', 'viewer') then m.role
    else 'none'
  end
  from public.expedition_projects p
  left join public.expedition_project_members m on m.project_id = p.id and m.user_id = auth.uid()
  where p.id = requested_project_id and auth.uid() is not null
  union all select 'none' where auth.uid() is not null and not exists (select 1 from public.expedition_projects p where p.id = requested_project_id)
  limit 1;
$function$;
alter function public.get_expedition_project_access_role(uuid) owner to postgres;

create or replace function public.list_incoming_expedition_project_invitations(result_limit integer default 50)
returns table(invitation_id uuid, project_id uuid, project_name text, project_status text, inviter_user_id uuid, inviter_username text, inviter_display_name text, inviter_avatar_url text, role text, created_at timestamptz)
language sql stable security definer set search_path = '' as $function$
  select i.id, p.id, p.name, p.status, i.inviter_user_id, profile.username,
    profile.display_name, profile.avatar_url, i.role, i.created_at
  from public.expedition_project_invitations i
  join public.expedition_projects p on p.id = i.project_id
  join public.profiles profile on profile.id = i.inviter_user_id
  where auth.uid() is not null and i.invitee_user_id = auth.uid() and i.status = 'pending'
    and (i.expires_at is null or i.expires_at > now())
  order by i.created_at desc, i.id desc
  limit least(greatest(coalesce(result_limit, 50), 1), 50);
$function$;

create or replace function public.list_shared_expedition_projects(result_limit integer default 50)
returns table(project_id uuid, project_name text, project_status text, start_date date, end_date date, role text, owner_user_id uuid, owner_username text, owner_display_name text, owner_avatar_url text, updated_at timestamptz)
language sql stable security definer set search_path = '' as $function$
  select p.id, p.name, p.status, p.start_date, p.end_date, m.role, p.user_id,
    profile.username, profile.display_name, profile.avatar_url, p.updated_at
  from public.expedition_project_members m
  join public.expedition_projects p on p.id = m.project_id
  join public.profiles profile on profile.id = p.user_id
  where auth.uid() is not null and m.user_id = auth.uid()
  order by p.updated_at desc, p.id desc
  limit least(greatest(coalesce(result_limit, 50), 1), 50);
$function$;

create or replace function public.invite_expedition_project_member(requested_project_id uuid, requested_invitee_id uuid, requested_role text)
returns uuid language plpgsql volatile security definer set search_path = '' as $function$
declare actor uuid := auth.uid(); project public.expedition_projects%rowtype; created_id uuid;
begin
  if actor is null then raise exception 'Authentication is required.' using errcode = '42501'; end if;
  if requested_role not in ('editor', 'viewer') then raise exception 'Invalid project role.' using errcode = '22023'; end if;
  select * into project from public.expedition_projects p where p.id = requested_project_id for update;
  if not found or project.user_id <> actor then raise exception 'Project unavailable.' using errcode = '42501'; end if;
  if project.status = 'archived' then raise exception 'Archived projects cannot receive new invitations.' using errcode = '22023'; end if;
  if requested_invitee_id is null or requested_invitee_id = actor or not exists (select 1 from public.profiles p where p.id = requested_invitee_id) then raise exception 'Participant unavailable.' using errcode = '22023'; end if;
  if exists (select 1 from public.expedition_project_members m where m.project_id = requested_project_id and m.user_id = requested_invitee_id) then raise exception 'Participant is already a member.' using errcode = '23505'; end if;
  insert into public.expedition_project_invitations(project_id, inviter_user_id, invitee_user_id, role)
  values(requested_project_id, actor, requested_invitee_id, requested_role) returning id into created_id;
  return created_id;
exception when unique_violation then raise exception 'Participant already has a pending invitation.' using errcode = '23505';
end;$function$;

create or replace function public.accept_expedition_project_invitation(invitation_id uuid)
returns boolean language plpgsql volatile security definer set search_path = '' as $function$
declare actor uuid := auth.uid(); invitation public.expedition_project_invitations%rowtype; owner_id uuid;
begin
  if actor is null then raise exception 'Authentication is required.' using errcode = '42501'; end if;
  select * into invitation from public.expedition_project_invitations i where i.id = invitation_id for update;
  if not found or invitation.invitee_user_id <> actor or invitation.status <> 'pending' or (invitation.expires_at is not null and invitation.expires_at <= now()) then raise exception 'Invitation unavailable.' using errcode = '22023'; end if;
  select p.user_id into owner_id from public.expedition_projects p where p.id = invitation.project_id for update;
  if not found or owner_id = actor then raise exception 'Invitation unavailable.' using errcode = '22023'; end if;
  insert into public.expedition_project_members(project_id, user_id, role) values(invitation.project_id, actor, invitation.role) on conflict(project_id, user_id) do nothing;
  if not found then raise exception 'Membership already exists.' using errcode = '23505'; end if;
  update public.expedition_project_invitations set status = 'accepted' where id = invitation.id and status = 'pending';
  if not found then raise exception 'Invitation unavailable.' using errcode = '40001'; end if;
  return true;
end;$function$;

create or replace function public.decline_expedition_project_invitation(invitation_id uuid)
returns boolean language plpgsql volatile security definer set search_path = '' as $function$
begin
  if auth.uid() is null then raise exception 'Authentication is required.' using errcode = '42501'; end if;
  update public.expedition_project_invitations set status = 'declined' where id = invitation_id and invitee_user_id = auth.uid() and status = 'pending';
  if not found then raise exception 'Invitation unavailable.' using errcode = '22023'; end if;
  return true;
end;$function$;

create or replace function public.cancel_expedition_project_invitation(invitation_id uuid)
returns boolean language plpgsql volatile security definer set search_path = '' as $function$
begin
  if auth.uid() is null then raise exception 'Authentication is required.' using errcode = '42501'; end if;
  update public.expedition_project_invitations i set status = 'cancelled' where i.id = invitation_id and i.status = 'pending' and exists (select 1 from public.expedition_projects p where p.id = i.project_id and p.user_id = auth.uid());
  if not found then raise exception 'Invitation unavailable.' using errcode = '22023'; end if;
  return true;
end;$function$;

create or replace function public.change_expedition_project_member_role(requested_project_id uuid, requested_user_id uuid, requested_role text)
returns boolean language plpgsql volatile security definer set search_path = '' as $function$
begin
  if auth.uid() is null then raise exception 'Authentication is required.' using errcode = '42501'; end if;
  if requested_role not in ('editor', 'viewer') then raise exception 'Invalid project role.' using errcode = '22023'; end if;
  update public.expedition_project_members m set role = requested_role where m.project_id = requested_project_id and m.user_id = requested_user_id and exists (select 1 from public.expedition_projects p where p.id = m.project_id and p.user_id = auth.uid() and p.user_id <> m.user_id);
  if not found then raise exception 'Member unavailable.' using errcode = '22023'; end if;
  return true;
end;$function$;

create or replace function public.remove_expedition_project_member(requested_project_id uuid, requested_user_id uuid)
returns boolean language plpgsql volatile security definer set search_path = '' as $function$
begin
  if auth.uid() is null then raise exception 'Authentication is required.' using errcode = '42501'; end if;
  delete from public.expedition_project_members m where m.project_id = requested_project_id and m.user_id = requested_user_id and exists (select 1 from public.expedition_projects p where p.id = m.project_id and p.user_id = auth.uid() and p.user_id <> m.user_id);
  if not found then raise exception 'Member unavailable.' using errcode = '22023'; end if;
  return true;
end;$function$;

create or replace function public.leave_expedition_project(requested_project_id uuid)
returns boolean language plpgsql volatile security definer set search_path = '' as $function$
begin
  if auth.uid() is null then raise exception 'Authentication is required.' using errcode = '42501'; end if;
  if exists (select 1 from public.expedition_projects p where p.id = requested_project_id and p.user_id = auth.uid()) then raise exception 'Project owners cannot leave.' using errcode = '22023'; end if;
  delete from public.expedition_project_members where project_id = requested_project_id and user_id = auth.uid();
  if not found then raise exception 'Membership unavailable.' using errcode = '22023'; end if;
  return true;
end;$function$;

revoke all on function public.get_expedition_project_access_role(uuid), public.list_incoming_expedition_project_invitations(integer), public.list_shared_expedition_projects(integer), public.invite_expedition_project_member(uuid,uuid,text), public.accept_expedition_project_invitation(uuid), public.decline_expedition_project_invitation(uuid), public.cancel_expedition_project_invitation(uuid), public.change_expedition_project_member_role(uuid,uuid,text), public.remove_expedition_project_member(uuid,uuid), public.leave_expedition_project(uuid) from public, anon;
grant execute on function public.get_expedition_project_access_role(uuid), public.list_incoming_expedition_project_invitations(integer), public.list_shared_expedition_projects(integer), public.invite_expedition_project_member(uuid,uuid,text), public.accept_expedition_project_invitation(uuid), public.decline_expedition_project_invitation(uuid), public.cancel_expedition_project_invitation(uuid), public.change_expedition_project_member_role(uuid,uuid,text), public.remove_expedition_project_member(uuid,uuid), public.leave_expedition_project(uuid) to authenticated;
