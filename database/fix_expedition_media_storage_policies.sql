-- Repair the Phase 6A expedition-media Storage policies already deployed with
-- ambiguous object-path references. MANUAL REVIEW AND DEPLOYMENT ONLY.
--
-- Exact DROP POLICY statements are intentional: the transaction must fail if
-- the expected policies are absent or live under a different schema/name.

begin;

drop policy expedition_media_objects_insert_owned on storage.objects;
drop policy expedition_media_objects_select_owned on storage.objects;
drop policy expedition_media_objects_delete_owned on storage.objects;

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

commit;
