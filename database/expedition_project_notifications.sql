-- Expedition Projects Phase 11D: recipient-owned collaboration notifications.
-- MANUAL REVIEW AND DEPLOYMENT ONLY. Apply after Phase 11C.

begin;

create table public.expedition_project_notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  actor_user_id uuid,
  project_id uuid references public.expedition_projects(id) on delete set null,
  activity_id uuid references public.expedition_project_activity(id) on delete set null,
  notification_type text not null check (notification_type in (
    'invitation.received','invitation.accepted','member.role_changed','member.removed','member.left',
    'project.status_changed','mountain.added','journal.created','track.linked','sharing.enabled','sharing.disabled'
  )),
  source_key text,
  metadata jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  constraint expedition_project_notifications_not_self check (recipient_user_id <> actor_user_id),
  constraint expedition_project_notifications_metadata_object check (jsonb_typeof(metadata) = 'object'),
  constraint expedition_project_notifications_metadata_size check (octet_length(metadata::text) <= 1024)
);

create unique index expedition_project_notifications_activity_recipient_idx
  on public.expedition_project_notifications(activity_id,recipient_user_id,notification_type)
  where activity_id is not null;
create unique index expedition_project_notifications_source_recipient_idx
  on public.expedition_project_notifications(recipient_user_id,notification_type,source_key)
  where source_key is not null;
create index expedition_project_notifications_inbox_idx
  on public.expedition_project_notifications(recipient_user_id,created_at desc,id desc);
create index expedition_project_notifications_unread_idx
  on public.expedition_project_notifications(recipient_user_id) where read_at is null;

alter table public.expedition_project_notifications enable row level security;
create policy expedition_project_notifications_recipient_select
  on public.expedition_project_notifications for select to authenticated
  using (recipient_user_id = auth.uid());
revoke all on public.expedition_project_notifications from public, anon, authenticated;
grant select on public.expedition_project_notifications to authenticated;

create or replace function public.project_notification_metadata(requested_project_id uuid, requested_metadata jsonb default '{}'::jsonb)
returns jsonb language sql stable security definer set search_path = '' as $function$
  select jsonb_strip_nulls(jsonb_build_object('projectName',left(p.name,160)) || coalesce(requested_metadata,'{}'::jsonb))
  from public.expedition_projects p where p.id=requested_project_id;
$function$;
alter function public.project_notification_metadata(uuid,jsonb) owner to postgres;
revoke all on function public.project_notification_metadata(uuid,jsonb) from public, anon, authenticated;

create or replace function public.fan_out_expedition_project_activity_notification()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare mapped_type text; affected_user uuid; extra jsonb := '{}'::jsonb;
begin
  mapped_type := case new.action_type
    when 'member.joined' then 'invitation.accepted'
    when 'member.role_changed' then 'member.role_changed'
    when 'member.removed' then 'member.removed'
    when 'member.left' then 'member.left'
    when 'project.status_changed' then 'project.status_changed'
    when 'project.archived' then 'project.status_changed'
    when 'project.restored' then 'project.status_changed'
    when 'mountain.added' then 'mountain.added'
    when 'journal.created' then 'journal.created'
    when 'track.linked' then 'track.linked'
    when 'track.imported_and_linked' then 'track.linked'
    when 'sharing.enabled' then 'sharing.enabled'
    when 'sharing.disabled' then 'sharing.disabled'
    else null end;
  if mapped_type is null then return new; end if;
  extra := case when new.action_type in ('project.status_changed','project.archived','project.restored','member.role_changed')
    then new.metadata else '{}'::jsonb end;
  if new.action_type like 'member.%' then
    begin affected_user := new.resource_id::uuid; exception when invalid_text_representation then return new; end;
    if new.action_type='member.joined' then
      insert into public.expedition_project_notifications(recipient_user_id,actor_user_id,project_id,activity_id,notification_type,metadata,created_at)
      select p.user_id,new.actor_user_id,new.project_id,new.id,mapped_type,public.project_notification_metadata(new.project_id,extra),new.created_at
      from public.expedition_projects p where p.id=new.project_id and p.user_id<>new.actor_user_id on conflict do nothing;
    elsif new.action_type in ('member.role_changed','member.removed') and affected_user<>new.actor_user_id then
      insert into public.expedition_project_notifications(recipient_user_id,actor_user_id,project_id,activity_id,notification_type,metadata,created_at)
      values(affected_user,new.actor_user_id,new.project_id,new.id,mapped_type,public.project_notification_metadata(new.project_id,extra),new.created_at) on conflict do nothing;
    elsif new.action_type='member.left' then
      insert into public.expedition_project_notifications(recipient_user_id,actor_user_id,project_id,activity_id,notification_type,metadata,created_at)
      select p.user_id,new.actor_user_id,new.project_id,new.id,mapped_type,public.project_notification_metadata(new.project_id),new.created_at
      from public.expedition_projects p where p.id=new.project_id and p.user_id<>new.actor_user_id on conflict do nothing;
    end if;
    return new;
  end if;
  insert into public.expedition_project_notifications(recipient_user_id,actor_user_id,project_id,activity_id,notification_type,metadata,created_at)
  select recipient,new.actor_user_id,new.project_id,new.id,mapped_type,public.project_notification_metadata(new.project_id,extra),new.created_at
  from (select p.user_id recipient from public.expedition_projects p where p.id=new.project_id
        union select m.user_id from public.expedition_project_members m where m.project_id=new.project_id) participants
  where recipient<>new.actor_user_id on conflict do nothing;
  return new;
end;$function$;
alter function public.fan_out_expedition_project_activity_notification() owner to postgres;
revoke all on function public.fan_out_expedition_project_activity_notification() from public, anon, authenticated;
create trigger expedition_project_activity_notify after insert on public.expedition_project_activity
  for each row execute function public.fan_out_expedition_project_activity_notification();

create or replace function public.mark_expedition_project_notification_read(requested_notification_id uuid)
returns boolean language plpgsql volatile security definer set search_path = '' as $function$
begin
  if auth.uid() is null then raise exception 'Authentication is required.' using errcode='42501'; end if;
  update public.expedition_project_notifications set read_at=coalesce(read_at,now())
  where id=requested_notification_id and recipient_user_id=auth.uid();
  return found;
end;$function$;
create or replace function public.mark_all_expedition_project_notifications_read()
returns integer language plpgsql volatile security definer set search_path = '' as $function$
declare changed integer;
begin
  if auth.uid() is null then raise exception 'Authentication is required.' using errcode='42501'; end if;
  update public.expedition_project_notifications set read_at=now() where recipient_user_id=auth.uid() and read_at is null;
  get diagnostics changed = row_count; return changed;
end;$function$;
alter function public.mark_expedition_project_notification_read(uuid) owner to postgres;
alter function public.mark_all_expedition_project_notifications_read() owner to postgres;
revoke all on function public.mark_expedition_project_notification_read(uuid),public.mark_all_expedition_project_notifications_read() from public,anon;
grant execute on function public.mark_expedition_project_notification_read(uuid),public.mark_all_expedition_project_notifications_read() to authenticated;

create or replace function public.get_social_inbox_summary()
returns jsonb language sql stable security definer set search_path = '' as $function$
with unread_by_conversation as (
  select cm.conversation_id,count(*)::integer unread_count from public.conversation_members cm
  join public.messages m on m.conversation_id=cm.conversation_id and m.id>coalesce(cm.last_read_message_id,0)
    and m.sender_id<>cm.user_id and m.deleted_at is null
  where cm.user_id=auth.uid() and cm.left_at is null group by cm.conversation_id
), message_summary as (
  select coalesce(sum(unread_count),0)::integer total,coalesce(jsonb_object_agg(conversation_id::text,unread_count),'{}'::jsonb) conversations
  from unread_by_conversation
)
select jsonb_build_object('totalUnreadMessages',message_summary.total,'unreadConversations',message_summary.conversations,
  'totalUnreadProjectNotifications',(select count(*)::integer from public.expedition_project_notifications n where n.recipient_user_id=auth.uid() and n.read_at is null))
from message_summary;
$function$;
revoke all on function public.get_social_inbox_summary() from public,anon;
grant execute on function public.get_social_inbox_summary() to authenticated;

-- Invitation delivery is the sole notification not projected from Phase 11C activity.
create or replace function public.invite_expedition_project_member(requested_project_id uuid, requested_invitee_id uuid, requested_role text)
returns uuid language plpgsql volatile security definer set search_path = '' as $function$
declare actor uuid := auth.uid(); project public.expedition_projects%rowtype; created_id uuid;
begin
  if actor is null then raise exception 'Authentication is required.' using errcode='42501'; end if;
  if requested_role not in ('editor','viewer') then raise exception 'Invalid project role.' using errcode='22023'; end if;
  select * into project from public.expedition_projects p where p.id=requested_project_id for update;
  if not found or project.user_id<>actor then raise exception 'Project unavailable.' using errcode='42501'; end if;
  if project.status='archived' then raise exception 'Archived projects cannot receive new invitations.' using errcode='22023'; end if;
  if requested_invitee_id is null or requested_invitee_id=actor or not exists(select 1 from public.profiles p where p.id=requested_invitee_id) then raise exception 'Participant unavailable.' using errcode='22023'; end if;
  if exists(select 1 from public.expedition_project_members m where m.project_id=requested_project_id and m.user_id=requested_invitee_id) then raise exception 'Participant is already a member.' using errcode='23505'; end if;
  insert into public.expedition_project_invitations(project_id,inviter_user_id,invitee_user_id,role)
  values(requested_project_id,actor,requested_invitee_id,requested_role) returning id into created_id;
  insert into public.expedition_project_notifications(recipient_user_id,actor_user_id,project_id,notification_type,source_key,metadata)
  values(requested_invitee_id,actor,requested_project_id,'invitation.received',created_id::text,
    public.project_notification_metadata(requested_project_id,jsonb_build_object('role',requested_role))) on conflict do nothing;
  return created_id;
exception when unique_violation then raise exception 'Participant already has a pending invitation.' using errcode='23505';
end;$function$;
revoke all on function public.invite_expedition_project_member(uuid,uuid,text) from public,anon;
grant execute on function public.invite_expedition_project_member(uuid,uuid,text) to authenticated;

commit;
