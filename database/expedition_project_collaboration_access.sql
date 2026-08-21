-- Expedition Projects Phase 11B: private collaborator read/edit access.
-- MANUAL DEPLOYMENT ONLY. Apply after expedition_project_members.sql and all
-- Phase 1-10 project/media/track artifacts (including policy repairs).

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

revoke all on function public.can_view_expedition_project(uuid), public.can_edit_expedition_project(uuid) from public, anon;
grant execute on function public.can_view_expedition_project(uuid), public.can_edit_expedition_project(uuid) to authenticated;

drop policy if exists expedition_projects_collaborator_select on public.expedition_projects;
create policy expedition_projects_collaborator_select on public.expedition_projects for select to authenticated using (
  expedition_projects.user_id = auth.uid() or exists (
    select 1 from public.expedition_project_members m
    where m.project_id = expedition_projects.id and m.user_id = auth.uid()
  )
);

-- Owner UPDATE/DELETE remains governed by the original owner policy. Editors
-- never receive direct project-row UPDATE, preventing owner/status tampering.
drop policy if exists expedition_project_mountains_collaboration_select on public.expedition_project_mountains;
create policy expedition_project_mountains_collaboration_select on public.expedition_project_mountains for select to authenticated
using (public.can_view_expedition_project(expedition_project_mountains.project_id));
drop policy if exists expedition_project_mountains_editor_insert on public.expedition_project_mountains;
create policy expedition_project_mountains_editor_insert on public.expedition_project_mountains for insert to authenticated
with check (public.can_edit_expedition_project(expedition_project_mountains.project_id));
drop policy if exists expedition_project_mountains_editor_update on public.expedition_project_mountains;
create policy expedition_project_mountains_editor_update on public.expedition_project_mountains for update to authenticated
using (public.can_edit_expedition_project(expedition_project_mountains.project_id))
with check (public.can_edit_expedition_project(expedition_project_mountains.project_id));
drop policy if exists expedition_project_mountains_editor_delete on public.expedition_project_mountains;
create policy expedition_project_mountains_editor_delete on public.expedition_project_mountains for delete to authenticated
using (public.can_edit_expedition_project(expedition_project_mountains.project_id));

drop policy if exists expedition_project_days_collaboration_select on public.expedition_project_days;
create policy expedition_project_days_collaboration_select on public.expedition_project_days for select to authenticated
using (public.can_view_expedition_project(expedition_project_days.project_id));
drop policy if exists expedition_project_days_editor_insert on public.expedition_project_days;
create policy expedition_project_days_editor_insert on public.expedition_project_days for insert to authenticated
with check (public.can_edit_expedition_project(expedition_project_days.project_id));
drop policy if exists expedition_project_days_editor_update on public.expedition_project_days;
create policy expedition_project_days_editor_update on public.expedition_project_days for update to authenticated
using (public.can_edit_expedition_project(expedition_project_days.project_id))
with check (public.can_edit_expedition_project(expedition_project_days.project_id));
drop policy if exists expedition_project_days_editor_delete on public.expedition_project_days;
create policy expedition_project_days_editor_delete on public.expedition_project_days for delete to authenticated
using (public.can_edit_expedition_project(expedition_project_days.project_id));

drop policy if exists expedition_project_day_mountains_collaboration_select on public.expedition_project_day_mountains;
create policy expedition_project_day_mountains_collaboration_select on public.expedition_project_day_mountains for select to authenticated
using (public.can_view_expedition_project(expedition_project_day_mountains.project_id));
drop policy if exists expedition_project_day_mountains_editor_insert on public.expedition_project_day_mountains;
create policy expedition_project_day_mountains_editor_insert on public.expedition_project_day_mountains for insert to authenticated
with check (public.can_edit_expedition_project(expedition_project_day_mountains.project_id));
drop policy if exists expedition_project_day_mountains_editor_update on public.expedition_project_day_mountains;
create policy expedition_project_day_mountains_editor_update on public.expedition_project_day_mountains for update to authenticated
using (public.can_edit_expedition_project(expedition_project_day_mountains.project_id))
with check (public.can_edit_expedition_project(expedition_project_day_mountains.project_id));
drop policy if exists expedition_project_day_mountains_editor_delete on public.expedition_project_day_mountains;
create policy expedition_project_day_mountains_editor_delete on public.expedition_project_day_mountains for delete to authenticated
using (public.can_edit_expedition_project(expedition_project_day_mountains.project_id));

drop policy if exists expedition_project_journal_collaboration_select on public.expedition_project_journal_entries;
create policy expedition_project_journal_collaboration_select on public.expedition_project_journal_entries for select to authenticated
using (public.can_view_expedition_project(expedition_project_journal_entries.project_id));
drop policy if exists expedition_project_journal_collaboration_insert on public.expedition_project_journal_entries;
create policy expedition_project_journal_collaboration_insert on public.expedition_project_journal_entries for insert to authenticated
with check (expedition_project_journal_entries.user_id = auth.uid() and public.can_edit_expedition_project(expedition_project_journal_entries.project_id));
drop policy if exists expedition_project_journal_author_update on public.expedition_project_journal_entries;
create policy expedition_project_journal_author_update on public.expedition_project_journal_entries for update to authenticated
using (expedition_project_journal_entries.user_id = auth.uid() and public.can_edit_expedition_project(expedition_project_journal_entries.project_id))
with check (expedition_project_journal_entries.user_id = auth.uid() and public.can_edit_expedition_project(expedition_project_journal_entries.project_id));
drop policy if exists expedition_project_journal_author_or_owner_delete on public.expedition_project_journal_entries;
create policy expedition_project_journal_author_or_owner_delete on public.expedition_project_journal_entries for delete to authenticated using (
  public.can_edit_expedition_project(expedition_project_journal_entries.project_id) and (
    expedition_project_journal_entries.user_id = auth.uid() or exists (
      select 1 from public.expedition_projects p where p.id = expedition_project_journal_entries.project_id and p.user_id = auth.uid()
    )
  )
);

drop policy if exists expedition_project_journal_media_collaboration_select on public.expedition_project_journal_media;
create policy expedition_project_journal_media_collaboration_select on public.expedition_project_journal_media for select to authenticated
using (public.can_view_expedition_project(expedition_project_journal_media.project_id));
drop policy if exists expedition_project_journal_media_editor_insert on public.expedition_project_journal_media;
create policy expedition_project_journal_media_editor_insert on public.expedition_project_journal_media for insert to authenticated with check (
  expedition_project_journal_media.user_id = auth.uid()
  and public.can_edit_expedition_project(expedition_project_journal_media.project_id)
  and exists (select 1 from public.expedition_project_journal_entries e where e.id = expedition_project_journal_media.journal_entry_id and e.project_id = expedition_project_journal_media.project_id and e.user_id = auth.uid())
);
drop policy if exists expedition_project_journal_media_author_update on public.expedition_project_journal_media;
create policy expedition_project_journal_media_author_update on public.expedition_project_journal_media for update to authenticated
using (expedition_project_journal_media.user_id = auth.uid() and public.can_edit_expedition_project(expedition_project_journal_media.project_id))
with check (expedition_project_journal_media.user_id = auth.uid() and public.can_edit_expedition_project(expedition_project_journal_media.project_id));
drop policy if exists expedition_project_journal_media_author_or_owner_delete on public.expedition_project_journal_media;
create policy expedition_project_journal_media_author_or_owner_delete on public.expedition_project_journal_media for delete to authenticated using (
  public.can_edit_expedition_project(expedition_project_journal_media.project_id) and (
    expedition_project_journal_media.user_id = auth.uid() or exists (select 1 from public.expedition_projects p where p.id = expedition_project_journal_media.project_id and p.user_id = auth.uid())
  )
);

-- Upload remains strictly uploader-prefixed. Member reads are limited to an
-- exact metadata row in a project they can view. Owner moderation may delete
-- project media; editors may delete only their own uploader-prefixed objects.
drop policy if exists expedition_media_objects_editor_insert on storage.objects;
create policy expedition_media_objects_editor_insert on storage.objects for insert to authenticated with check (
  storage.objects.bucket_id = 'expedition-media'
  and cardinality(storage.foldername(storage.objects.name)) = 4
  and (storage.foldername(storage.objects.name))[1] = auth.uid()::text
  and public.can_edit_expedition_project(((storage.foldername(storage.objects.name))[2])::uuid)
  and exists (
    select 1 from public.expedition_project_journal_entries entry
    where entry.id::text = (storage.foldername(storage.objects.name))[3]
      and entry.project_id::text = (storage.foldername(storage.objects.name))[2]
      and entry.user_id = auth.uid()
  )
);
drop policy if exists expedition_media_objects_collaboration_select on storage.objects;
create policy expedition_media_objects_collaboration_select on storage.objects for select to authenticated using (
  storage.objects.bucket_id = 'expedition-media' and exists (
    select 1 from public.expedition_project_journal_media media
    where media.storage_path = storage.objects.name and public.can_view_expedition_project(media.project_id)
  )
);
drop policy if exists expedition_media_objects_author_or_owner_delete on storage.objects;
create policy expedition_media_objects_author_or_owner_delete on storage.objects for delete to authenticated using (
  storage.objects.bucket_id = 'expedition-media' and (
    exists (
      select 1 from public.expedition_project_journal_media media
      join public.expedition_projects project on project.id = media.project_id
      where media.storage_path = storage.objects.name
        and public.can_edit_expedition_project(media.project_id)
        and (media.user_id = auth.uid() or project.user_id = auth.uid())
    ) or (
      (storage.foldername(storage.objects.name))[1] = auth.uid()::text
      and public.can_edit_expedition_project(((storage.foldername(storage.objects.name))[2])::uuid)
    )
  )
);

alter table public.expedition_project_day_tracks drop constraint if exists expedition_project_day_tracks_project_owner_fk;
alter table public.expedition_project_day_tracks drop constraint if exists expedition_project_day_tracks_project_fk;
alter table public.expedition_project_day_tracks add constraint expedition_project_day_tracks_project_fk
  foreign key (project_id) references public.expedition_projects(id) on delete cascade;

drop policy if exists expedition_project_day_tracks_collaboration_select on public.expedition_project_day_tracks;
create policy expedition_project_day_tracks_collaboration_select on public.expedition_project_day_tracks for select to authenticated
using (public.can_view_expedition_project(expedition_project_day_tracks.project_id));
drop policy if exists expedition_project_day_tracks_editor_insert on public.expedition_project_day_tracks;
create policy expedition_project_day_tracks_editor_insert on public.expedition_project_day_tracks for insert to authenticated with check (
  expedition_project_day_tracks.user_id = auth.uid()
  and public.can_edit_expedition_project(expedition_project_day_tracks.project_id)
  and exists (select 1 from public.expedition_project_days d where d.id = expedition_project_day_tracks.project_day_id and d.project_id = expedition_project_day_tracks.project_id)
  and exists (select 1 from public.gps_activities a where a.id = expedition_project_day_tracks.gps_activity_id and a.user_id = auth.uid())
);
drop policy if exists expedition_project_day_tracks_author_or_owner_delete on public.expedition_project_day_tracks;
create policy expedition_project_day_tracks_author_or_owner_delete on public.expedition_project_day_tracks for delete to authenticated using (
  public.can_edit_expedition_project(expedition_project_day_tracks.project_id)
);

-- Only activities already linked to an accessible project become readable.
-- Unrelated account activities remain protected by their original policies.
drop policy if exists gps_activities_linked_project_select on public.gps_activities;
create policy gps_activities_linked_project_select on public.gps_activities for select to authenticated using (
  exists (select 1 from public.expedition_project_day_tracks relation where relation.gps_activity_id = gps_activities.id and relation.user_id = gps_activities.user_id and public.can_view_expedition_project(relation.project_id))
);
drop policy if exists activity_tracks_linked_project_select on storage.objects;
create policy activity_tracks_linked_project_select on storage.objects for select to authenticated using (
  storage.objects.bucket_id = 'activity-tracks' and exists (
    select 1 from public.gps_activities activity
    join public.expedition_project_day_tracks relation on relation.gps_activity_id = activity.id and relation.user_id = activity.user_id
    where activity.geojson_url = storage.objects.name and public.can_view_expedition_project(relation.project_id)
  )
);

create or replace function public.set_expedition_project_status(requested_project_id uuid, requested_status text)
returns boolean language plpgsql volatile security definer set search_path = '' as $function$
declare actor uuid := auth.uid(); current_status text; is_owner boolean; is_editor boolean;
begin
  if actor is null then raise exception 'Authentication is required.' using errcode = '42501'; end if;
  if requested_status not in ('planning','ready','active','completed','archived') then raise exception 'Invalid status.' using errcode = '22023'; end if;
  select p.status, p.user_id = actor, exists(select 1 from public.expedition_project_members m where m.project_id = p.id and m.user_id = actor and m.role = 'editor')
    into current_status, is_owner, is_editor from public.expedition_projects p where p.id = requested_project_id for update;
  if not found or not (is_owner or is_editor) then raise exception 'Project unavailable.' using errcode = '42501'; end if;
  if not is_owner and (current_status = 'archived' or requested_status = 'archived') then raise exception 'Only the owner may archive or restore a project.' using errcode = '42501'; end if;
  update public.expedition_projects set status = requested_status where id = requested_project_id;
  return true;
end;$function$;

-- Replace Phase 1 owner-only atomic day/mountain functions with owner/editor
-- checks. Archived projects fail can_edit_expedition_project().
create or replace function public.remove_expedition_project_mountain(requested_project_id uuid, requested_mountain_id bigint)
returns boolean language plpgsql volatile security definer set search_path = '' as $function$
declare removed boolean;
begin
  if not public.can_edit_expedition_project(requested_project_id) then raise exception 'Project unavailable.' using errcode = '42501'; end if;
  perform 1 from public.expedition_projects p where p.id = requested_project_id for update;
  delete from public.expedition_project_mountains where project_id = requested_project_id and mountain_id = requested_mountain_id;
  removed := found; return removed;
end;$function$;

create or replace function public.add_expedition_project_day(requested_project_id uuid, requested_title text default null, requested_notes text default null)
returns uuid language plpgsql volatile security definer set search_path = '' as $function$
declare next_day_number integer; created_day_id uuid;
begin
  if not public.can_edit_expedition_project(requested_project_id) then raise exception 'Project unavailable.' using errcode = '42501'; end if;
  perform 1 from public.expedition_projects p where p.id = requested_project_id for update;
  if requested_title is not null and char_length(requested_title) > 160 then raise exception 'Day title is too long.' using errcode = '22023'; end if;
  if requested_notes is not null and char_length(requested_notes) > 8000 then raise exception 'Day notes are too long.' using errcode = '22023'; end if;
  select coalesce(max(d.day_number),0)+1 into next_day_number from public.expedition_project_days d where d.project_id = requested_project_id;
  if next_day_number > 60 then raise exception 'A project may contain at most 60 days.' using errcode = '22023'; end if;
  insert into public.expedition_project_days(project_id,day_number,date,title,notes)
  select p.id,next_day_number,case when p.start_date is null then null else p.start_date+next_day_number-1 end,nullif(btrim(requested_title),''),nullif(btrim(requested_notes),'') from public.expedition_projects p where p.id=requested_project_id returning id into created_day_id;
  return created_day_id;
end;$function$;

create or replace function public.delete_expedition_project_day(requested_day_id uuid)
returns boolean language plpgsql volatile security definer set search_path = '' as $function$
declare target_project_id uuid;
begin
  select d.project_id into target_project_id from public.expedition_project_days d where d.id=requested_day_id;
  if target_project_id is null or not public.can_edit_expedition_project(target_project_id) then raise exception 'Project day unavailable.' using errcode='42501'; end if;
  perform 1 from public.expedition_projects p where p.id=target_project_id for update;
  set constraints expedition_project_days_number_unique deferred;
  delete from public.expedition_project_days where id=requested_day_id;
  update public.expedition_project_days d set day_number=ranked.new_day_number from (select id,row_number() over(order by day_number,id)::integer new_day_number from public.expedition_project_days where project_id=target_project_id) ranked where d.id=ranked.id;
  return true;
end;$function$;

create or replace function public.reorder_expedition_project_days(requested_project_id uuid, requested_day_ids uuid[])
returns boolean language plpgsql volatile security definer set search_path = '' as $function$
declare actual_count integer;
begin
  if not public.can_edit_expedition_project(requested_project_id) then raise exception 'Project unavailable.' using errcode='42501'; end if;
  perform 1 from public.expedition_projects p where p.id=requested_project_id for update;
  select count(*) into actual_count from public.expedition_project_days where project_id=requested_project_id;
  if coalesce(array_length(requested_day_ids,1),0)<>actual_count or (select count(distinct item) from unnest(requested_day_ids)item)<>actual_count or exists(select 1 from unnest(requested_day_ids)item where not exists(select 1 from public.expedition_project_days d where d.project_id=requested_project_id and d.id=item)) then raise exception 'Invalid day order.' using errcode='22023'; end if;
  set constraints expedition_project_days_number_unique deferred;
  update public.expedition_project_days d set day_number=requested.ordinality::integer from unnest(requested_day_ids) with ordinality requested(id,ordinality) where d.id=requested.id and d.project_id=requested_project_id;
  return true;
end;$function$;

revoke all on function public.set_expedition_project_status(uuid,text) from public, anon;
grant execute on function public.set_expedition_project_status(uuid,text) to authenticated;
