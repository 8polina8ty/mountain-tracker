-- Expedition Projects Phase 11E: optimistic concurrency and idempotent races.
-- MANUAL REVIEW AND DEPLOYMENT ONLY. Apply after Phase 11D.
begin;

create or replace function public.expedition_mutation_denial(requested_project_id uuid)
returns text language sql stable security definer set search_path='' as $function$
  select case when auth.uid() is null then 'auth'
    when not public.can_view_expedition_project(requested_project_id) then 'permission'
    when exists(select 1 from public.expedition_projects p where p.id=requested_project_id and p.status='archived') then 'archived'
    else 'permission' end;
$function$;
alter function public.expedition_mutation_denial(uuid) owner to postgres;
revoke all on function public.expedition_mutation_denial(uuid) from public,anon,authenticated;

create or replace function public.update_expedition_project_day_if_current(requested_project_id uuid,requested_day_id uuid,expected_updated_at timestamptz,requested_title text,requested_notes text)
returns jsonb language plpgsql volatile security definer set search_path='' as $function$
declare next_version timestamptz; existing_version timestamptz;
begin
 if not public.can_edit_expedition_project(requested_project_id) then return jsonb_build_object('status',public.expedition_mutation_denial(requested_project_id)); end if;
 if requested_title is not null and char_length(requested_title)>160 or requested_notes is not null and char_length(requested_notes)>8000 then return jsonb_build_object('status','validation'); end if;
 update public.expedition_project_days set title=nullif(btrim(requested_title),''),notes=nullif(btrim(requested_notes),'')
 where id=requested_day_id and project_id=requested_project_id and updated_at=expected_updated_at returning updated_at into next_version;
 if found then return jsonb_build_object('status','success','updatedAt',next_version); end if;
 select updated_at into existing_version from public.expedition_project_days where id=requested_day_id and project_id=requested_project_id;
 return jsonb_build_object('status',case when existing_version is null then 'not-found' else 'conflict' end);
end;$function$;

create or replace function public.update_expedition_project_journal_if_current(requested_project_id uuid,requested_entry_id uuid,expected_updated_at timestamptz,requested_title text,requested_body text,requested_entry_date date,requested_project_day_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $function$
declare next_version timestamptz; existing_version timestamptz;
begin
 if not public.can_edit_expedition_project(requested_project_id) then return jsonb_build_object('status',public.expedition_mutation_denial(requested_project_id)); end if;
 if requested_body is null or char_length(btrim(requested_body))>20000 or char_length(coalesce(requested_title,''))>160 then return jsonb_build_object('status','validation'); end if;
 if requested_project_day_id is not null and not exists(select 1 from public.expedition_project_days d where d.id=requested_project_day_id and d.project_id=requested_project_id) then return jsonb_build_object('status','validation'); end if;
 update public.expedition_project_journal_entries set title=nullif(btrim(requested_title),''),body=btrim(requested_body),entry_date=requested_entry_date,project_day_id=requested_project_day_id
 where id=requested_entry_id and project_id=requested_project_id and user_id=auth.uid() and updated_at=expected_updated_at returning updated_at into next_version;
 if found then return jsonb_build_object('status','success','updatedAt',next_version); end if;
 select updated_at into existing_version from public.expedition_project_journal_entries where id=requested_entry_id and project_id=requested_project_id and user_id=auth.uid();
 return jsonb_build_object('status',case when existing_version is null then 'not-found' else 'conflict' end);
end;$function$;

create or replace function public.reorder_expedition_project_days_if_current(requested_project_id uuid,requested_day_ids uuid[],expected_day_ids uuid[],expected_updated_ats timestamptz[])
returns jsonb language plpgsql volatile security definer set search_path='' as $function$
declare actual_count integer; changed_count integer;
begin
 if not public.can_edit_expedition_project(requested_project_id) then return jsonb_build_object('status',public.expedition_mutation_denial(requested_project_id)); end if;
 perform 1 from public.expedition_projects p where p.id=requested_project_id for update;
 select count(*) into actual_count from public.expedition_project_days where project_id=requested_project_id;
 if coalesce(array_length(requested_day_ids,1),0)<>actual_count or array_length(expected_day_ids,1) is distinct from actual_count or array_length(expected_updated_ats,1) is distinct from actual_count then return jsonb_build_object('status','conflict'); end if;
 if exists(select 1 from unnest(expected_day_ids,expected_updated_ats) expected(id,version) where not exists(select 1 from public.expedition_project_days d where d.project_id=requested_project_id and d.id=expected.id and d.updated_at=expected.version)) then return jsonb_build_object('status','conflict'); end if;
 if (select count(distinct item) from unnest(requested_day_ids)item)<>actual_count or exists(select 1 from unnest(requested_day_ids)item where not exists(select 1 from public.expedition_project_days d where d.project_id=requested_project_id and d.id=item)) then return jsonb_build_object('status','validation'); end if;
 set constraints expedition_project_days_number_unique deferred;
 update public.expedition_project_days d set day_number=requested.ordinality::integer from unnest(requested_day_ids) with ordinality requested(id,ordinality) where d.id=requested.id and d.project_id=requested_project_id and d.day_number<>requested.ordinality;
 get diagnostics changed_count=row_count;
 if changed_count=0 then return jsonb_build_object('status','already-applied'); end if;
 return jsonb_build_object('status','success');
end;$function$;

alter function public.update_expedition_project_day_if_current(uuid,uuid,timestamptz,text,text) owner to postgres;
alter function public.update_expedition_project_journal_if_current(uuid,uuid,timestamptz,text,text,date,uuid) owner to postgres;
alter function public.reorder_expedition_project_days_if_current(uuid,uuid[],uuid[],timestamptz[]) owner to postgres;
revoke all on function public.update_expedition_project_day_if_current(uuid,uuid,timestamptz,text,text),public.update_expedition_project_journal_if_current(uuid,uuid,timestamptz,text,text,date,uuid),public.reorder_expedition_project_days_if_current(uuid,uuid[],uuid[],timestamptz[]) from public,anon;
grant execute on function public.update_expedition_project_day_if_current(uuid,uuid,timestamptz,text,text),public.update_expedition_project_journal_if_current(uuid,uuid,timestamptz,text,text,date,uuid),public.reorder_expedition_project_days_if_current(uuid,uuid[],uuid[],timestamptz[]) to authenticated;

-- Retry-safe relation mutations: triggers only observe a real INSERT/DELETE, so
-- already-applied retries emit neither activity nor notifications.
create or replace function public.link_expedition_project_day_track(requested_project_id uuid,requested_day_id uuid,requested_activity_id bigint)
returns boolean language plpgsql volatile security definer set search_path='' as $function$
declare actor uuid:=auth.uid(); inserted boolean;
begin
 if actor is null or not public.can_edit_expedition_project(requested_project_id) then raise exception 'Project unavailable.' using errcode='42501'; end if;
 if not exists(select 1 from public.expedition_project_days d where d.id=requested_day_id and d.project_id=requested_project_id) or not exists(select 1 from public.gps_activities a where a.id=requested_activity_id and a.user_id=actor) then raise exception 'Project day or track unavailable.' using errcode='42501'; end if;
 insert into public.expedition_project_day_tracks(project_id,project_day_id,user_id,gps_activity_id) values(requested_project_id,requested_day_id,actor,requested_activity_id) on conflict(project_day_id,gps_activity_id) do nothing;
 inserted:=found; return inserted;
end;$function$;
create or replace function public.unlink_expedition_project_day_track(requested_relation_id uuid)
returns boolean language plpgsql volatile security definer set search_path='' as $function$
declare target_project_id uuid;
begin
 if auth.uid() is null then raise exception 'Authentication is required.' using errcode='42501'; end if;
 select project_id into target_project_id from public.expedition_project_day_tracks where id=requested_relation_id;
 if target_project_id is null then return false; end if;
 if not public.can_edit_expedition_project(target_project_id) then raise exception 'Project track unavailable.' using errcode='42501'; end if;
 delete from public.expedition_project_day_tracks where id=requested_relation_id; return found;
end;$function$;
alter function public.link_expedition_project_day_track(uuid,uuid,bigint) owner to postgres;
alter function public.unlink_expedition_project_day_track(uuid) owner to postgres;
revoke all on function public.link_expedition_project_day_track(uuid,uuid,bigint),public.unlink_expedition_project_day_track(uuid) from public,anon;
grant execute on function public.link_expedition_project_day_track(uuid,uuid,bigint),public.unlink_expedition_project_day_track(uuid) to authenticated;
commit;
