-- DISPOSABLE LOCAL POSTGRESQL ONLY. All synthetic fixtures and test policies
-- roll back. storage.objects here is a local test double with no object service.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
set local mountain_tracker.thumbnail_test_rls_checked = 'true';

do $guard$
begin
  if current_database() <> 'mountain_tracker_thumbnail_test' or current_user <> 'postgres'
    or (inet_server_addr() is not null and inet_server_addr() not in ('127.0.0.1'::inet, '::1'::inet))
    or to_regnamespace('thumbnail_contract_test') is null
  then raise exception 'Use the disposable local thumbnail contract database'; end if;
end;
$guard$;

-- Even a permissive policy accidentally added later cannot admit these roles
-- into the derivative bucket. Other buckets keep their normal policy behavior.
create policy thumbnail_test_permissive on storage.objects
for all to anon, authenticated using (true) with check (true);
create policy thumbnail_test_bucket_permissive on storage.buckets
for all to anon, authenticated using (true) with check (true);
create temp table thumbnails (spoofed boolean) on commit drop;
set local search_path = pg_temp, public;

do $regression$
declare
  owner_a uuid := gen_random_uuid();
  owner_b uuid := gen_random_uuid();
  project_a uuid := gen_random_uuid();
  project_b uuid := gen_random_uuid();
  day_a uuid := gen_random_uuid();
  journal_a uuid := gen_random_uuid();
  journal_b uuid := gen_random_uuid();
  photo_a uuid := gen_random_uuid();
  photo_b uuid := gen_random_uuid();
  photo_c uuid := gen_random_uuid();
  extra_photo uuid := gen_random_uuid();
  video_a uuid := gen_random_uuid();
  source_a uuid := gen_random_uuid();
  source_b uuid := gen_random_uuid();
  replacement_b uuid := gen_random_uuid();
  derivative_a uuid := gen_random_uuid();
  derivative_b uuid := gen_random_uuid();
  job_a record;
  job_b record;
  job_c record;
  retry_a record;
  retry_b record;
  cleanup_lease record;
  cleanup_retry record;
  reconciliation record;
  v2_job record;
  v2_object uuid := gen_random_uuid();
  actor text;
  rpc record;
  good_count integer := 0;
  key_a text;
  key_b text;
  derivative_visible boolean;
  original_visible boolean;
begin
  if (select count(*) from pg_catalog.pg_policies p
    where p.schemaname = 'storage' and p.permissive = 'RESTRICTIVE' and p.cmd = 'ALL'
      and p.roles @> array['anon', 'authenticated']::name[] and cardinality(p.roles) = 2
      and p.with_check = p.qual and (
        (p.tablename = 'objects' and p.policyname = 'expedition_media_thumbnails_server_only'
          and p.qual = '(bucket_id <> ''expedition-media-thumbnails''::text)')
        or (p.tablename = 'buckets' and p.policyname = 'expedition_media_thumbnail_bucket_server_only'
          and p.qual = '(id <> ''expedition-media-thumbnails''::text)')
      )
  ) <> 2 then raise exception 'Derivative Storage policies differ from the reviewed contract'; end if;

  if exists (
    select from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'expedition_media_private' and c.relkind = 'r' and not c.relrowsecurity
  ) or has_schema_privilege('authenticated', 'expedition_media_private', 'USAGE')
    or has_schema_privilege('anon', 'expedition_media_private', 'USAGE')
    or has_schema_privilege('service_role', 'expedition_media_private', 'CREATE')
    or has_table_privilege('service_role', 'expedition_media_private.thumbnails', 'DELETE')
    or has_table_privilege('service_role', 'expedition_media_private.thumbnail_cleanup', 'DELETE')
    or has_table_privilege('anon', 'expedition_media_private.thumbnails', 'SELECT')
    or has_table_privilege('authenticated', 'expedition_media_private.thumbnail_cleanup', 'INSERT')
  then raise exception 'Unexpected private schema or table grants'; end if;

  for rpc in select p.* from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'expedition_thumbnail_%'
  loop
    good_count := good_count + 1;
    if rpc.prosecdef or rpc.proconfig is distinct from array['search_path=""']
      or pg_get_userbyid(rpc.proowner) <> 'postgres'
      or has_function_privilege('anon', rpc.oid, 'EXECUTE')
      or has_function_privilege('authenticated', rpc.oid, 'EXECUTE')
      or not has_function_privilege('service_role', rpc.oid, 'EXECUTE')
    then raise exception 'Unexpected RPC privileges or search path for %', rpc.proname; end if;
  end loop;
  if good_count <> 13 or not exists (
    select from pg_catalog.pg_proc p
    where p.oid = 'expedition_media_private.thumbnail_media_lifecycle()'::regprocedure
      and p.prosecdef and p.proconfig = array['search_path=""'] and pg_get_userbyid(p.proowner) = 'postgres'
      and not has_function_privilege('anon', p.oid, 'EXECUTE')
      and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and not has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) then raise exception 'Unexpected definer or public RPC count'; end if;
  if (select count(*) from pg_catalog.pg_proc p
    where p.pronamespace = 'expedition_media_private'::regnamespace and p.proname <> 'thumbnail_media_lifecycle'
      and not p.prosecdef and p.proconfig = array['search_path=""']
      and has_function_privilege('service_role', p.oid, 'EXECUTE')
      and not has_function_privilege('anon', p.oid, 'EXECUTE')
      and not has_function_privilege('authenticated', p.oid, 'EXECUTE')) <> 6
  then raise exception 'Unexpected private helper privileges'; end if;

  insert into auth.users (id) values (owner_a), (owner_b);
  insert into public.expedition_projects (id, user_id, name) values
    (project_a, owner_a, 'Thumbnail regression A'), (project_b, owner_b, 'Thumbnail regression B');
  insert into public.expedition_project_days (id, project_id, day_number) values (day_a, project_a, 1);
  insert into public.expedition_project_journal_entries (id, project_id, user_id, project_day_id, body) values
    (journal_a, project_a, owner_a, day_a, 'A'), (journal_b, project_b, owner_b, null, 'B');
  perform set_config('request.jwt.claim.sub', owner_a::text, true);
  execute 'set local role authenticated';
  insert into public.expedition_project_journal_media (
    id, journal_entry_id, project_id, user_id, media_type, storage_path, original_filename,
    mime_type, size_bytes, width, height, duration_seconds, sort_order
  ) values
    (photo_a, journal_a, project_a, owner_a, 'photo', concat_ws('/', owner_a, project_a, journal_a, photo_a, 'original.png'),
     'a.png', 'image/png', 68, 1, 1, null, 0),
    (photo_c, journal_a, project_a, owner_a, 'photo', concat_ws('/', owner_a, project_a, journal_a, photo_c, 'original.png'),
     'c.png', 'image/png', 68, 1, 1, null, 1),
    (video_a, journal_a, project_a, owner_a, 'video', concat_ws('/', owner_a, project_a, journal_a, video_a, 'original.mp4'),
     'a.mp4', 'video/mp4', 100, 1, 1, 1, 2);
  execute 'set local role none';
  insert into public.expedition_project_journal_media (
    id, journal_entry_id, project_id, user_id, media_type, storage_path, original_filename, mime_type, size_bytes, width, height, sort_order
  ) values (photo_b, journal_b, project_b, owner_b, 'photo', concat_ws('/', owner_b, project_b, journal_b, photo_b, 'original.png'),
    'b.png', 'image/png', 68, 1, 1, 0);
  if (select count(*) from expedition_media_private.thumbnails where state = 'pending') <> 3
    or exists (select from expedition_media_private.thumbnails where media_id = video_a)
  then raise exception 'Insert trigger did not queue exactly the photos'; end if;

  insert into storage.objects (id, bucket_id, name, version, metadata)
  select case m.id when photo_a then source_a when photo_b then source_b else gen_random_uuid() end,
    'expedition-media', m.storage_path, 'source-v1', '{"size":68,"mimetype":"image/png"}'::jsonb
  from public.expedition_project_journal_media m where m.media_type = 'photo';
  -- Emulate a legacy row present before trigger deployment.
  delete from expedition_media_private.thumbnails where media_id = photo_b;
  execute 'set local role service_role';
  if public.expedition_thumbnail_enqueue(project_a, photo_b) is distinct from false then raise exception 'Wrong project accepted'; end if;
  if public.expedition_thumbnail_enqueue(project_a, video_a) is distinct from false then raise exception 'Video accepted'; end if;
  if public.expedition_thumbnail_enqueue(project_b, photo_b) is distinct from true then raise exception 'Legacy photo not queued'; end if;
  if public.expedition_thumbnail_enqueue(project_b, photo_b) is distinct from false then raise exception 'Duplicate enqueue changed state'; end if;
  select * into job_a from public.expedition_thumbnail_claim(8, 120) claim where claim.media_id = photo_a;
  if job_a.attempt_id is null or job_a.source_object_id <> source_a then raise exception 'Initial claim missed source'; end if;
  if exists (select from public.expedition_thumbnail_claim(8, 120)) then raise exception 'Initial lease claimed twice'; end if;
  -- Claim ran once for all three. Recover the other two test identities from the local fixture tables.
  select t.* into job_b from expedition_media_private.thumbnails t where t.media_id = photo_b;
  select t.* into job_c from expedition_media_private.thumbnails t where t.media_id = photo_c;
  if job_b.attempt_id is null or job_c.attempt_id is null
    or public.expedition_thumbnail_may_upload(photo_a, job_b.attempt_id) is distinct from false
  then raise exception 'Cross-media attempt accepted'; end if;
  begin
    perform public.expedition_thumbnail_claim(9, 120);
    raise exception 'Unexpected oversized claim';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.expedition_thumbnail_claim_cleanup(1, 121);
    raise exception 'Unexpected excessive cleanup lease';
  exception when invalid_parameter_value then null;
  end;
  execute 'set local role none';

  insert into public.expedition_project_journal_media (
    id, journal_entry_id, project_id, user_id, media_type, storage_path, original_filename,
    mime_type, size_bytes, width, height, sort_order
  ) values (extra_photo, journal_a, project_a, owner_a, 'photo', concat_ws('/', owner_a, project_a, journal_a, extra_photo, 'original.png'),
    'extra.png', 'image/png', 68, 1, 1, 3);
  if exists (select from public.expedition_thumbnail_claim(8, 120, 1, project_a)) then raise exception 'Project lease cap bypassed'; end if;
  if exists (select from expedition_media_private.thumbnails t where t.media_id = extra_photo and t.attempt_count <> 0)
  then raise exception 'Saturated project spent an attempt'; end if;
  delete from public.expedition_project_journal_media where id = extra_photo;

  -- Expire the real lease without sleeping and leave the exact reservation armed.
  update expedition_media_private.thumbnails set lease_until = clock_timestamp() - interval '1 second' where media_id = photo_a;
  insert into storage.objects (bucket_id, name, version, metadata)
  values ('expedition-media-thumbnails', job_a.derivative_key, 'abandoned-v1', '{"size":32,"mimetype":"image/webp"}');
  execute 'set local role service_role';
  select * into retry_a from public.expedition_thumbnail_claim(1, 120);
  if retry_a.media_id is distinct from photo_a or retry_a.attempt_id = job_a.attempt_id
    or retry_a.derivative_key = job_a.derivative_key
    or public.expedition_thumbnail_may_upload(photo_a, job_a.attempt_id) is distinct from false
  then raise exception 'Reclaim or stale upload fencing failed'; end if;
  if public.expedition_thumbnail_fail(photo_a, job_a.attempt_id, 'storage', true) is distinct from false then raise exception 'Expired attempt failed a newer job'; end if;
  if exists (select from public.expedition_thumbnail_claim_cleanup(1, 120)) then raise exception 'Cleanup grace not honored'; end if;
  if public.expedition_thumbnail_complete(photo_a, job_a.attempt_id, source_a, 'source-v1', derivative_a, 'out-v1', 1, 1, 32)
    is distinct from false then raise exception 'Expired attempt completed'; end if;
  execute 'set local role none';

  -- Even success metadata for a different object path or source is insufficient.
  insert into storage.objects (id, bucket_id, name, version, metadata)
  values (derivative_a, 'expedition-media-thumbnails', 'not-the-claimed-key.webp', 'out-v1', '{"size":32,"mimetype":"image/webp"}');
  execute 'set local role service_role';
  if public.expedition_thumbnail_complete(photo_a, retry_a.attempt_id, source_a, 'source-v1', derivative_a, 'out-v1', 1, 1, 32)
    is distinct from false then raise exception 'Arbitrary derivative key accepted'; end if;
  execute 'set local role none';
  update storage.objects set name = retry_a.derivative_key where id = derivative_a;
  execute 'set local role service_role';
  if public.expedition_thumbnail_complete(photo_a, retry_a.attempt_id, source_b, 'source-v1', derivative_a, 'out-v1', 1, 1, 32) is distinct from false then raise exception 'Wrong source accepted'; end if;
  if public.expedition_thumbnail_complete(photo_a, retry_a.attempt_id, source_a, 'source-v1', derivative_a, 'out-v1', 1, 1, 33) is distinct from false then raise exception 'Wrong byte size accepted'; end if;
  if public.expedition_thumbnail_complete(photo_a, retry_a.attempt_id, source_a, 'source-v1', derivative_a, 'out-v1', 1, 1, 32) is distinct from true then raise exception 'Valid completion rejected'; end if;
  if public.expedition_thumbnail_complete(photo_a, retry_a.attempt_id, source_a, 'source-v1', derivative_a, 'out-v1', 1, 1, 32) is distinct from true then raise exception 'Exact completion replay rejected'; end if;
  if (select l.object_key from public.expedition_thumbnail_lookup(project_a, photo_a) l) is distinct from retry_a.derivative_key
    or exists (select from public.expedition_thumbnail_lookup(project_b, photo_a))
  then raise exception 'Ready lookup was not exact and project scoped'; end if;
  select * into reconciliation from public.expedition_thumbnail_reconcile_ready(null, 1);
  if reconciliation.scanned <> 1 or reconciliation.requeued <> 0 or reconciliation.next_after is distinct from photo_a
  then raise exception 'Healthy ready job changed or pagination was unbounded'; end if;
  select * into reconciliation from public.expedition_thumbnail_reconcile_ready(photo_a, 1);
  if reconciliation.scanned <> 0 or reconciliation.next_after is not null then raise exception 'Ready cursor did not advance'; end if;
  execute 'set local role none';

  update storage.objects set version = 'replaced-source' where id = source_a;
  if exists (select from public.expedition_thumbnail_lookup(project_a, photo_a))
    or not exists (select from expedition_media_private.thumbnails t where t.media_id = photo_a and t.state = 'ready' and t.attempt_id = retry_a.attempt_id)
  then raise exception 'Lookup did not reject the replaced source read-only'; end if;
  update storage.objects set version = 'source-v1' where id = source_a;

  foreach actor in array array['anon', 'authenticated'] loop
    execute format('set local role %I', actor);
    if not row_security_active('storage.objects') or not row_security_active('storage.buckets') then
      raise exception 'Normal PostgreSQL backend with RLS required for %', actor;
    end if;
    select exists (select from storage.objects where bucket_id = 'expedition-media-thumbnails'),
      exists (select from storage.objects where bucket_id = 'expedition-media' and id = source_a)
    into derivative_visible, original_visible;
    if derivative_visible or not original_visible
    then raise exception 'Storage RLS for % as % returned derivative %, original %', actor, current_user, derivative_visible, original_visible; end if;
    if exists (select from storage.buckets where id = 'expedition-media-thumbnails')
      or not exists (select from storage.buckets where id = 'expedition-media')
    then raise exception 'Derivative bucket settings visible to % or original bucket affected', actor; end if;
    update storage.buckets set public = true where id = 'expedition-media-thumbnails';
    if found then raise exception 'Client made the derivative bucket public'; end if;
    begin
      insert into storage.objects (bucket_id, name) values ('expedition-media-thumbnails', 'forbidden.webp');
      raise exception 'Client uploaded a derivative';
    exception when insufficient_privilege then null;
    end;
    update storage.objects set version = 'forbidden' where id = derivative_a;
    if found then raise exception 'Client updated a derivative'; end if;
    delete from storage.objects where id = derivative_a;
    if found then raise exception 'Client deleted a derivative'; end if;
    begin
      perform public.expedition_thumbnail_lookup(project_a, photo_a);
      raise exception 'Client called private lookup';
    exception when insufficient_privilege then null;
    end;
    execute 'set local role none';
  end loop;

  -- A replacement original is a different generation even at the same path.
  update storage.objects set id = replacement_b, version = 'source-v2' where id = source_b;
  execute 'set local role service_role';
  if public.expedition_thumbnail_may_upload(photo_b, job_b.attempt_id) is distinct from false then raise exception 'Changed source was allowed to upload'; end if;
  if public.expedition_thumbnail_complete(photo_b, job_b.attempt_id, source_b, 'source-v1', derivative_b, 'out-v1', 1, 1, 32) is distinct from false then raise exception 'Changed source was allowed to complete'; end if;
  if public.expedition_thumbnail_fail(photo_b, job_b.attempt_id, 'source_changed', true) is distinct from true then raise exception 'Transient failure was not recorded'; end if;
  if exists (select from public.expedition_thumbnail_claim(1, 120)) then raise exception 'Transient failure bypassed backoff'; end if;
  execute 'set local role none';
  update expedition_media_private.thumbnails set available_at = clock_timestamp() - interval '1 second' where media_id = photo_b;
  execute 'set local role service_role';
  select * into retry_b from public.expedition_thumbnail_claim(1, 120);
  if retry_b.source_object_id is distinct from replacement_b then raise exception 'Retry missed the new source'; end if;
  execute 'set local role none';
  insert into storage.objects (id, bucket_id, name, version, metadata)
  values (derivative_b, 'expedition-media-thumbnails', retry_b.derivative_key, 'out-v1', '{"size":32,"mimetype":"image/webp"}');
  execute 'set local role service_role';
  if public.expedition_thumbnail_complete(photo_b, retry_b.attempt_id, replacement_b, 'source-v2', derivative_b, 'out-v1', 1, 1, 32) is distinct from true
  then raise exception 'Retry could not publish'; end if;
  execute 'set local role none';
  update storage.objects set version = 'out-replaced' where id = derivative_b;
  if exists (select from public.expedition_thumbnail_lookup(project_b, photo_b))
  then raise exception 'Changed derivative stayed visible'; end if;
  select * into reconciliation from public.expedition_thumbnail_reconcile_ready(null, 8);
  if reconciliation.scanned <> 2 or reconciliation.requeued <> 1 then raise exception 'Ready sweep did not repair exactly the stale derivative'; end if;
  if (select state from expedition_media_private.thumbnail_cleanup where attempt_id = retry_b.attempt_id) is distinct from 'pending'
  then raise exception 'Changed derivative stayed visible or repair lost cleanup'; end if;
  delete from storage.objects where id = replacement_b;
  if exists (select from public.expedition_thumbnail_claim(1, 120, 1, project_b)) then raise exception 'Missing source produced an attempt'; end if;
  if not exists (select from expedition_media_private.thumbnails t where t.media_id = photo_b
    and t.state = 'pending' and t.last_error = 'source_missing' and t.attempt_count = 1 and t.available_at > clock_timestamp())
  then raise exception 'Missing source did not back off'; end if;
  insert into storage.objects (id, bucket_id, name, metadata)
  select replacement_b, 'expedition-media', m.storage_path, '{"size":68,"mimetype":"image/png"}'
  from public.expedition_project_journal_media m where m.id = photo_b;
  update expedition_media_private.thumbnails set available_at = clock_timestamp() - interval '1 second' where media_id = photo_b;
  if exists (select from public.expedition_thumbnail_claim(1, 120, 1, project_b)) then raise exception 'Unversioned source produced an attempt'; end if;
  if not exists (select from expedition_media_private.thumbnails t where t.media_id = photo_b
    and t.state = 'pending' and t.last_error = 'source_unavailable' and t.attempt_count = 2)
  then raise exception 'Incomplete source was not retried'; end if;
  update storage.objects set version = 'restored', metadata = '{"size":69,"mimetype":"image/png"}' where id = replacement_b;
  update expedition_media_private.thumbnails set available_at = clock_timestamp() - interval '1 second' where media_id = photo_b;
  if exists (select from public.expedition_thumbnail_claim(1, 120, 1, project_b)) then raise exception 'Invalid source produced an attempt'; end if;
  if not exists (select from expedition_media_private.thumbnails t where t.media_id = photo_b
    and t.state = 'failed' and t.last_error = 'invalid_source' and t.attempt_count = 3)
  then raise exception 'Invalid source was not terminal'; end if;
  if public.expedition_thumbnail_enqueue(project_b, photo_b, true) is distinct from true then raise exception 'Failed job could not be repaired'; end if;
  delete from storage.objects where id = replacement_b;
  update expedition_media_private.thumbnails set attempt_count = 4 where media_id = photo_b;
  if exists (select from public.expedition_thumbnail_claim(1, 120, 1, project_b)) then raise exception 'Exhausted source produced an attempt'; end if;
  if not exists (select from expedition_media_private.thumbnails t where t.media_id = photo_b
    and t.state = 'failed' and t.attempt_count = 5 and t.last_error = 'source_missing')
  then raise exception 'Transient source retries did not exhaust'; end if;

  delete from public.expedition_project_days where id = day_a;
  if not exists (select from public.expedition_project_journal_entries where id = journal_a and project_day_id is null)
    or not exists (select from public.expedition_thumbnail_lookup(project_a, photo_a))
  then raise exception 'Deleting a day changed journal media'; end if;

  if public.expedition_thumbnail_set_version(1, 2) is distinct from true then raise exception 'Could not select target v2'; end if;
  if public.expedition_thumbnail_set_version(1, 2) is distinct from true then raise exception 'Target version replay rejected'; end if;
  begin
    perform public.expedition_thumbnail_set_version(2, 1);
    raise exception 'Unsafe version downgrade accepted';
  exception when invalid_parameter_value then null;
  end;
  if not exists (select from public.expedition_thumbnail_lookup(project_a, photo_a))
  then raise exception 'Version selection invalidated ready v1 before rollout'; end if;
  if public.expedition_thumbnail_rollout_version(1, 16) <> 0 then raise exception 'Wrong rollout target changed jobs'; end if;
  if public.expedition_thumbnail_rollout_version(2, 1) <> 1 then raise exception 'Rollout failed its batch cap'; end if;
  if public.expedition_thumbnail_rollout_version(2, 16) <> 2 then raise exception 'Rollout missed old rows'; end if;
  if public.expedition_thumbnail_rollout_version(2, 16) <> 0 then raise exception 'Rollout replay changed v2 rows'; end if;
  if exists (select from public.expedition_thumbnail_lookup(project_a, photo_a))
    or (select c.state from expedition_media_private.thumbnail_cleanup c where c.attempt_id = retry_a.attempt_id) is distinct from 'pending'
    or (select c.available_at from expedition_media_private.thumbnail_cleanup c where c.attempt_id = job_c.attempt_id) <= clock_timestamp()
  then raise exception 'Rollout did not release ready cleanup or preserve active grace'; end if;
  if public.expedition_thumbnail_complete(photo_c, job_c.attempt_id, job_c.source_object_id, job_c.source_version, derivative_a, 'out-v1', 1, 1, 32) is distinct from false
  then raise exception 'v1 worker completed a superseded lease'; end if;
  if exists (select from public.expedition_thumbnail_claim(8, 120, 1)) then raise exception 'v1 worker claimed a v2 job'; end if;
  select * into v2_job from public.expedition_thumbnail_claim(2, 120, 2, project_a) j where j.media_id = photo_a;
  if v2_job.processing_version is distinct from 2 or v2_job.derivative_key not like '%/v2/%'
  then raise exception 'v2 lease or immutable v2 key missing'; end if;
  insert into storage.objects (id, bucket_id, name, version, metadata)
  values (v2_object, 'expedition-media-thumbnails', v2_job.derivative_key, 'out-v2', '{"size":32,"mimetype":"image/webp"}');
  if public.expedition_thumbnail_complete(photo_a, v2_job.attempt_id, source_a, 'source-v1', v2_object, 'out-v2', 1, 1, 32) is distinct from true
  then raise exception 'v2 lease could not publish'; end if;

  delete from public.expedition_projects where id = project_b;
  delete from auth.users where id = owner_a;
  if exists (select from expedition_media_private.thumbnails)
    or exists (select from public.expedition_thumbnail_lookup(project_a, photo_a))
    or public.expedition_thumbnail_may_upload(photo_c, job_c.attempt_id) is distinct from false
    or public.expedition_thumbnail_complete(photo_c, job_c.attempt_id, job_c.source_object_id, job_c.source_version, derivative_a, 'out-v1', 1, 1, 32) is distinct from false
    or (select state from expedition_media_private.thumbnail_cleanup where attempt_id = v2_job.attempt_id) <> 'pending'
    or (select state from expedition_media_private.thumbnail_cleanup where attempt_id = job_c.attempt_id) <> 'pending'
    or not exists (select from storage.objects where id = source_a)
  then raise exception 'Cascade cancellation, deletion fencing or original preservation failed'; end if;

  -- A late upload after cleanup acknowledgement remains discoverable through its tombstone.
  update expedition_media_private.thumbnail_cleanup set available_at = clock_timestamp() - interval '1 hour', attempt_count = 7
  where attempt_id = job_a.attempt_id;
  select * into cleanup_lease from public.expedition_thumbnail_claim_cleanup(1, 120);
  if cleanup_lease.attempt_id is distinct from job_a.attempt_id then raise exception 'Cleanup selected the wrong key'; end if;
  if public.expedition_thumbnail_finish_cleanup(cleanup_lease.attempt_id, cleanup_lease.lease_token) is distinct from false then raise exception 'Cleanup acknowledged an existing object'; end if;
  if not exists (select from expedition_media_private.thumbnail_cleanup c
    where c.attempt_id = job_a.attempt_id and c.state = 'failed' and c.last_error = 'object_still_present')
  then raise exception 'Eighth cleanup attempt did not stop'; end if;
  if public.expedition_thumbnail_retry_cleanup(job_a.attempt_id) is distinct from true then raise exception 'Operator could not retry exact failed cleanup'; end if;
  if public.expedition_thumbnail_retry_cleanup(job_a.attempt_id) is distinct from false then raise exception 'Cleanup retry replay changed a pending row'; end if;
  update expedition_media_private.thumbnail_cleanup set available_at = clock_timestamp() - interval '1 hour'
  where attempt_id = job_a.attempt_id;
  select * into cleanup_retry from public.expedition_thumbnail_claim_cleanup(1, 120);
  if cleanup_retry.lease_token = cleanup_lease.lease_token then raise exception 'Cleanup lease reused its token'; end if;
  if public.expedition_thumbnail_finish_cleanup(cleanup_lease.attempt_id, cleanup_lease.lease_token) is distinct from false then raise exception 'Stale cleanup fence accepted'; end if;
  if public.expedition_thumbnail_finish_cleanup(cleanup_retry.attempt_id, cleanup_retry.lease_token) is distinct from false then raise exception 'Cleanup failed to retry'; end if;
  if not exists (select from expedition_media_private.thumbnail_cleanup c where c.attempt_id = job_a.attempt_id
    and c.state = 'pending' and c.last_error = 'object_still_present' and c.available_at > clock_timestamp())
  then raise exception 'Cleanup did not back off'; end if;
  update expedition_media_private.thumbnail_cleanup set available_at = clock_timestamp() - interval '1 hour'
  where attempt_id = job_a.attempt_id;
  select * into cleanup_retry from public.expedition_thumbnail_claim_cleanup(1, 120);
  key_a := cleanup_retry.object_key;
  delete from storage.objects where bucket_id = 'expedition-media-thumbnails' and name = key_a;
  if public.expedition_thumbnail_finish_cleanup(cleanup_retry.attempt_id, cleanup_retry.lease_token) is distinct from true
  then raise exception 'Exact missing object could not be acknowledged'; end if;
  insert into storage.objects (bucket_id, name, version, metadata)
  values ('expedition-media-thumbnails', key_a, 'late-v2', '{"size":32,"mimetype":"image/webp"}');
  if exists (select from public.expedition_thumbnail_claim_cleanup(16, 120) c where c.attempt_id = job_a.attempt_id)
  then raise exception 'Hot cleanup claim scanned tombstones'; end if;
  select * into reconciliation from public.expedition_thumbnail_reconcile_cleanup(null, 1);
  if reconciliation.scanned <> 1 or reconciliation.requeued <> 1 or reconciliation.next_after is distinct from job_a.attempt_id
  then raise exception 'Bounded tombstone sweep did not requeue the exact key'; end if;
  select c.object_key into key_b from public.expedition_thumbnail_claim_cleanup(16, 120) c where c.attempt_id = job_a.attempt_id;
  if key_b is distinct from key_a then raise exception 'Late attempt object was not picked up from the tombstone'; end if;
end;
$regression$;

do $storage_identity$
<<storage_identity>>
declare
  owner_id uuid := gen_random_uuid();
  project_id uuid := gen_random_uuid();
  journal_id uuid := gen_random_uuid();
  media_id uuid := gen_random_uuid();
  original_path text := concat_ws('/', owner_id, project_id, journal_id, media_id, 'original.png');
  source_id uuid := gen_random_uuid();
  replacement_id uuid := gen_random_uuid();
  marker_id uuid := gen_random_uuid();
  derivative_id uuid := gen_random_uuid();
  replacement_derivative_id uuid := gen_random_uuid();
  image_metadata jsonb := '{"size":68,"mimetype":"image/png"}';
  webp_metadata jsonb := '{"size":32,"mimetype":"image/webp"}';
  job record;
  lease record;
  cleanup_key text;
  late_attempt uuid := gen_random_uuid();
  historical_attempt uuid := gen_random_uuid();
  sweep record;
begin
  update storage.buckets set versioning_status = 'ENABLED' where id = 'expedition-media';
  insert into auth.users(id) values (owner_id);
  insert into public.expedition_projects(id,user_id,name) values (project_id,owner_id,'Storage identity');
  insert into public.expedition_project_journal_entries(id,project_id,user_id,body)
  values (journal_id,project_id,owner_id,'Storage identity');
  insert into public.expedition_project_journal_media
    (id,journal_entry_id,project_id,user_id,media_type,storage_path,original_filename,mime_type,size_bytes,width,height,sort_order)
  values (media_id,journal_id,project_id,owner_id,'photo',original_path,'original.png','image/png',68,1,1,0);
  insert into storage.objects(id,bucket_id,name,version,metadata,is_versioned)
  values (source_id,'expedition-media',original_path,'original-1',image_metadata,true);
  if (select s.object_id from expedition_media_private.thumbnail_source(media_id) s) is distinct from source_id
  then raise exception 'An exact current source was rejected'; end if;
  select * into job from public.expedition_thumbnail_claim(1,120,2,project_id);
  if job.source_object_id is distinct from source_id or job.source_version <> 'original-1'
    or public.expedition_thumbnail_may_upload(media_id,job.attempt_id) is distinct from true
  then raise exception 'Current versioned source could not be claimed or fenced for upload'; end if;
  insert into storage.objects(id,bucket_id,name,version,metadata)
  values (derivative_id,'expedition-media-thumbnails',job.derivative_key,'out-1',webp_metadata);

  update storage.objects set archived_at = clock_timestamp() where id = source_id;
  if (select s.status from expedition_media_private.inspect_thumbnail_source(media_id) s) is distinct from 'source_missing'
    or public.expedition_thumbnail_may_upload(media_id,job.attempt_id) is distinct from false
    or public.expedition_thumbnail_complete(media_id,job.attempt_id,source_id,'original-1',derivative_id,'out-1',1,1,32) is distinct from false
  then raise exception 'An archived-only source passed inspection, upload or completion'; end if;
  insert into storage.objects(id,bucket_id,name,version,metadata,is_versioned)
  values (replacement_id,'expedition-media',original_path,'original-2',image_metadata,true);
  if (select s.object_id from expedition_media_private.thumbnail_source(media_id) s) is distinct from replacement_id
    or public.expedition_thumbnail_may_upload(media_id,job.attempt_id) is distinct from false
    or public.expedition_thumbnail_complete(media_id,job.attempt_id,source_id,'original-1',derivative_id,'out-1',1,1,32) is distinct from false
  then raise exception 'A replaced source kept its old lease identity'; end if;

  update storage.objects set archived_at = clock_timestamp() where id = replacement_id;
  -- Deliberately give the marker plausible metadata to prove the marker flag wins.
  insert into storage.objects(id,bucket_id,name,version,metadata,is_versioned,is_delete_marker)
  values (marker_id,'expedition-media',original_path,'delete-marker',image_metadata,true,true);
  if exists (select from expedition_media_private.thumbnail_source(media_id))
  then raise exception 'A source delete marker or archived history was read'; end if;
  delete from storage.objects where id = marker_id;
  update storage.objects set archived_at = null where id = replacement_id;
  perform public.expedition_thumbnail_fail(media_id,job.attempt_id,'source_changed',true);
  update expedition_media_private.thumbnails t set available_at = '-infinity' where t.media_id = storage_identity.media_id;
  select * into job from public.expedition_thumbnail_claim(1,120,2,project_id);
  if job.source_object_id is distinct from replacement_id then raise exception 'Claim did not select the current replacement'; end if;

  derivative_id := gen_random_uuid();
  insert into storage.objects(id,bucket_id,name,version,metadata,archived_at,is_versioned)
  values (derivative_id,'expedition-media-thumbnails',job.derivative_key,'archive-out',webp_metadata,clock_timestamp(),true);
  if public.expedition_thumbnail_complete(media_id,job.attempt_id,replacement_id,'original-2',derivative_id,'archive-out',1,1,32)
    is distinct from false then raise exception 'Completion accepted an archived derivative'; end if;
  insert into storage.objects(id,bucket_id,name,version,metadata,is_versioned,is_delete_marker)
  values (marker_id,'expedition-media-thumbnails',job.derivative_key,'derivative-marker',webp_metadata,true,true);
  if public.expedition_thumbnail_complete(media_id,job.attempt_id,replacement_id,'original-2',marker_id,'derivative-marker',1,1,32)
    is distinct from false then raise exception 'Completion accepted a derivative delete marker'; end if;
  delete from storage.objects where id = marker_id;
  insert into storage.objects(id,bucket_id,name,version,metadata)
  values (replacement_derivative_id,'expedition-media-thumbnails',job.derivative_key,'current-out',webp_metadata);
  if public.expedition_thumbnail_complete(media_id,job.attempt_id,replacement_id,'original-2',replacement_derivative_id,'current-out',1,1,32)
    is distinct from true then raise exception 'Completion rejected the current derivative with archived history'; end if;
  if (select l.object_id from public.expedition_thumbnail_lookup(project_id,media_id) l) is distinct from replacement_derivative_id
  then raise exception 'Lookup rejected the current derivative with archived history'; end if;

  drop index storage.idx_objects_current_version;
  insert into storage.objects(id,bucket_id,name,version,metadata,is_versioned)
  values (marker_id,'expedition-media-thumbnails',job.derivative_key,'ambiguous-out',webp_metadata,true);
  if exists (select from public.expedition_thumbnail_lookup(project_id,media_id))
  then raise exception 'Lookup selected an exact manifest identity from ambiguous current rows'; end if;
  delete from storage.objects where id = marker_id;
  create unique index idx_objects_current_version on storage.objects (bucket_id, name collate "C") where archived_at is null;

  update storage.objects set archived_at = clock_timestamp(), is_versioned = true where id = replacement_derivative_id;
  if exists (select from public.expedition_thumbnail_lookup(project_id,media_id))
  then raise exception 'Lookup returned an archived-only derivative'; end if;
  insert into storage.objects(bucket_id,name,version,metadata)
  values ('expedition-media-thumbnails',job.derivative_key,'new-current-out',webp_metadata);
  if exists (select from public.expedition_thumbnail_lookup(project_id,media_id))
  then raise exception 'A different current derivative inherited a ready manifest'; end if;
  select * into sweep from public.expedition_thumbnail_reconcile_ready(null,128);
  if sweep.requeued < 1 or not exists (
    select from expedition_media_private.thumbnails t where t.media_id = storage_identity.media_id and t.state = 'pending'
  ) then raise exception 'Ready reconciliation kept a replaced derivative'; end if;
  if exists (select from public.expedition_thumbnail_claim_cleanup(16,120) c where c.attempt_id = job.attempt_id)
  then raise exception 'Cleanup leased a path with retained history'; end if;
  if not exists (select from expedition_media_private.thumbnail_cleanup c where c.attempt_id = job.attempt_id
      and c.state = 'failed' and c.last_error = 'storage_history_present')
  then raise exception 'Cleanup failed to report retained history'; end if;

  insert into expedition_media_private.thumbnail_cleanup(attempt_id,media_id,processing_version,available_at)
  values (late_attempt,media_id,2,'-infinity'),(historical_attempt,media_id,2,'-infinity');
  select c.* into lease from public.expedition_thumbnail_claim_cleanup(16,120) c where c.attempt_id = historical_attempt;
  insert into storage.objects(bucket_id,name,version,metadata,archived_at,is_versioned)
  values ('expedition-media-thumbnails',lease.object_key,'retained-after-claim',webp_metadata,clock_timestamp(),true);
  if public.expedition_thumbnail_finish_cleanup(lease.attempt_id,lease.lease_token) is distinct from false
  then raise exception 'Cleanup acknowledged retained historical bytes'; end if;
  if not exists (select from expedition_media_private.thumbnail_cleanup c where c.attempt_id = historical_attempt
      and c.state = 'failed' and c.last_error = 'storage_history_present')
  then raise exception 'Cleanup failed to report retained historical bytes'; end if;
  select c.object_key into cleanup_key from expedition_media_private.thumbnail_cleanup c where c.attempt_id = late_attempt;
  if (select public.expedition_thumbnail_finish_cleanup(c.attempt_id,c.lease_token)
    from expedition_media_private.thumbnail_cleanup c where c.attempt_id = late_attempt and c.state = 'processing') is distinct from true
  then raise exception 'Absent path could not be acknowledged'; end if;
  insert into storage.objects(bucket_id,name,version,is_versioned,is_delete_marker)
  values ('expedition-media-thumbnails',cleanup_key,'late-marker',true,true);
  perform public.expedition_thumbnail_reconcile_cleanup(null,256);
  if not exists (select from expedition_media_private.thumbnail_cleanup c where c.attempt_id = late_attempt
    and c.state = 'failed' and c.last_error = 'storage_history_present')
  then raise exception 'Tombstone sweep accepted a late delete marker'; end if;

  update storage.buckets set versioning_status = 'SUSPENDED' where id = 'expedition-media-thumbnails';
  if expedition_media_private.thumbnail_derivative_bucket_supported()
    or exists (select from public.expedition_thumbnail_claim(1,120,2,project_id))
    or exists (select from public.expedition_thumbnail_claim_cleanup(16,120))
    or (select s.scanned from public.expedition_thumbnail_reconcile_cleanup(null,16) s) <> 0
  then raise exception 'An unsupported derivative bucket remained operational'; end if;

  drop index storage.idx_objects_current_version;
  insert into storage.objects(bucket_id,name,version,metadata,is_versioned)
  values ('expedition-media',original_path,'ambiguous-current',image_metadata,true);
  if exists (select from expedition_media_private.thumbnail_source(media_id))
  then raise exception 'Ambiguous current source was accepted'; end if;
end;
$storage_identity$;

select 'thumbnail_contract_regression_passed' as result,
  current_setting('mountain_tracker.thumbnail_test_rls_checked') as runtime_rls_checked;
rollback;
