-- Expedition Projects Phase 11C: private immutable activity history.
-- MANUAL REVIEW AND DEPLOYMENT ONLY. Apply after Phase 11B and both RLS repairs.

begin;

create table public.expedition_project_activity (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.expedition_projects(id) on delete cascade,
  actor_user_id uuid not null,
  action_type text not null check (action_type in (
    'project.status_changed','project.archived','project.restored',
    'mountain.added','mountain.removed','mountain.assigned_to_day','mountain.unassigned_from_day',
    'day.created','day.updated','day.deleted','day.reordered',
    'journal.created','journal.updated','journal.deleted',
    'media.photo_uploaded','media.video_uploaded','media.deleted',
    'track.linked','track.imported_and_linked','track.unlinked',
    'member.joined','member.role_changed','member.removed','member.left',
    'sharing.enabled','sharing.disabled'
  )),
  resource_type text not null check (resource_type in ('project','mountain','day','journal','media','track','member','sharing')),
  resource_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint expedition_project_activity_metadata_object check (jsonb_typeof(metadata) = 'object'),
  constraint expedition_project_activity_metadata_size check (octet_length(metadata::text) <= 1024)
);

create index expedition_project_activity_timeline_idx
  on public.expedition_project_activity(project_id, created_at desc, id desc);

alter table public.expedition_project_activity enable row level security;
create policy expedition_project_activity_collaboration_select
on public.expedition_project_activity for select to authenticated
using (public.can_view_expedition_project(expedition_project_activity.project_id));

revoke all on public.expedition_project_activity from public, anon, authenticated;
grant select on public.expedition_project_activity to authenticated;

create or replace function public.record_expedition_project_activity(
  requested_project_id uuid,
  requested_action_type text,
  requested_resource_type text,
  requested_resource_id text default null,
  requested_metadata jsonb default '{}'::jsonb
) returns void language plpgsql volatile security definer set search_path = '' as $function$
declare actor uuid := auth.uid();
begin
  if actor is null then return; end if;
  if requested_metadata ?| array['body','title','notes','description','storage_path','filename','email','token','slug','geometry','geojson','gpx'] then
    raise exception 'Unsafe activity metadata.' using errcode = '22023';
  end if;
  if requested_action_type in ('project.status_changed','project.archived','project.restored','member.role_changed') then
    if requested_metadata - array['from','to'] <> '{}'::jsonb then raise exception 'Invalid activity metadata.' using errcode = '22023'; end if;
  elsif requested_action_type in ('media.photo_uploaded','media.video_uploaded') then
    if requested_metadata - array['mediaType','count'] <> '{}'::jsonb then raise exception 'Invalid activity metadata.' using errcode = '22023'; end if;
  elsif requested_action_type in ('mountain.assigned_to_day','mountain.unassigned_from_day') then
    if requested_metadata - 'mountainId' <> '{}'::jsonb then raise exception 'Invalid activity metadata.' using errcode = '22023'; end if;
  elsif requested_action_type = 'day.reordered' then
    if requested_metadata - 'dayCount' <> '{}'::jsonb then raise exception 'Invalid activity metadata.' using errcode = '22023'; end if;
  elsif requested_metadata <> '{}'::jsonb then
    raise exception 'Activity metadata is not allowed for this action.' using errcode = '22023';
  end if;
  insert into public.expedition_project_activity(project_id,actor_user_id,action_type,resource_type,resource_id,metadata)
  values(requested_project_id,actor,requested_action_type,requested_resource_type,requested_resource_id,coalesce(requested_metadata,'{}'::jsonb));
end;$function$;
alter function public.record_expedition_project_activity(uuid,text,text,text,jsonb) owner to postgres;
revoke all on function public.record_expedition_project_activity(uuid,text,text,text,jsonb) from public, anon, authenticated;

create or replace function public.capture_expedition_project_status_activity()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  if old.status is distinct from new.status then
    perform public.record_expedition_project_activity(new.id,
      case when new.status='archived' then 'project.archived' when old.status='archived' then 'project.restored' else 'project.status_changed' end,
      'project',new.id::text,jsonb_build_object('from',old.status,'to',new.status));
  end if; return new;
end;$function$;

create or replace function public.capture_expedition_project_mountain_activity()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  perform public.record_expedition_project_activity(coalesce(new.project_id,old.project_id),case when tg_op='INSERT' then 'mountain.added' else 'mountain.removed' end,'mountain',coalesce(new.mountain_id,old.mountain_id)::text,'{}'::jsonb);
  if tg_op='DELETE' then return old; end if; return new;
end;$function$;

create or replace function public.capture_expedition_project_day_activity()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  if tg_op='UPDATE' and current_setting('app.expedition_skip_day_update_activity',true)='on' then return new; end if;
  perform public.record_expedition_project_activity(coalesce(new.project_id,old.project_id),case tg_op when 'INSERT' then 'day.created' when 'UPDATE' then 'day.updated' else 'day.deleted' end,'day',coalesce(new.id,old.id)::text,'{}'::jsonb);
  if tg_op='DELETE' then return old; end if; return new;
end;$function$;

create or replace function public.capture_expedition_project_day_mountain_activity()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  perform public.record_expedition_project_activity(coalesce(new.project_id,old.project_id),case when tg_op='INSERT' then 'mountain.assigned_to_day' else 'mountain.unassigned_from_day' end,'day',coalesce(new.project_day_id,old.project_day_id)::text,jsonb_build_object('mountainId',coalesce(new.mountain_id,old.mountain_id)));
  if tg_op='DELETE' then return old; end if; return new;
end;$function$;

create or replace function public.capture_expedition_project_journal_activity()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  perform public.record_expedition_project_activity(coalesce(new.project_id,old.project_id),case tg_op when 'INSERT' then 'journal.created' when 'UPDATE' then 'journal.updated' else 'journal.deleted' end,'journal',coalesce(new.id,old.id)::text,'{}'::jsonb);
  if tg_op='DELETE' then return old; end if; return new;
end;$function$;

create or replace function public.capture_expedition_project_media_activity()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  perform public.record_expedition_project_activity(coalesce(new.project_id,old.project_id),case when tg_op='DELETE' then 'media.deleted' when new.media_type='video' then 'media.video_uploaded' else 'media.photo_uploaded' end,'media',coalesce(new.id,old.id)::text,case when tg_op='DELETE' then '{}'::jsonb else jsonb_build_object('mediaType',new.media_type,'count',1) end);
  if tg_op='DELETE' then return old; end if; return new;
end;$function$;

create or replace function public.capture_expedition_project_track_activity()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  perform public.record_expedition_project_activity(coalesce(new.project_id,old.project_id),case when tg_op='DELETE' then 'track.unlinked' when current_setting('app.expedition_imported_track_link',true)='on' then 'track.imported_and_linked' else 'track.linked' end,'track',coalesce(new.id,old.id)::text,'{}'::jsonb);
  if tg_op='DELETE' then return old; end if; return new;
end;$function$;

create or replace function public.capture_expedition_project_member_activity()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  perform public.record_expedition_project_activity(coalesce(new.project_id,old.project_id),case when tg_op='INSERT' then 'member.joined' when tg_op='UPDATE' then 'member.role_changed' when auth.uid()=old.user_id then 'member.left' else 'member.removed' end,'member',coalesce(new.user_id,old.user_id)::text,case when tg_op='UPDATE' then jsonb_build_object('from',old.role,'to',new.role) else '{}'::jsonb end);
  if tg_op='DELETE' then return old; end if; return new;
end;$function$;

create or replace function public.capture_expedition_project_sharing_activity()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  if tg_op='INSERT' or old.is_enabled is distinct from new.is_enabled then
    perform public.record_expedition_project_activity(new.project_id,case when new.is_enabled then 'sharing.enabled' else 'sharing.disabled' end,'sharing',new.project_id::text,'{}'::jsonb);
  end if; return new;
end;$function$;

create trigger expedition_project_status_activity after update of status on public.expedition_projects for each row execute function public.capture_expedition_project_status_activity();
create trigger expedition_project_mountain_activity after insert or delete on public.expedition_project_mountains for each row execute function public.capture_expedition_project_mountain_activity();
create trigger expedition_project_day_create_delete_activity after insert or delete on public.expedition_project_days for each row execute function public.capture_expedition_project_day_activity();
create trigger expedition_project_day_update_activity after update of title,notes,date on public.expedition_project_days for each row execute function public.capture_expedition_project_day_activity();
create trigger expedition_project_day_mountain_activity after insert or delete on public.expedition_project_day_mountains for each row execute function public.capture_expedition_project_day_mountain_activity();
create trigger expedition_project_journal_activity after insert or update or delete on public.expedition_project_journal_entries for each row execute function public.capture_expedition_project_journal_activity();
create trigger expedition_project_media_activity after insert or delete on public.expedition_project_journal_media for each row execute function public.capture_expedition_project_media_activity();
create trigger expedition_project_track_activity after insert or delete on public.expedition_project_day_tracks for each row execute function public.capture_expedition_project_track_activity();
create trigger expedition_project_member_join_leave_activity after insert or delete on public.expedition_project_members for each row execute function public.capture_expedition_project_member_activity();
create trigger expedition_project_member_role_activity after update of role on public.expedition_project_members for each row execute function public.capture_expedition_project_member_activity();
create trigger expedition_project_sharing_create_activity after insert on public.expedition_project_shares for each row execute function public.capture_expedition_project_sharing_activity();
create trigger expedition_project_sharing_update_activity after update of is_enabled on public.expedition_project_shares for each row execute function public.capture_expedition_project_sharing_activity();

alter function public.capture_expedition_project_status_activity() owner to postgres;
alter function public.capture_expedition_project_mountain_activity() owner to postgres;
alter function public.capture_expedition_project_day_activity() owner to postgres;
alter function public.capture_expedition_project_day_mountain_activity() owner to postgres;
alter function public.capture_expedition_project_journal_activity() owner to postgres;
alter function public.capture_expedition_project_media_activity() owner to postgres;
alter function public.capture_expedition_project_track_activity() owner to postgres;
alter function public.capture_expedition_project_member_activity() owner to postgres;
alter function public.capture_expedition_project_sharing_activity() owner to postgres;
revoke all on function public.capture_expedition_project_status_activity(), public.capture_expedition_project_mountain_activity(), public.capture_expedition_project_day_activity(), public.capture_expedition_project_day_mountain_activity(), public.capture_expedition_project_journal_activity(), public.capture_expedition_project_media_activity(), public.capture_expedition_project_track_activity(), public.capture_expedition_project_member_activity(), public.capture_expedition_project_sharing_activity() from public, anon, authenticated;

create or replace function public.reorder_expedition_project_days(requested_project_id uuid, requested_day_ids uuid[])
returns boolean language plpgsql volatile security definer set search_path = '' as $function$
declare actual_count integer;
begin
  if not public.can_edit_expedition_project(requested_project_id) then raise exception 'Project unavailable.' using errcode='42501'; end if;
  perform 1 from public.expedition_projects p where p.id=requested_project_id for update;
  select count(*) into actual_count from public.expedition_project_days where project_id=requested_project_id;
  if coalesce(array_length(requested_day_ids,1),0)<>actual_count or (select count(distinct item) from unnest(requested_day_ids)item)<>actual_count or exists(select 1 from unnest(requested_day_ids)item where not exists(select 1 from public.expedition_project_days d where d.project_id=requested_project_id and d.id=item)) then raise exception 'Invalid day order.' using errcode='22023'; end if;
  perform set_config('app.expedition_skip_day_update_activity','on',true);
  set constraints expedition_project_days_number_unique deferred;
  update public.expedition_project_days d set day_number=requested.ordinality::integer from unnest(requested_day_ids) with ordinality requested(id,ordinality) where d.id=requested.id and d.project_id=requested_project_id;
  perform public.record_expedition_project_activity(requested_project_id,'day.reordered','day',null,jsonb_build_object('dayCount',actual_count));
  return true;
end;$function$;
alter function public.reorder_expedition_project_days(uuid,uuid[]) owner to postgres;

create or replace function public.link_expedition_project_day_track(requested_project_id uuid, requested_day_id uuid, requested_activity_id bigint)
returns uuid language plpgsql volatile security definer set search_path = '' as $function$
declare actor uuid:=auth.uid(); relation_id uuid;
begin
  if actor is null or not public.can_edit_expedition_project(requested_project_id) then raise exception 'Project unavailable.' using errcode='42501'; end if;
  if not exists(select 1 from public.expedition_project_days d where d.id=requested_day_id and d.project_id=requested_project_id) or not exists(select 1 from public.gps_activities a where a.id=requested_activity_id and a.user_id=actor) then raise exception 'Project day or track unavailable.' using errcode='42501'; end if;
  insert into public.expedition_project_day_tracks(project_id,project_day_id,gps_activity_id,user_id) values(requested_project_id,requested_day_id,requested_activity_id,actor) returning id into relation_id;
  return relation_id;
end;$function$;

create or replace function public.link_imported_expedition_project_day_track(requested_project_id uuid, requested_day_id uuid, requested_activity_id bigint)
returns uuid language plpgsql volatile security definer set search_path = '' as $function$
begin
  perform set_config('app.expedition_imported_track_link','on',true);
  return public.link_expedition_project_day_track(requested_project_id,requested_day_id,requested_activity_id);
end;$function$;

create or replace function public.unlink_expedition_project_day_track(requested_relation_id uuid)
returns boolean language plpgsql volatile security definer set search_path = '' as $function$
declare target_project_id uuid;
begin
  select t.project_id into target_project_id from public.expedition_project_day_tracks t where t.id=requested_relation_id;
  if target_project_id is null or not public.can_edit_expedition_project(target_project_id) then raise exception 'Project track unavailable.' using errcode='42501'; end if;
  delete from public.expedition_project_day_tracks where id=requested_relation_id;
  return found;
end;$function$;

alter function public.link_expedition_project_day_track(uuid,uuid,bigint) owner to postgres;
alter function public.link_imported_expedition_project_day_track(uuid,uuid,bigint) owner to postgres;
alter function public.unlink_expedition_project_day_track(uuid) owner to postgres;
revoke all on function public.link_expedition_project_day_track(uuid,uuid,bigint), public.link_imported_expedition_project_day_track(uuid,uuid,bigint), public.unlink_expedition_project_day_track(uuid) from public, anon;
grant execute on function public.link_expedition_project_day_track(uuid,uuid,bigint), public.link_imported_expedition_project_day_track(uuid,uuid,bigint), public.unlink_expedition_project_day_track(uuid) to authenticated;

commit;
