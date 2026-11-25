-- Apply after the reviewed sharing, thumbnail core and worker contracts.
-- Disable workers and delivery during this transaction. Provision the display bucket after commit.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $preflight$
begin
  if current_user <> 'postgres' or to_regprocedure('expedition_sharing_private.is_eligible(uuid,uuid)') is null
    or to_regprocedure('public.expedition_thumbnail_worker_acquire()') is null
    or not expedition_media_private.thumbnail_derivative_bucket_supported() then
    raise exception 'Expected reviewed sharing and thumbnail worker contracts';
  end if;
  lock table public.expedition_project_journal_media in share row exclusive mode;
  lock table expedition_media_private.thumbnail_worker_state, expedition_media_private.thumbnails,
    expedition_media_private.thumbnail_cleanup in access exclusive mode;
  if exists (select from expedition_media_private.thumbnail_worker_state where lease_until > clock_timestamp())
    or exists (select from expedition_media_private.thumbnails where lease_until > clock_timestamp())
    or exists (select from expedition_media_private.thumbnail_cleanup where lease_until > clock_timestamp()) then
    raise exception 'Drain thumbnail leases before installing display SQL';
  end if;
  if exists (select from storage.buckets where id = 'expedition-media-display' and
    (name is distinct from id or public is distinct from false or versioning_status is distinct from 'DISABLED'
     or file_size_limit is distinct from 524288 or allowed_mime_types is distinct from array['image/webp']::text[]))
    or exists (select from storage.objects where bucket_id = 'expedition-media-display') then
    raise exception 'Expected no display bucket or an empty supported display bucket';
  end if;
end;
$preflight$;

create policy expedition_display_objects_server_only on storage.objects
  as restrictive for all to anon, authenticated
  using (bucket_id <> 'expedition-media-display') with check (bucket_id <> 'expedition-media-display');
create policy expedition_display_bucket_server_only on storage.buckets
  as restrictive for all to anon, authenticated
  using (id <> 'expedition-media-display') with check (id <> 'expedition-media-display');

alter table expedition_media_private.thumbnail_cleanup
  add column variant text not null default 'thumb'
    check (variant in ('thumb','display') and (variant <> 'display' or processing_version = 1)),
  add constraint media_cleanup_variant_attempt_key unique (media_id, variant, processing_version, attempt_id);
alter table expedition_media_private.thumbnails
  add column variant text not null default 'thumb'
    check (variant in ('thumb','display') and (variant <> 'display' or processing_version = 1)),
  drop constraint thumbnails_pkey,
  drop constraint thumbnails_media_id_processing_version_attempt_id_fkey,
  drop constraint thumbnails_width_check,
  drop constraint thumbnails_height_check,
  drop constraint thumbnails_size_bytes_check,
  add primary key (media_id, variant),
  add constraint media_variant_attempt_fk foreign key (media_id, variant, processing_version, attempt_id)
    references expedition_media_private.thumbnail_cleanup(media_id, variant, processing_version, attempt_id),
  add constraint media_variant_width check (width between 1 and case variant when 'thumb' then 256 else 2048 end),
  add constraint media_variant_height check (height between 1 and case variant when 'thumb' then 256 else 2048 end),
  add constraint media_variant_size check (size_bytes between 1 and case variant when 'thumb' then 65536 else 524288 end);
alter table expedition_media_private.thumbnail_worker_state
  add column display_seed_after uuid,
  add column display_ready_after uuid,
  add column display_cleanup_after uuid,
  add column prefer_display boolean not null default false;

create index media_variants_pending_idx on expedition_media_private.thumbnails (variant, processing_version, available_at, media_id) where state = 'pending';
create index media_variants_processing_idx on expedition_media_private.thumbnails (variant, processing_version, lease_until, media_id) where state = 'processing';
create index media_variants_ready_idx on expedition_media_private.thumbnails (variant, media_id) where state = 'ready';
create index media_cleanup_variants_pending_idx on expedition_media_private.thumbnail_cleanup (variant, available_at, attempt_id) where state = 'pending';
create index media_cleanup_variants_processing_idx on expedition_media_private.thumbnail_cleanup (variant, lease_until, attempt_id) where state = 'processing';
create index media_cleanup_variants_done_idx on expedition_media_private.thumbnail_cleanup (variant, attempt_id) where state = 'done';

create function expedition_media_private.media_bucket(p_variant text)
returns text
language sql stable security invoker set search_path = '' as $function$
  select case p_variant when 'thumb' then 'expedition-media-thumbnails'
    when 'display' then 'expedition-media-display' end;
$function$;

create function expedition_media_private.media_bucket_supported(p_variant text)
returns boolean
language sql stable security invoker set search_path = '' as $function$
  select case p_variant when 'thumb' then expedition_media_private.thumbnail_derivative_bucket_supported()
    when 'display' then exists (select from storage.buckets b where b.id='expedition-media-display'
      and b.name=b.id and b.public is false and b.versioning_status='DISABLED'
      and b.file_size_limit=524288 and b.allowed_mime_types=array['image/webp']::text[])
    else false end;
$function$;

create function expedition_media_private.display_project_eligible(p_project_id uuid)
returns boolean
language sql stable security definer set search_path = '' as $function$
  select exists (select from public.expedition_project_shares s
    where s.project_id=p_project_id and s.is_enabled
      and expedition_sharing_private.is_eligible(s.project_id,s.user_id));
$function$;

create function expedition_media_private.media_cleanup_state(p_path text, p_variant text)
returns text
language sql stable security invoker set search_path = '' as $function$
  with candidates as (
    select o.archived_at is not null or o.is_versioned or o.is_delete_marker as history
    from storage.objects o
    where o.bucket_id = expedition_media_private.media_bucket(p_variant) and o.name collate pg_catalog."C" = p_path
    limit 2
  )
  select case when bool_or(history) then 'storage_history_present'
    when count(*) > 1 then 'storage_identity_ambiguous'
    when count(*) = 1 then 'current'
    else 'absent'
  end from candidates;
$function$;

create function expedition_media_private.media_lookup(p_project_id uuid, p_media_id uuid, p_variant text)
returns table (object_key text, object_id uuid, object_version text, size_bytes integer, width integer, height integer)
language sql stable security invoker set search_path = '' as $function$
  select c.object_key, o.id, o.version, t.size_bytes, t.width, t.height
  from expedition_media_private.thumbnails t
  join expedition_media_private.thumbnail_cleanup c on c.attempt_id = t.attempt_id and c.variant = t.variant and c.state = 'held'
  join expedition_media_private.thumbnail_source(p_media_id) s
    on s.object_id = t.source_object_id and s.object_version = t.source_version
  join lateral expedition_media_private.current_storage_object(expedition_media_private.media_bucket(p_variant), c.object_key) o
    on o.id = t.derivative_object_id and o.version = t.derivative_version and not o.is_versioned
  where t.media_id = p_media_id and t.variant = p_variant and s.project_id = p_project_id and t.state = 'ready'
    and expedition_media_private.media_bucket_supported(p_variant)
    and (p_variant <> 'display' or expedition_media_private.display_project_eligible(p_project_id))
    and o.metadata ->> 'size' = t.size_bytes::text and o.metadata ->> 'mimetype' = 'image/webp';
$function$;

create or replace function public.expedition_thumbnail_lookup(p_project_id uuid, p_media_id uuid)
returns table (object_key text, object_id uuid, object_version text, size_bytes integer, width integer, height integer)
language sql stable security invoker set search_path = '' as $function$
  select * from expedition_media_private.media_lookup(p_project_id, p_media_id, 'thumb');
$function$;

create function public.expedition_display_photo_lookup(p_project_id uuid, p_media_id uuid)
returns table (object_key text, object_id uuid, object_version text, size_bytes integer, width integer, height integer)
language sql stable security invoker set search_path = '' as $function$
  select * from expedition_media_private.media_lookup(p_project_id,p_media_id,'display');
$function$;

create function expedition_media_private.media_reset(p_media_id uuid, p_version smallint, p_attempt_id uuid, p_variant text)
returns void
language plpgsql volatile security invoker set search_path = '' as $function$
begin
  update expedition_media_private.thumbnail_cleanup c set state = 'pending', available_at = clock_timestamp()
  where c.attempt_id = p_attempt_id and c.variant = p_variant and c.state = 'held';
  update expedition_media_private.thumbnails t set processing_version = p_version,
    state = 'pending', enqueued_at = clock_timestamp(), available_at = clock_timestamp(),
    attempt_count = 0, attempt_id = null, lease_until = null,
    source_object_id = null, source_version = null, derivative_object_id = null, derivative_version = null,
    width = null, height = null, size_bytes = null, last_error = null
  where t.media_id = p_media_id and t.variant = p_variant;
end;
$function$;

create or replace function expedition_media_private.reset_thumbnail(p_media_id uuid, p_version smallint, p_attempt_id uuid)
returns void
language sql volatile security invoker set search_path = '' as $function$
  select expedition_media_private.media_reset(p_media_id,p_version,p_attempt_id,'thumb');
$function$;

create or replace function public.expedition_thumbnail_enqueue(p_project_id uuid, p_media_id uuid, p_repair boolean default false)
returns boolean
language plpgsql volatile security invoker set search_path = '' as $function$
declare
  job expedition_media_private.thumbnails%rowtype;
  violated_constraint text;
begin
  begin
    insert into expedition_media_private.thumbnails (media_id, processing_version)
      select m.id, s.target_version from public.expedition_project_journal_media m
      cross join expedition_media_private.thumbnail_settings s
      where m.id = p_media_id and m.project_id = p_project_id and m.media_type = 'photo'
    on conflict (media_id, variant) do nothing;
    if found then return true; end if;
  exception when foreign_key_violation then
    get stacked diagnostics violated_constraint = constraint_name;
    if violated_constraint = 'thumbnail_canonical_media_fk' then return false; end if;
    raise;
  end;
  if p_repair is not true then return false; end if;

  select t.* into job from expedition_media_private.thumbnails t
  join public.expedition_project_journal_media m on m.id = t.media_id
  where t.media_id = p_media_id and t.variant = 'thumb' and m.project_id = p_project_id and m.media_type = 'photo'
  for update of t;
  if not found or job.state not in ('failed', 'ready') then return false; end if;
  if job.state = 'ready' and (not expedition_media_private.thumbnail_derivative_bucket_supported()
    or exists (select 1 from public.expedition_thumbnail_lookup(p_project_id, p_media_id)))
  then return false; end if;
  perform expedition_media_private.reset_thumbnail(job.media_id, job.processing_version, job.attempt_id);
  return true;
end;
$function$;

create or replace function public.expedition_thumbnail_rollout_version(p_expected_target integer, p_limit integer default 16)
returns integer
language plpgsql volatile security invoker set search_path = '' as $function$
declare
  current_version smallint;
  job expedition_media_private.thumbnails%rowtype;
  changed integer := 0;
begin
  if p_limit is null or p_limit not between 1 and 64 then
    raise exception 'Invalid thumbnail rollout bounds' using errcode = '22023';
  end if;
  select s.target_version into strict current_version from expedition_media_private.thumbnail_settings s;
  if current_version is distinct from p_expected_target then return 0; end if;
  for job in
    select t.* from expedition_media_private.thumbnails t where t.variant = 'thumb' and t.processing_version < current_version
    order by t.processing_version, t.media_id limit p_limit for update of t skip locked
  loop
    perform expedition_media_private.reset_thumbnail(job.media_id, current_version, job.attempt_id);
    changed := changed + 1;
  end loop;
  return changed;
end;
$function$;

create function expedition_media_private.reconcile_media_ready(p_after uuid, p_limit integer, p_variant text)
returns table (next_after uuid, scanned integer, requeued integer)
language plpgsql volatile security invoker set search_path = '' as $function$
declare
  candidate record;
  job expedition_media_private.thumbnails%rowtype;
begin
  if p_limit is null or p_limit not between 1 and 128 then
    raise exception 'Invalid ready reconciliation bounds' using errcode = '22023';
  end if;
  scanned := 0;
  requeued := 0;
  if not expedition_media_private.media_bucket_supported(p_variant) then return next; return; end if;
  for candidate in
    select t.media_id, t.attempt_id, m.project_id from expedition_media_private.thumbnails t
    join public.expedition_project_journal_media m on m.id = t.media_id
    where t.variant = p_variant and t.state = 'ready' and t.media_id >= coalesce(p_after, '00000000-0000-0000-0000-000000000000'::uuid)
      and t.media_id is distinct from p_after
    order by t.media_id limit p_limit
  loop
    next_after := candidate.media_id;
    scanned := scanned + 1;
    if p_variant = 'display' and not expedition_media_private.display_project_eligible(candidate.project_id) then continue; end if;
    if exists (select 1 from expedition_media_private.media_lookup(candidate.project_id, candidate.media_id, p_variant)) then continue; end if;
    select t.* into job from expedition_media_private.thumbnails t
    where t.media_id = candidate.media_id and t.variant = p_variant and t.attempt_id = candidate.attempt_id and t.state = 'ready'
    for update of t skip locked;
    if not found or exists (select 1 from expedition_media_private.media_lookup(candidate.project_id, candidate.media_id, p_variant))
    then continue; end if;
    perform expedition_media_private.media_reset(job.media_id, job.processing_version, job.attempt_id, p_variant);
    requeued := requeued + 1;
  end loop;
  if scanned < p_limit then next_after := null; end if;
  return next;
end;
$function$;

create or replace function public.expedition_thumbnail_reconcile_ready(p_after uuid default null, p_limit integer default 32)
returns table (next_after uuid, scanned integer, requeued integer)
language sql volatile security invoker set search_path = '' as $function$
  select * from expedition_media_private.reconcile_media_ready(p_after,p_limit,'thumb');
$function$;

create function expedition_media_private.claim_media_rendition(
  p_limit integer, p_lease_seconds integer,
  p_supported_version integer, p_project_id uuid, p_variant text
)
returns table (
  media_id uuid, project_id uuid, attempt_id uuid, processing_version smallint, lease_until timestamptz,
  source_path text, source_mime text, source_size bigint, source_object_id uuid, source_version text, derivative_key text
)
language plpgsql volatile security invoker set search_path = '' as $function$
declare
  candidate record;
  job expedition_media_private.thumbnails%rowtype;
  source_row record;
  source_status text;
  issued integer := 0;
  attempt uuid;
  deadline timestamptz;
  key text;
  cutoff timestamptz := clock_timestamp();
begin
  if p_limit is null or p_limit not between 1 and 8 or p_lease_seconds is null or p_lease_seconds not between 15 and 120
    or p_supported_version is null or p_supported_version not in (1, 2) then
    raise exception 'Invalid thumbnail claim bounds' using errcode = '22023';
  end if;
  if not expedition_media_private.media_bucket_supported(p_variant) then return; end if;
  for candidate in
    select t.media_id, m.project_id as queue_project from expedition_media_private.thumbnails t
    join public.expedition_project_journal_media m on m.id = t.media_id
    where t.variant = p_variant and t.processing_version = p_supported_version
      and (p_variant <> 'display' or expedition_media_private.display_project_eligible(m.project_id)) and (p_project_id is null or m.project_id = p_project_id)
      and ((t.state = 'pending' and t.available_at <= cutoff) or (t.state = 'processing' and t.lease_until <= cutoff))
    order by case when t.state = 'pending' then t.available_at else t.lease_until end, t.media_id
    limit p_limit * 8
  loop
    exit when issued >= p_limit;
    if not pg_try_advisory_xact_lock(hashtextextended('expedition-thumbnail:' || candidate.queue_project::text, 0)) then continue; end if;
    if (select count(*) from expedition_media_private.thumbnails active
      join public.expedition_project_journal_media m on m.id = active.media_id
      where m.project_id = candidate.queue_project and active.state = 'processing' and active.lease_until > clock_timestamp()) >= 2
    then continue; end if;
    select t.* into job from expedition_media_private.thumbnails t
    where t.media_id = candidate.media_id and t.variant = p_variant and t.processing_version = p_supported_version
      and ((t.state = 'pending' and t.available_at <= cutoff) or (t.state = 'processing' and t.lease_until <= cutoff))
    for update of t skip locked;
    if not found then continue; end if;

    select s.* into source_row from expedition_media_private.inspect_thumbnail_source(job.media_id) s;
    source_status := coalesce(source_row.status, 'source_missing');
    if source_status <> 'verified' or job.attempt_count >= 5 then
      update expedition_media_private.thumbnails t set
        state = case when source_status in ('source_missing', 'source_unavailable') and job.attempt_count < 4 then 'pending' else 'failed' end,
        available_at = clock_timestamp() + make_interval(secs => 15 * (1 << least(5, job.attempt_count + 1))),
        attempt_count = least(5, job.attempt_count + 1), attempt_id = null, lease_until = null,
        source_object_id = null, source_version = null,
        last_error = case when source_status = 'verified' then 'lease_expired' else source_status end
      where t.media_id = job.media_id and t.variant = p_variant;
      continue;
    end if;

    attempt := gen_random_uuid();
    deadline := clock_timestamp() + make_interval(secs => p_lease_seconds);
    insert into expedition_media_private.thumbnail_cleanup as c (attempt_id, media_id, processing_version, available_at, variant)
    values (attempt, job.media_id, job.processing_version, deadline + interval '2 minutes', p_variant)
    returning c.object_key into key;
    update expedition_media_private.thumbnails t set state = 'processing', attempt_count = t.attempt_count + 1,
      attempt_id = attempt, lease_until = deadline, source_object_id = source_row.object_id,
      source_version = source_row.object_version, last_error = null
    where t.media_id = job.media_id and t.variant = p_variant;
    return query select job.media_id, source_row.project_id, attempt, job.processing_version, deadline,
      source_row.storage_path, source_row.mime_type, source_row.size_bytes, source_row.object_id, source_row.object_version, key;
    issued := issued + 1;
  end loop;
end;
$function$;

create or replace function public.expedition_thumbnail_claim(
  p_limit integer default 1, p_lease_seconds integer default 60,
  p_supported_version integer default 1, p_project_id uuid default null
)
returns table (
  media_id uuid, project_id uuid, attempt_id uuid, processing_version smallint, lease_until timestamptz,
  source_path text, source_mime text, source_size bigint, source_object_id uuid, source_version text, derivative_key text
)
language sql volatile security invoker set search_path = '' as $function$
  select * from expedition_media_private.claim_media_rendition(p_limit,p_lease_seconds,p_supported_version,p_project_id,'thumb');
$function$;

create or replace function public.expedition_thumbnail_may_upload(p_media_id uuid, p_attempt_id uuid)
returns boolean
language sql volatile security invoker set search_path = '' as $function$
  select exists (
    select 1 from expedition_media_private.thumbnails t
    join expedition_media_private.thumbnail_cleanup c on c.attempt_id = t.attempt_id and c.variant = t.variant and c.state = 'pending'
    join expedition_media_private.thumbnail_source(p_media_id) s
      on s.object_id = t.source_object_id and s.object_version = t.source_version
    where t.media_id = p_media_id and t.attempt_id = p_attempt_id
      and t.state = 'processing' and t.lease_until > clock_timestamp()
      and expedition_media_private.media_bucket_supported(t.variant)
      and (t.variant <> 'display' or expedition_media_private.display_project_eligible(s.project_id))
      and expedition_media_private.media_cleanup_state(c.object_key,t.variant) in ('absent', 'current')
  );
$function$;

create or replace function public.expedition_thumbnail_complete(
  p_media_id uuid, p_attempt_id uuid, p_source_id uuid, p_source_version text,
  p_derivative_id uuid, p_derivative_version text, p_width integer, p_height integer, p_size_bytes integer
)
returns boolean
language plpgsql volatile security invoker set search_path = '' as $function$
declare
  job expedition_media_private.thumbnails%rowtype;
begin
  if p_width is null or p_width not between 1 and 2048 or p_height is null or p_height not between 1 and 2048
    or p_size_bytes is null or p_size_bytes not between 1 and 524288
  then raise exception 'Invalid thumbnail output limits' using errcode = '22023'; end if;
  if p_derivative_id is null or p_derivative_version is null
  then return false; end if;

  select t.* into job from expedition_media_private.thumbnails t
  where t.media_id = p_media_id and t.attempt_id = p_attempt_id for update of t;
  if not found then return false; end if;
  if not expedition_media_private.media_bucket_supported(job.variant) or (job.variant='thumb' and (p_width>256 or p_height>256 or p_size_bytes>65536)) then return false; end if;
  if job.source_object_id is distinct from p_source_id or job.source_version is distinct from p_source_version
    or not exists (
      select 1 from expedition_media_private.thumbnail_source(p_media_id) s
      where s.object_id = p_source_id and s.object_version = p_source_version
        and (job.variant <> 'display' or expedition_media_private.display_project_eligible(s.project_id))
    )
  then return false; end if;

  -- A lost successful response may be retried as long as the publication is still current.
  if job.state = 'ready' then
    return job.derivative_object_id = p_derivative_id and job.derivative_version = p_derivative_version
      and job.width = p_width and job.height = p_height and job.size_bytes = p_size_bytes
      and exists (
        select 1 from expedition_media_private.thumbnail_source(p_media_id) s
        cross join lateral expedition_media_private.media_lookup(s.project_id,p_media_id,job.variant) ready
      );
  end if;

  if job.state <> 'processing' or job.lease_until <= clock_timestamp() then return false; end if;
  update expedition_media_private.thumbnail_cleanup c set state = 'held'
  where c.attempt_id = p_attempt_id and c.variant = job.variant and c.state = 'pending' and job.lease_until > clock_timestamp()
    and exists (
      select from expedition_media_private.current_storage_object(expedition_media_private.media_bucket(job.variant), c.object_key) o
      where o.id = p_derivative_id and o.version = p_derivative_version and btrim(o.version) <> ''
        and not o.is_versioned
        and o.metadata ->> 'size' = p_size_bytes::text and o.metadata ->> 'mimetype' = 'image/webp'
    );
  if not found then return false; end if;
  if not expedition_media_private.media_bucket_supported(job.variant) or (job.variant='thumb' and (p_width>256 or p_height>256 or p_size_bytes>65536)) then return false; end if;
  update expedition_media_private.thumbnails t set state = 'ready', lease_until = null,
    derivative_object_id = p_derivative_id, derivative_version = p_derivative_version,
    width = p_width, height = p_height, size_bytes = p_size_bytes
  where t.media_id = p_media_id and t.variant = job.variant and t.attempt_id = p_attempt_id;
  return true;
end;
$function$;

create function expedition_media_private.claim_media_cleanup(p_limit integer, p_lease_seconds integer, p_variant text)
returns table (attempt_id uuid, object_key text, lease_token uuid, lease_until timestamptz)
language plpgsql volatile security invoker set search_path = '' as $function$
declare
  cutoff timestamptz := clock_timestamp();
  candidate record;
  object_state text;
begin
  if p_limit is null or p_limit not between 1 and 16 or p_lease_seconds is null or p_lease_seconds not between 15 and 120 then
    raise exception 'Invalid thumbnail cleanup claim bounds' using errcode = '22023';
  end if;
  if not expedition_media_private.media_bucket_supported(p_variant) then return; end if;
  for candidate in
    with due as materialized (
      select c.attempt_id, c.attempt_count, c.object_key, c.available_at as due_at
      from expedition_media_private.thumbnail_cleanup c where c.variant = p_variant and c.state = 'pending' and c.available_at <= cutoff
      order by c.available_at, c.attempt_id limit p_limit for update of c skip locked
    ), expired as materialized (
      select c.attempt_id, c.attempt_count, c.object_key, c.lease_until as due_at
      from expedition_media_private.thumbnail_cleanup c where c.variant = p_variant and c.state = 'processing' and c.lease_until <= cutoff
      order by c.lease_until, c.attempt_id limit p_limit for update of c skip locked
    )
    select * from due union all select * from expired order by due_at, attempt_id limit p_limit
  loop
    object_state := expedition_media_private.media_cleanup_state(candidate.object_key,p_variant);
    if object_state not in ('absent', 'current') or candidate.attempt_count >= 8 then
      update expedition_media_private.thumbnail_cleanup c set state = 'failed', available_at = clock_timestamp(),
        lease_token = null, lease_until = null,
        last_error = case when object_state in ('absent', 'current') then 'lease_expired' else object_state end
      where c.attempt_id = candidate.attempt_id;
      continue;
    end if;
    return query
    update expedition_media_private.thumbnail_cleanup c set state = 'processing',
      attempt_count = c.attempt_count + 1, lease_token = gen_random_uuid(),
      lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds)
    where c.attempt_id = candidate.attempt_id
    returning c.attempt_id, c.object_key, c.lease_token, c.lease_until;
  end loop;
end;
$function$;

create or replace function public.expedition_thumbnail_claim_cleanup(p_limit integer default 4, p_lease_seconds integer default 60)
returns table (attempt_id uuid, object_key text, lease_token uuid, lease_until timestamptz)
language sql volatile security invoker set search_path = '' as $function$
  select * from expedition_media_private.claim_media_cleanup(p_limit,p_lease_seconds,'thumb');
$function$;

create function public.expedition_media_claim_cleanup()
returns table (attempt_id uuid, object_key text, lease_token uuid, lease_until timestamptz, variant text)
language plpgsql volatile security invoker set search_path = '' as $function$
declare
  remaining integer := 2;
begin
  return query select c.*, 'display'::text from expedition_media_private.claim_media_cleanup(1,90,'display') c;
  if found then remaining := 1; end if;
  return query select c.*, 'thumb'::text from expedition_media_private.claim_media_cleanup(remaining,90,'thumb') c;
end;
$function$;

create or replace function public.expedition_thumbnail_finish_cleanup(p_attempt_id uuid, p_lease_token uuid)
returns boolean
language plpgsql volatile security invoker set search_path = '' as $function$
declare
  job expedition_media_private.thumbnail_cleanup%rowtype;
  object_state text;
begin
  select c.* into job from expedition_media_private.thumbnail_cleanup c
  where c.attempt_id = p_attempt_id and c.lease_token = p_lease_token and c.state = 'processing'
  for update of c;
  if not found or job.lease_until <= clock_timestamp() then return false; end if;
  object_state := case when expedition_media_private.media_bucket_supported(job.variant)
    then expedition_media_private.media_cleanup_state(job.object_key,job.variant)
    else 'storage_bucket_unsupported' end;
  update expedition_media_private.thumbnail_cleanup c set
    state = case when object_state = 'absent' then 'done'
      when object_state = 'current' and job.attempt_count < 8 then 'pending' else 'failed' end,
    available_at = case when object_state = 'current' and job.attempt_count < 8
      then clock_timestamp() + make_interval(secs => least(900, 15 * (1 << job.attempt_count))) else clock_timestamp() end,
    lease_token = null, lease_until = null, completed_at = case when object_state = 'absent' then clock_timestamp() end,
    last_error = case object_state when 'absent' then null when 'current' then 'object_still_present' else object_state end
  where c.attempt_id = job.attempt_id;
  return object_state = 'absent';
end;
$function$;

create function expedition_media_private.reconcile_media_cleanup(p_after uuid, p_limit integer, p_variant text)
returns table (next_after uuid, scanned integer, requeued integer)
language plpgsql volatile security invoker set search_path = '' as $function$
declare
  candidate record;
  object_state text;
begin
  if p_limit is null or p_limit not between 1 and 256 then
    raise exception 'Invalid cleanup reconciliation bounds' using errcode = '22023';
  end if;
  scanned := 0;
  requeued := 0;
  if not expedition_media_private.media_bucket_supported(p_variant) then return next; return; end if;
  for candidate in
    select c.attempt_id, c.object_key from expedition_media_private.thumbnail_cleanup c
    where c.variant = p_variant and c.state = 'done' and c.attempt_id >= coalesce(p_after, '00000000-0000-0000-0000-000000000000'::uuid)
      and c.attempt_id is distinct from p_after
    order by c.attempt_id limit p_limit
  loop
    next_after := candidate.attempt_id;
    scanned := scanned + 1;
    object_state := expedition_media_private.media_cleanup_state(candidate.object_key,p_variant);
    if object_state = 'absent' then continue; end if;
    update expedition_media_private.thumbnail_cleanup c set
      state = case when object_state = 'current' then 'pending' else 'failed' end,
      available_at = clock_timestamp(), completed_at = null, attempt_count = 0,
      last_error = case when object_state <> 'current' then object_state end
    where c.attempt_id = candidate.attempt_id and c.state = 'done';
    if found and object_state = 'current' then requeued := requeued + 1; end if;
  end loop;
  if scanned < p_limit then next_after := null; end if;
  return next;
end;
$function$;

create or replace function public.expedition_thumbnail_reconcile_cleanup(p_after uuid default null, p_limit integer default 64)
returns table (next_after uuid, scanned integer, requeued integer)
language sql volatile security invoker set search_path = '' as $function$
  select * from expedition_media_private.reconcile_media_cleanup(p_after,p_limit,'thumb');
$function$;

create or replace function public.expedition_thumbnail_worker_may_remove(p_attempt_id uuid, p_lease_token uuid)
returns boolean
language sql volatile security invoker set search_path = '' as $function$
  select exists (
    select from expedition_media_private.thumbnail_cleanup c
    where c.attempt_id = p_attempt_id and c.lease_token = p_lease_token
      and c.state = 'processing' and c.lease_until > clock_timestamp()
      and expedition_media_private.media_bucket_supported(c.variant)
      and expedition_media_private.media_cleanup_state(c.object_key,c.variant) = 'current'
  );
$function$;

create or replace function expedition_media_private.thumbnail_media_lifecycle()
returns trigger
language plpgsql volatile security definer set search_path = '' as $function$
declare current_attempt uuid;
begin
  if tg_relid <> 'public.expedition_project_journal_media'::regclass or tg_level <> 'ROW' then
    raise exception 'Unexpected thumbnail trigger relation or level';
  end if;
  if tg_op = 'INSERT' then
    if new.media_type = 'photo' then
      insert into expedition_media_private.thumbnails (media_id, processing_version)
      select new.id, s.target_version from expedition_media_private.thumbnail_settings s
      on conflict (media_id, variant) do nothing;
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    -- Lock manifest before touching its reservation, matching completion order.
    for current_attempt in
      select t.attempt_id from expedition_media_private.thumbnails t
      where t.media_id = old.id order by t.variant for update of t
    loop
      update expedition_media_private.thumbnail_cleanup c set state = 'pending', available_at = clock_timestamp()
      where c.attempt_id = current_attempt and c.state = 'held';
    end loop;
    return old;
  end if;
  raise exception 'Unexpected thumbnail trigger operation';
end;
$function$;

create or replace function public.expedition_thumbnail_backfill_page(p_after uuid, p_published boolean, p_apply boolean)
returns jsonb
language plpgsql volatile security invoker set search_path = '' as $function$
declare
  candidate record;
  next_after uuid;
  scanned integer := 0;
  photos integer := 0;
  ready integer := 0;
  pending integer := 0;
  failed integer := 0;
  unqueued integer := 0;
  enqueued integer := 0;
  missing integer := 0;
  invalid integer := 0;
  unavailable integer := 0;
  stale integer := 0;
  source_status text;
begin
  if p_published is null or p_apply is null then
    raise exception 'Specify a published pass and an apply mode' using errcode = '22023';
  end if;
  for candidate in
    with page as materialized (
      select m.id, m.project_id, m.media_type from public.expedition_project_journal_media m
      where m.id >= coalesce(p_after, '00000000-0000-0000-0000-000000000000'::uuid)
        and m.id is distinct from p_after
      order by m.id limit 64
    )
    select p.*, t.state, exists (select from public.expedition_project_shares s
      where s.project_id = p.project_id and s.is_enabled) as published
    from page p left join expedition_media_private.thumbnails t on t.media_id = p.id and t.variant = 'thumb'
    order by p.id
  loop
    scanned := scanned + 1;
    next_after := candidate.id;
    if candidate.media_type <> 'photo' or candidate.published <> p_published then continue; end if;
    photos := photos + 1;
    select s.status into source_status from expedition_media_private.inspect_thumbnail_source(candidate.id) s;
    missing := missing + case when source_status is null or source_status = 'source_missing' then 1 else 0 end;
    invalid := invalid + case when source_status = 'invalid_source' then 1 else 0 end;
    unavailable := unavailable + case when source_status = 'source_unavailable' then 1 else 0 end;
    case
      when candidate.state = 'ready' then
        if exists (select from public.expedition_thumbnail_lookup(candidate.project_id, candidate.id))
        then ready := ready + 1; else stale := stale + 1; end if;
      when candidate.state = 'failed' then failed := failed + 1;
      when candidate.state in ('pending', 'processing') then pending := pending + 1;
      else
        unqueued := unqueued + 1;
        if p_apply and source_status = 'verified' then
          if public.expedition_thumbnail_enqueue(candidate.project_id, candidate.id) then
            enqueued := enqueued + 1;
          end if;
        end if;
    end case;
  end loop;
  return jsonb_build_object('next_after', case when scanned = 64 then next_after end,
    'scanned', scanned, 'photos', photos, 'ready', ready, 'pending', pending, 'failed', failed,
    'unqueued', unqueued, 'enqueued', enqueued, 'missing', missing, 'invalid', invalid,
    'unavailable', unavailable, 'stale', stale);
end;
$function$;

create function public.expedition_display_photo_backfill_page(p_after uuid, p_apply boolean)
returns jsonb
language plpgsql volatile security invoker set search_path = '' as $function$
declare
  candidate record;
  next_after uuid;
  scanned integer := 0;
  eligible integer := 0;
  ready integer := 0;
  pending integer := 0;
  failed integer := 0;
  verified integer := 0;
  enqueued integer := 0;
  source_status text;
  manifest_state text;
  violated_constraint text;
begin
  if p_apply is null then raise exception 'Specify display apply mode' using errcode = '22023'; end if;
  if p_apply and not expedition_media_private.media_bucket_supported('display') then
    raise exception 'Unsupported display bucket' using errcode = '55000';
  end if;
  for candidate in
    select m.id, m.project_id, m.media_type from public.expedition_project_journal_media m
    where m.id >= coalesce(p_after, '00000000-0000-0000-0000-000000000000'::uuid)
      and m.id is distinct from p_after order by m.id limit 64
  loop
    scanned := scanned + 1;
    next_after := candidate.id;
    if candidate.media_type <> 'photo' or not expedition_media_private.display_project_eligible(candidate.project_id) then
      continue;
    end if;
    eligible := eligible + 1;
    select s.status into source_status from expedition_media_private.inspect_thumbnail_source(candidate.id) s;
    if source_status = 'verified' then verified := verified + 1; end if;
    select t.state into manifest_state from expedition_media_private.thumbnails t
      where t.media_id = candidate.id and t.variant = 'display';
    if manifest_state = 'ready' and exists (
      select 1 from public.expedition_display_photo_lookup(candidate.project_id,candidate.id)
    ) then
      ready := ready + 1;
    elsif manifest_state in ('pending','processing') then
      pending := pending + 1;
    elsif manifest_state = 'failed' then
      failed := failed + 1;
    elsif manifest_state is null and p_apply and source_status = 'verified' then
      begin
        insert into expedition_media_private.thumbnails (media_id, processing_version, variant)
        select m.id, 1, 'display' from public.expedition_project_journal_media m
        where m.id = candidate.id and m.project_id = candidate.project_id and m.media_type = 'photo'
          and expedition_media_private.display_project_eligible(candidate.project_id)
        on conflict (media_id, variant) do nothing;
        if found then enqueued := enqueued + 1; end if;
      exception when foreign_key_violation then
        get stacked diagnostics violated_constraint = constraint_name;
        if violated_constraint <> 'thumbnail_canonical_media_fk' then raise; end if;
      end;
    end if;
  end loop;
  return jsonb_build_object('next_after', case when scanned = 64 then next_after end,
    'scanned', scanned, 'eligible', eligible, 'verified', verified,
    'ready', ready, 'pending', pending, 'failed', failed, 'enqueued', enqueued);
end;
$function$;

create function public.expedition_media_worker_claim(p_token uuid, p_supported_version integer, p_display boolean)
returns table (
  media_id uuid, project_id uuid, attempt_id uuid, processing_version smallint, lease_until timestamptz,
  source_path text, source_mime text, source_size bigint, source_object_id uuid, source_version text, derivative_key text,
  variant text
)
language plpgsql volatile security invoker set search_path = '' as $function$
declare
  worker expedition_media_private.thumbnail_worker_state%rowtype;
  next_project uuid;
  chosen text;
  variants text[];
  scanned integer := 0;
  next_ready uuid;
  next_cleanup uuid;
  next_seed uuid;
begin
  if p_display is null or p_supported_version is null or p_supported_version not in (1,2) then
    raise exception 'Unsupported media worker bounds' using errcode = '22023';
  end if;
  select w.* into worker from expedition_media_private.thumbnail_worker_state w
    where w.singleton and w.lease_token = p_token and w.lease_until > clock_timestamp() for update;
  if not found then return; end if;

  select c.next_after into next_cleanup
    from expedition_media_private.reconcile_media_cleanup(worker.display_cleanup_after,12,'display') c;
  update expedition_media_private.thumbnail_worker_state set display_cleanup_after = next_cleanup where singleton;

  if p_display and expedition_media_private.media_bucket_supported('display') then
    select r.next_after into next_ready
      from expedition_media_private.reconcile_media_ready(worker.display_ready_after,8,'display') r;
    next_seed := (public.expedition_display_photo_backfill_page(worker.display_seed_after,true)->>'next_after')::uuid;
    update expedition_media_private.thumbnail_worker_state
      set display_ready_after = next_ready, display_seed_after = next_seed where singleton;
    variants := case when worker.prefer_display then array['display','thumb'] else array['thumb','display'] end;
  else
    variants := array['thumb'];
  end if;

  for next_project in
    select p.id from public.expedition_projects p
    where p.id >= coalesce(worker.project_after,'00000000-0000-0000-0000-000000000000'::uuid)
      and p.id is distinct from worker.project_after order by p.id limit 16
  loop
    scanned := scanned + 1;
    update expedition_media_private.thumbnail_worker_state set project_after = next_project where singleton;
    foreach chosen in array variants loop
      if worker.lease_until <= clock_timestamp() then return; end if;
      return query select c.*, chosen from expedition_media_private.claim_media_rendition(
        1,90,case when chosen = 'display' then 1 else p_supported_version end,next_project,chosen) c;
      if found then
        update expedition_media_private.thumbnail_worker_state set prefer_display = (chosen = 'thumb') where singleton;
        return;
      end if;
    end loop;
  end loop;
  if scanned < 16 then update expedition_media_private.thumbnail_worker_state set project_after = null where singleton; end if;
end;
$function$;

revoke all on function
  expedition_media_private.media_bucket(text),
  expedition_media_private.media_bucket_supported(text),
  expedition_media_private.display_project_eligible(uuid),
  expedition_media_private.media_lookup(uuid, uuid, text),
  expedition_media_private.media_reset(uuid, smallint, uuid, text),
  expedition_media_private.media_cleanup_state(text, text),
  public.expedition_display_photo_lookup(uuid, uuid),
  expedition_media_private.reconcile_media_ready(uuid, integer, text),
  expedition_media_private.claim_media_rendition(integer, integer, integer, uuid, text),
  expedition_media_private.claim_media_cleanup(integer, integer, text),
  expedition_media_private.reconcile_media_cleanup(uuid, integer, text),
  public.expedition_media_claim_cleanup(),
  public.expedition_display_photo_backfill_page(uuid, boolean),
  public.expedition_media_worker_claim(uuid, integer, boolean)
from public, anon, authenticated, service_role;
grant execute on function
  expedition_media_private.media_bucket(text),
  expedition_media_private.media_bucket_supported(text),
  expedition_media_private.display_project_eligible(uuid),
  expedition_media_private.media_lookup(uuid, uuid, text),
  expedition_media_private.media_reset(uuid, smallint, uuid, text),
  expedition_media_private.media_cleanup_state(text, text),
  public.expedition_display_photo_lookup(uuid, uuid),
  expedition_media_private.reconcile_media_ready(uuid, integer, text),
  expedition_media_private.claim_media_rendition(integer, integer, integer, uuid, text),
  expedition_media_private.claim_media_cleanup(integer, integer, text),
  expedition_media_private.reconcile_media_cleanup(uuid, integer, text),
  public.expedition_media_claim_cleanup(),
  public.expedition_display_photo_backfill_page(uuid, boolean),
  public.expedition_media_worker_claim(uuid, integer, boolean)
to service_role;

notify pgrst, 'reload schema';
commit;
