-- Expedition Projects Phase 6A: journal day association and private media contract.
-- MANUAL REVIEW AND DEPLOYMENT ONLY. DO NOT run from application code.
--
-- Prerequisites:
--   * database/expedition_projects.sql is already deployed.
--   * PostgreSQL 15 or newer is deployed. PostgreSQL 15 introduced the
--     column-specific ON DELETE SET NULL syntax used below so deleting a day
--     clears project_day_id without clearing the required project_id.
--   * Supabase Storage is installed with storage.buckets and storage.objects.
--
-- This is an intentionally one-time incremental artifact. It does not use
-- CREATE TABLE IF NOT EXISTS or replace existing policies: a rerun or a
-- conflicting partial deployment fails inside this transaction and must be
-- inspected instead of silently accepting an incompatible contract.

begin;

alter table public.expedition_project_journal_entries
  add column project_day_id uuid;

alter table public.expedition_project_journal_entries
  add constraint expedition_project_journal_project_user_id_unique
    unique (project_id, user_id, id),
  add constraint expedition_project_journal_day_fk
    foreign key (project_id, project_day_id)
    references public.expedition_project_days(project_id, id)
    on delete set null (project_day_id);

create index expedition_project_journal_day_idx
  on public.expedition_project_journal_entries (project_id, project_day_id)
  where project_day_id is not null;

create table public.expedition_project_journal_media (
  id uuid primary key,
  journal_entry_id uuid not null,
  project_id uuid not null,
  user_id uuid not null,
  media_type text not null,
  storage_path text not null,
  original_filename text not null,
  mime_type text not null,
  size_bytes bigint not null,
  width integer not null,
  height integer not null,
  duration_seconds numeric(8, 3),
  sort_order integer not null,
  created_at timestamptz not null default now(),
  constraint expedition_project_journal_media_entry_fk
    foreign key (project_id, user_id, journal_entry_id)
    references public.expedition_project_journal_entries(project_id, user_id, id)
    on delete cascade,
  constraint expedition_project_journal_media_type_check
    check (media_type in ('photo', 'video')),
  constraint expedition_project_journal_media_mime_check
    check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm')),
  constraint expedition_project_journal_media_filename_check
    check (char_length(btrim(original_filename)) between 1 and 255),
  constraint expedition_project_journal_media_path_length_check
    check (char_length(storage_path) between 1 and 1024),
  constraint expedition_project_journal_media_path_unique unique (storage_path),
  constraint expedition_project_journal_media_path_contract_check
    check (
      storage_path = user_id::text || '/' || project_id::text || '/' ||
        journal_entry_id::text || '/' || id::text || '/original.' ||
        case mime_type
          when 'image/jpeg' then 'jpg'
          when 'image/png' then 'png'
          when 'image/webp' then 'webp'
          when 'video/mp4' then 'mp4'
          when 'video/webm' then 'webm'
        end
    ),
  constraint expedition_project_journal_media_size_check
    check (size_bytes > 0),
  constraint expedition_project_journal_media_dimensions_check
    check (width > 0 and height > 0),
  constraint expedition_project_journal_media_sort_order_check
    check (sort_order >= 0),
  constraint expedition_project_journal_media_order_unique
    unique (journal_entry_id, sort_order) deferrable initially immediate,
  constraint expedition_project_journal_media_photo_contract_check
    check (
      media_type <> 'photo' or (
        mime_type in ('image/jpeg', 'image/png', 'image/webp')
        and size_bytes <= 10485760
        and width <= 8192
        and height <= 8192
        and width::bigint * height::bigint <= 40000000
        and duration_seconds is null
      )
    ),
  constraint expedition_project_journal_media_video_contract_check
    check (
      media_type <> 'video' or (
        mime_type in ('video/mp4', 'video/webm')
        and size_bytes <= 104857600
        and width <= 3840
        and height <= 2160
        and duration_seconds > 0
        and duration_seconds <= 300
      )
    )
);

create index expedition_project_journal_media_entry_order_idx
  on public.expedition_project_journal_media
    (journal_entry_id, sort_order, created_at, id);
create index expedition_project_journal_media_owner_idx
  on public.expedition_project_journal_media (user_id, project_id, journal_entry_id);

-- CHECK constraints cannot safely count sibling rows. Serialize inserts for a
-- journal entry by locking its parent row, then enforce the approved hard cap.
-- This trigger is security invoker (the default), not SECURITY DEFINER.
create function public.enforce_expedition_journal_media_limit()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  existing_count integer;
begin
  perform 1
  from public.expedition_project_journal_entries entry
  where entry.id = new.journal_entry_id
    and entry.project_id = new.project_id
    and entry.user_id = new.user_id
  for update;

  if not found then
    raise exception 'Journal entry not found.' using errcode = '23503';
  end if;

  select count(*) into existing_count
  from public.expedition_project_journal_media media
  where media.journal_entry_id = new.journal_entry_id;

  if existing_count >= 12 then
    raise exception 'A journal entry may contain at most 12 media objects.'
      using errcode = '23514';
  end if;

  return new;
end;
$function$;

create trigger expedition_project_journal_media_limit
before insert on public.expedition_project_journal_media
for each row execute function public.enforce_expedition_journal_media_limit();

alter table public.expedition_project_journal_media enable row level security;

create policy expedition_project_journal_media_select_owned
on public.expedition_project_journal_media
for select to authenticated
using (
  expedition_project_journal_media.user_id = (select auth.uid())
  and exists (
    select 1 from public.expedition_projects project
    where project.id = expedition_project_journal_media.project_id
      and project.user_id = (select auth.uid())
  )
);

create policy expedition_project_journal_media_insert_owned
on public.expedition_project_journal_media
for insert to authenticated
with check (
  expedition_project_journal_media.user_id = (select auth.uid())
  and exists (
    select 1
    from public.expedition_project_journal_entries entry
    join public.expedition_projects project on project.id = entry.project_id
    where entry.id = expedition_project_journal_media.journal_entry_id
      and entry.project_id = expedition_project_journal_media.project_id
      and entry.user_id = expedition_project_journal_media.user_id
      and project.user_id = (select auth.uid())
  )
);

create policy expedition_project_journal_media_update_order_owned
on public.expedition_project_journal_media
for update to authenticated
using (expedition_project_journal_media.user_id = (select auth.uid()))
with check (expedition_project_journal_media.user_id = (select auth.uid()));

create policy expedition_project_journal_media_delete_owned
on public.expedition_project_journal_media
for delete to authenticated
using (
  expedition_project_journal_media.user_id = (select auth.uid())
  and exists (
    select 1 from public.expedition_projects project
    where project.id = expedition_project_journal_media.project_id
      and project.user_id = (select auth.uid())
  )
);

revoke all on public.expedition_project_journal_media from public, anon, authenticated;
grant select, insert, delete on public.expedition_project_journal_media to authenticated;
grant update (sort_order) on public.expedition_project_journal_media to authenticated;

revoke all on function public.enforce_expedition_journal_media_limit() from public, anon, authenticated;

-- The bucket ceiling accommodates the approved 100 MiB video limit. The
-- media table applies the lower 10 MiB ceiling to photos.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'expedition-media',
  'expedition-media',
  false,
  104857600,
  array['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm']::text[]
);

-- Storage paths have exactly four folder segments and one canonical filename:
-- user/project/journal-entry/media/original.ext. UUID comparisons use text to
-- ensure malformed paths fail closed without unsafe casts inside RLS policies.
create policy expedition_media_objects_insert_owned
on storage.objects
for insert to authenticated
with check (
  bucket_id = 'expedition-media'
  and cardinality(storage.foldername(storage.objects.name)) = 4
  and (storage.foldername(storage.objects.name))[1] = (select auth.uid())::text
  and (storage.foldername(storage.objects.name))[4] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  and storage.filename(storage.objects.name) in ('original.jpg', 'original.png', 'original.webp', 'original.mp4', 'original.webm')
  and exists (
    select 1
    from public.expedition_project_journal_entries entry
    join public.expedition_projects project on project.id = entry.project_id
    where project.user_id = (select auth.uid())
      and project.id::text = (storage.foldername(storage.objects.name))[2]
      and entry.project_id = project.id
      and entry.user_id = (select auth.uid())
      and entry.id::text = (storage.foldername(storage.objects.name))[3]
  )
);

create policy expedition_media_objects_select_owned
on storage.objects
for select to authenticated
using (
  bucket_id = 'expedition-media'
  and cardinality(storage.foldername(storage.objects.name)) = 4
  and (storage.foldername(storage.objects.name))[1] = (select auth.uid())::text
  and exists (
    select 1
    from public.expedition_project_journal_entries entry
    join public.expedition_projects project on project.id = entry.project_id
    where project.user_id = (select auth.uid())
      and project.id::text = (storage.foldername(storage.objects.name))[2]
      and entry.user_id = (select auth.uid())
      and entry.id::text = (storage.foldername(storage.objects.name))[3]
  )
);

create policy expedition_media_objects_delete_owned
on storage.objects
for delete to authenticated
using (
  bucket_id = 'expedition-media'
  and cardinality(storage.foldername(storage.objects.name)) = 4
  and (storage.foldername(storage.objects.name))[1] = (select auth.uid())::text
  and exists (
    select 1
    from public.expedition_project_journal_entries entry
    join public.expedition_projects project on project.id = entry.project_id
    where project.user_id = (select auth.uid())
      and project.id::text = (storage.foldername(storage.objects.name))[2]
      and entry.user_id = (select auth.uid())
      and entry.id::text = (storage.foldername(storage.objects.name))[3]
  )
);

-- Deliberately no UPDATE policy: overwrites, moves, and upserts are outside the
-- Phase 6 contract. Storage operations must still use the Storage API; direct
-- DML against storage.objects is not an application operation.

commit;
