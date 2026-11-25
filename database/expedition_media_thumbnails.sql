-- MANUAL REVIEW AND DEPLOYMENT ONLY. See expedition_media_thumbnails_review.md.
-- Install the restrictive policy before provisioning the private WebP bucket
-- through the Storage API or Dashboard. An existing bucket must match exactly.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $preflight$
begin
  if current_user <> 'postgres' then
    raise exception 'Apply the thumbnail contract as postgres';
  end if;
  if exists (
    select from (values
      ('storage.objects', 'id', 'uuid', true),
      ('storage.objects', 'bucket_id', 'text', false),
      ('storage.objects', 'name', 'text', false),
      ('storage.objects', 'version', 'text', false),
      ('storage.objects', 'metadata', 'jsonb', false),
      ('storage.objects', 'archived_at', 'timestamptz', false),
      ('storage.objects', 'is_delete_marker', 'boolean', true),
      ('storage.objects', 'is_versioned', 'boolean', true),
      ('storage.buckets', 'versioning_status', 'text', true)
    ) expected(relation, field, data_type, required)
    where not exists (
      select from pg_catalog.pg_attribute a
      where a.attrelid = to_regclass(expected.relation) and a.attname = expected.field
        and not a.attisdropped and a.atttypid = to_regtype(expected.data_type)
        and (not expected.required or a.attnotnull)
        and (a.attname <> 'archived_at' or not a.attnotnull)
    )
  ) or not exists (
    select from pg_catalog.pg_attrdef d
    join pg_catalog.pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
    where d.adrelid = to_regclass('storage.buckets') and a.attname = 'versioning_status'
      and pg_get_expr(d.adbin, d.adrelid) = '''DISABLED''::text'
  ) then
    raise exception 'Unexpected Storage object or bucket versioning columns';
  end if;
  if not exists (
    select from pg_catalog.pg_index i
    join pg_catalog.pg_class idx on idx.oid = i.indexrelid
    join pg_catalog.pg_am am on am.oid = idx.relam
    join pg_catalog.pg_attribute bucket on bucket.attrelid = i.indrelid and bucket.attnum = i.indkey[0]
    join pg_catalog.pg_attribute path on path.attrelid = i.indrelid and path.attnum = i.indkey[1]
    join pg_catalog.pg_opclass bucket_ops on bucket_ops.oid = i.indclass[0]
    join pg_catalog.pg_opclass path_ops on path_ops.oid = i.indclass[1]
    where i.indrelid = 'storage.objects'::regclass and am.amname = 'btree'
      and i.indisunique and i.indimmediate and i.indisvalid and i.indisready and i.indislive
      and i.indnkeyatts = 2 and bucket.attname = 'bucket_id' and path.attname = 'name'
      and i.indcollation[0] = 'pg_catalog."default"'::regcollation
      and i.indcollation[1] = 'pg_catalog."C"'::regcollation
      and bucket_ops.opcname = 'text_ops' and path_ops.opcname = 'text_ops'
      and bucket_ops.opcnamespace = 'pg_catalog'::regnamespace and path_ops.opcnamespace = 'pg_catalog'::regnamespace
      and pg_get_expr(i.indpred, i.indrelid) = '(archived_at IS NULL)'
  ) then
    raise exception 'Storage is missing the reviewed unique current-object index';
  end if;
  if not exists (
    select from pg_catalog.pg_constraint c
    join pg_catalog.pg_attribute a on a.attrelid = c.conrelid and a.attname = 'id'
    where c.conrelid = 'storage.objects'::regclass and c.contype = 'p'
      and c.convalidated and c.conkey = array[a.attnum]
  ) or not exists (
    select from pg_catalog.pg_index i
    where i.indrelid = 'storage.objects'::regclass and i.indisunique and i.indimmediate
      and i.indisvalid and i.indisready and i.indislive and i.indnullsnotdistinct
      and i.indpred is null
      and strpos(pg_get_indexdef(i.indexrelid),
        ' USING btree (bucket_id, name COLLATE "C", version) NULLS NOT DISTINCT') > 0
  ) then
    raise exception 'Storage is missing the reviewed unique object ID or path/version constraint';
  end if;
  if not exists (
    select from storage.buckets where id = 'expedition-media'
      and versioning_status in ('DISABLED', 'ENABLED', 'SUSPENDED')
  ) then
    raise exception 'Expected the canonical original bucket with a recognized versioning status';
  end if;
  if exists (
    select 1 from storage.buckets
    where id = 'expedition-media-thumbnails' and (
      name is distinct from id or public is distinct from false
      or file_size_limit is distinct from 65536 or allowed_mime_types is distinct from array['image/webp']::text[]
      or versioning_status is distinct from 'DISABLED'
    )
  ) then
    raise exception 'Expected private WebP-only expedition-media-thumbnails bucket with a 65536-byte limit and versioning DISABLED';
  end if;
  if exists (
    select from storage.objects o where o.bucket_id = 'expedition-media-thumbnails'
      and (o.archived_at is not null or o.is_delete_marker or o.is_versioned)
  ) then
    raise exception 'Existing thumbnail bucket contains unsupported Storage history';
  end if;
  if (select count(*) from pg_catalog.pg_class
      where oid in ('storage.objects'::regclass, 'storage.buckets'::regclass) and relrowsecurity) <> 2
    or not exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role' and rolbypassrls)
    or exists (select 1 from pg_catalog.pg_roles where rolname in ('anon', 'authenticated') and (rolsuper or rolbypassrls))
    or pg_has_role('anon', 'service_role', 'MEMBER') or pg_has_role('authenticated', 'service_role', 'MEMBER')
    or not has_schema_privilege('service_role', 'storage', 'USAGE')
    or not has_table_privilege('service_role', 'storage.objects', 'SELECT')
    or not has_table_privilege('service_role', 'storage.buckets', 'SELECT')
    or not has_table_privilege('service_role', 'public.expedition_project_journal_media', 'SELECT')
  then
    raise exception 'Expected Storage RLS and existing server-only catalog access';
  end if;
end;
$preflight$;

-- AND this restriction with existing permissive Storage policies. Other buckets
-- evaluate to true here and retain their full existing policy behavior.
create policy expedition_media_thumbnails_server_only on storage.objects
as restrictive for all to anon, authenticated
using (bucket_id <> 'expedition-media-thumbnails')
with check (bucket_id <> 'expedition-media-thumbnails');

-- Protect the private bucket settings as well as its contents.
create policy expedition_media_thumbnail_bucket_server_only on storage.buckets
as restrictive for all to anon, authenticated
using (id <> 'expedition-media-thumbnails')
with check (id <> 'expedition-media-thumbnails');

create schema expedition_media_private authorization postgres;
revoke all on schema expedition_media_private from public, anon, authenticated, service_role;
grant usage on schema expedition_media_private to service_role;

create table expedition_media_private.thumbnail_settings (
  singleton boolean primary key default true check (singleton),
  target_version smallint not null check (target_version in (1, 2))
);
insert into expedition_media_private.thumbnail_settings (target_version) values (1);

-- Each claimed attempt registers one immutable key before any Storage write.
-- Independent of the media FK so deletion and crashes cannot erase cleanup work.
create table expedition_media_private.thumbnail_cleanup (
  attempt_id uuid primary key,
  media_id uuid not null,
  processing_version smallint not null check (processing_version > 0),
  object_key text generated always as (
    media_id::text || '/v' || processing_version::text || '/' || attempt_id::text || '.webp'
  ) stored unique not null,
  state text not null default 'pending' check (state in ('pending', 'held', 'processing', 'done', 'failed')),
  available_at timestamptz not null,
  attempt_count smallint not null default 0 check (attempt_count between 0 and 8),
  last_error text check (last_error in ('object_still_present', 'lease_expired',
    'storage_history_present', 'storage_identity_ambiguous', 'storage_bucket_unsupported')),
  lease_token uuid,
  lease_until timestamptz,
  completed_at timestamptz,
  unique (media_id, processing_version, attempt_id),
  check ((state = 'processing') = (lease_token is not null)),
  check ((state = 'processing') = (lease_until is not null)),
  check ((state = 'done') = (completed_at is not null))
);

-- A single row is both the generation job and the serving manifest. Original
-- metadata stays on the canonical media row and is read at claim/finish time.
create table expedition_media_private.thumbnails (
  media_id uuid primary key constraint thumbnail_canonical_media_fk references public.expedition_project_journal_media(id) on delete cascade,
  processing_version smallint not null check (processing_version in (1, 2)),
  state text not null default 'pending' check (state in ('pending', 'processing', 'ready', 'failed')),
  enqueued_at timestamptz not null default clock_timestamp(),
  available_at timestamptz not null default clock_timestamp(),
  attempt_count smallint not null default 0 check (attempt_count between 0 and 5),
  attempt_id uuid,
  lease_until timestamptz,
  source_object_id uuid,
  source_version text check (btrim(source_version) <> ''),
  derivative_object_id uuid,
  derivative_version text check (btrim(derivative_version) <> ''),
  width integer check (width between 1 and 256),
  height integer check (height between 1 and 256),
  size_bytes integer check (size_bytes between 1 and 65536),
  last_error text check (last_error in ('source_missing', 'source_unavailable', 'source_changed', 'invalid_source', 'storage', 'processing', 'lease_expired')),
  foreign key (media_id, processing_version, attempt_id)
    references expedition_media_private.thumbnail_cleanup(media_id, processing_version, attempt_id),
  check ((state = 'processing') = (lease_until is not null)),
  check ((state in ('processing', 'ready')) = (attempt_id is not null)),
  check ((state in ('processing', 'ready')) = (source_object_id is not null)),
  check ((state in ('processing', 'ready')) = (source_version is not null)),
  check ((state = 'ready') = (derivative_object_id is not null)),
  check ((state = 'ready') = (derivative_version is not null)),
  check ((state = 'ready') = (width is not null)),
  check ((state = 'ready') = (height is not null)),
  check ((state = 'ready') = (size_bytes is not null))
);

create index expedition_thumbnails_pending_idx on expedition_media_private.thumbnails (processing_version, available_at, media_id) where state = 'pending';
create index expedition_thumbnails_processing_idx on expedition_media_private.thumbnails (processing_version, lease_until, media_id) where state = 'processing';
create index expedition_thumbnails_ready_idx on expedition_media_private.thumbnails (media_id) where state = 'ready';
create index expedition_thumbnails_version_idx on expedition_media_private.thumbnails (processing_version, media_id);
create index expedition_thumbnail_cleanup_pending_idx on expedition_media_private.thumbnail_cleanup (available_at, attempt_id) where state = 'pending';
create index expedition_thumbnail_cleanup_processing_idx on expedition_media_private.thumbnail_cleanup (lease_until, attempt_id) where state = 'processing';
create index expedition_thumbnail_cleanup_done_idx on expedition_media_private.thumbnail_cleanup (attempt_id) where state = 'done';
create index expedition_thumbnail_cleanup_failed_idx on expedition_media_private.thumbnail_cleanup (available_at, attempt_id) where state = 'failed';

alter table expedition_media_private.thumbnails enable row level security;
alter table expedition_media_private.thumbnail_cleanup enable row level security;
alter table expedition_media_private.thumbnail_settings enable row level security;
revoke all on all tables in schema expedition_media_private from public, anon, authenticated, service_role;
grant select, insert, update on expedition_media_private.thumbnails, expedition_media_private.thumbnail_cleanup to service_role;
grant select on expedition_media_private.thumbnail_settings to service_role;
grant update (target_version) on expedition_media_private.thumbnail_settings to service_role;

-- Match the Storage API's exact path collation and current-row predicate.
-- Count candidates before filtering markers, metadata or a caller's identity.
create function expedition_media_private.current_storage_object(p_bucket text, p_path text)
returns table (id uuid, version text, metadata jsonb, is_versioned boolean)
language sql stable security invoker set search_path = '' as $function$
  with candidates as materialized (
    select o.id, o.version, o.metadata, o.is_versioned, o.is_delete_marker
    from storage.objects o
    where o.bucket_id = p_bucket and o.name collate pg_catalog."C" = p_path
      and o.archived_at is null
    limit 2
  )
  select c.id, c.version, c.metadata, c.is_versioned
  from candidates c where (select count(*) from candidates) = 1 and not c.is_delete_marker;
$function$;

create function expedition_media_private.thumbnail_derivative_bucket_supported()
returns boolean
language sql stable security invoker set search_path = '' as $function$
  select exists (
    select from storage.buckets b where b.id = 'expedition-media-thumbnails'
      and b.name = b.id and b.public is false and b.versioning_status = 'DISABLED'
      and b.allowed_mime_types = array['image/webp']::text[] and b.file_size_limit = 65536
  );
$function$;

-- Path-only removal cannot clean historical versions or markers. Two rows
-- suffice to reject ambiguous paths even if the live unique index drifts.
create function expedition_media_private.thumbnail_cleanup_storage_state(p_path text)
returns text
language sql stable security invoker set search_path = '' as $function$
  with candidates as (
    select o.archived_at is not null or o.is_versioned or o.is_delete_marker as history
    from storage.objects o
    where o.bucket_id = 'expedition-media-thumbnails' and o.name collate pg_catalog."C" = p_path
    limit 2
  )
  select case when bool_or(history) then 'storage_history_present'
    when count(*) > 1 then 'storage_identity_ambiguous'
    when count(*) = 1 then 'current'
    else 'absent'
  end from candidates;
$function$;

create function expedition_media_private.inspect_thumbnail_source(p_media_id uuid)
returns table (project_id uuid, storage_path text, mime_type text, size_bytes bigint, object_id uuid, object_version text, status text)
language sql stable security invoker set search_path = '' as $function$
  select m.project_id, m.storage_path, m.mime_type, m.size_bytes, o.id, o.version,
    case
      when m.mime_type not in ('image/jpeg', 'image/png', 'image/webp') or m.size_bytes not between 1 and 10485760 then 'invalid_source'
      when o.id is null then 'source_missing'
      when (o.metadata ->> 'size' is not null and o.metadata ->> 'size' <> m.size_bytes::text)
        or (o.metadata ->> 'mimetype' is not null and o.metadata ->> 'mimetype' <> m.mime_type) then 'invalid_source'
      when nullif(btrim(o.version), '') is null or o.metadata ->> 'size' is null or o.metadata ->> 'mimetype' is null then 'source_unavailable'
      else 'verified'
    end
  from public.expedition_project_journal_media m
  left join lateral expedition_media_private.current_storage_object('expedition-media', m.storage_path) o on true
  where m.id = p_media_id and m.media_type = 'photo';
$function$;

create function expedition_media_private.thumbnail_source(p_media_id uuid)
returns table (project_id uuid, storage_path text, mime_type text, size_bytes bigint, object_id uuid, object_version text)
language sql stable security invoker set search_path = '' as $function$
  select s.project_id, s.storage_path, s.mime_type, s.size_bytes, s.object_id, s.object_version
  from expedition_media_private.inspect_thumbnail_source(p_media_id) s where s.status = 'verified';
$function$;

-- Internal capability used only after the app has resolved the enabled share.
-- Scope by BOTH project and media, and verify the exact catalog generations.
create function public.expedition_thumbnail_lookup(p_project_id uuid, p_media_id uuid)
returns table (object_key text, object_id uuid, object_version text, size_bytes integer, width integer, height integer)
language sql stable security invoker set search_path = '' as $function$
  select c.object_key, o.id, o.version, t.size_bytes, t.width, t.height
  from expedition_media_private.thumbnails t
  join expedition_media_private.thumbnail_cleanup c on c.attempt_id = t.attempt_id and c.state = 'held'
  join expedition_media_private.thumbnail_source(p_media_id) s
    on s.object_id = t.source_object_id and s.object_version = t.source_version
  join lateral expedition_media_private.current_storage_object('expedition-media-thumbnails', c.object_key) o
    on o.id = t.derivative_object_id and o.version = t.derivative_version and not o.is_versioned
  where t.media_id = p_media_id and s.project_id = p_project_id and t.state = 'ready'
    and expedition_media_private.thumbnail_derivative_bucket_supported()
    and o.metadata ->> 'size' = t.size_bytes::text and o.metadata ->> 'mimetype' = 'image/webp';
$function$;

-- Call only with the manifest row locked. Active attempt reservations remain
-- armed until lease plus grace, including when a version upgrade fences them.
create function expedition_media_private.reset_thumbnail(p_media_id uuid, p_version smallint, p_attempt_id uuid)
returns void
language plpgsql volatile security invoker set search_path = '' as $function$
begin
  update expedition_media_private.thumbnail_cleanup c set state = 'pending', available_at = clock_timestamp()
  where c.attempt_id = p_attempt_id and c.state = 'held';
  update expedition_media_private.thumbnails t set processing_version = p_version,
    state = 'pending', enqueued_at = clock_timestamp(), available_at = clock_timestamp(),
    attempt_count = 0, attempt_id = null, lease_until = null,
    source_object_id = null, source_version = null, derivative_object_id = null, derivative_version = null,
    width = null, height = null, size_bytes = null, last_error = null
  where t.media_id = p_media_id;
end;
$function$;

-- Backfill and explicit repair only. Replaying a normal enqueue changes nothing.
create function public.expedition_thumbnail_enqueue(p_project_id uuid, p_media_id uuid, p_repair boolean default false)
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
    on conflict (media_id) do nothing;
    if found then return true; end if;
  exception when foreign_key_violation then
    get stacked diagnostics violated_constraint = constraint_name;
    if violated_constraint = 'thumbnail_canonical_media_fk' then return false; end if;
    raise;
  end;
  if p_repair is not true then return false; end if;

  select t.* into job from expedition_media_private.thumbnails t
  join public.expedition_project_journal_media m on m.id = t.media_id
  where t.media_id = p_media_id and m.project_id = p_project_id and m.media_type = 'photo'
  for update of t;
  if not found or job.state not in ('failed', 'ready') then return false; end if;
  if job.state = 'ready' and (not expedition_media_private.thumbnail_derivative_bucket_supported()
    or exists (select 1 from public.expedition_thumbnail_lookup(p_project_id, p_media_id)))
  then return false; end if;
  perform expedition_media_private.reset_thumbnail(job.media_id, job.processing_version, job.attempt_id);
  return true;
end;
$function$;

-- This sweep never inserts jobs. It rechecks the exact ready attempt under lock
-- so deletion, an operator repair or a newer publication wins over the scan.
create function public.expedition_thumbnail_reconcile_ready(p_after uuid default null, p_limit integer default 32)
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
  if not expedition_media_private.thumbnail_derivative_bucket_supported() then return next; return; end if;
  for candidate in
    select t.media_id, t.attempt_id, m.project_id from expedition_media_private.thumbnails t
    join public.expedition_project_journal_media m on m.id = t.media_id
    where t.state = 'ready' and t.media_id >= coalesce(p_after, '00000000-0000-0000-0000-000000000000'::uuid)
      and t.media_id is distinct from p_after
    order by t.media_id limit p_limit
  loop
    next_after := candidate.media_id;
    scanned := scanned + 1;
    if exists (select 1 from public.expedition_thumbnail_lookup(candidate.project_id, candidate.media_id)) then continue; end if;
    select t.* into job from expedition_media_private.thumbnails t
    where t.media_id = candidate.media_id and t.attempt_id = candidate.attempt_id and t.state = 'ready'
    for update of t skip locked;
    if not found or exists (select 1 from public.expedition_thumbnail_lookup(candidate.project_id, candidate.media_id))
    then continue; end if;
    perform expedition_media_private.reset_thumbnail(job.media_id, job.processing_version, job.attempt_id);
    requeued := requeued + 1;
  end loop;
  if scanned < p_limit then next_after := null; end if;
  return next;
end;
$function$;

create function public.expedition_thumbnail_set_version(p_expected integer, p_next integer)
returns boolean
language plpgsql volatile security invoker set search_path = '' as $function$
declare current_version smallint;
begin
  if p_expected is distinct from 1 or p_next is distinct from 2 then
    raise exception 'Unsupported thumbnail version transition' using errcode = '22023';
  end if;
  select s.target_version into strict current_version from expedition_media_private.thumbnail_settings s for update;
  if current_version = p_next then return true; end if;
  if current_version <> p_expected then return false; end if;
  update expedition_media_private.thumbnail_settings set target_version = p_next where singleton;
  return found;
end;
$function$;

create function public.expedition_thumbnail_rollout_version(p_expected_target integer, p_limit integer default 16)
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
    select t.* from expedition_media_private.thumbnails t where t.processing_version < current_version
    order by t.processing_version, t.media_id limit p_limit for update of t skip locked
  loop
    perform expedition_media_private.reset_thumbnail(job.media_id, current_version, job.attempt_id);
    changed := changed + 1;
  end loop;
  return changed;
end;
$function$;

create function public.expedition_thumbnail_claim(
  p_limit integer default 1, p_lease_seconds integer default 60,
  p_supported_version integer default 1, p_project_id uuid default null
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
  if not expedition_media_private.thumbnail_derivative_bucket_supported() then return; end if;
  for candidate in
    select t.media_id, m.project_id as queue_project from expedition_media_private.thumbnails t
    join public.expedition_project_journal_media m on m.id = t.media_id
    where t.processing_version = p_supported_version and (p_project_id is null or m.project_id = p_project_id)
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
    where t.media_id = candidate.media_id and t.processing_version = p_supported_version
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
      where t.media_id = job.media_id;
      continue;
    end if;

    attempt := gen_random_uuid();
    deadline := clock_timestamp() + make_interval(secs => p_lease_seconds);
    insert into expedition_media_private.thumbnail_cleanup as c (attempt_id, media_id, processing_version, available_at)
    values (attempt, job.media_id, job.processing_version, deadline + interval '2 minutes')
    returning c.object_key into key;
    update expedition_media_private.thumbnails t set state = 'processing', attempt_count = t.attempt_count + 1,
      attempt_id = attempt, lease_until = deadline, source_object_id = source_row.object_id,
      source_version = source_row.object_version, last_error = null
    where t.media_id = job.media_id;
    return query select job.media_id, source_row.project_id, attempt, job.processing_version, deadline,
      source_row.storage_path, source_row.mime_type, source_row.size_bytes, source_row.object_id, source_row.object_version, key;
    issued := issued + 1;
  end loop;
end;
$function$;

-- Recheck immediately before uploading, with a separate short upload deadline.
-- A network write still cannot be atomic with SQL. Cleanup tombstones cover late writes.
create function public.expedition_thumbnail_may_upload(p_media_id uuid, p_attempt_id uuid)
returns boolean
language sql volatile security invoker set search_path = '' as $function$
  select exists (
    select 1 from expedition_media_private.thumbnails t
    join expedition_media_private.thumbnail_cleanup c on c.attempt_id = t.attempt_id and c.state = 'pending'
    join expedition_media_private.thumbnail_source(p_media_id) s
      on s.object_id = t.source_object_id and s.object_version = t.source_version
    where t.media_id = p_media_id and t.attempt_id = p_attempt_id
      and t.state = 'processing' and t.lease_until > clock_timestamp()
      and expedition_media_private.thumbnail_derivative_bucket_supported()
      and expedition_media_private.thumbnail_cleanup_storage_state(c.object_key) in ('absent', 'current')
  );
$function$;

create function public.expedition_thumbnail_complete(
  p_media_id uuid, p_attempt_id uuid, p_source_id uuid, p_source_version text,
  p_derivative_id uuid, p_derivative_version text, p_width integer, p_height integer, p_size_bytes integer
)
returns boolean
language plpgsql volatile security invoker set search_path = '' as $function$
declare
  job expedition_media_private.thumbnails%rowtype;
begin
  if p_width is null or p_width not between 1 and 256 or p_height is null or p_height not between 1 and 256
    or p_size_bytes is null or p_size_bytes not between 1 and 65536
  then raise exception 'Invalid thumbnail output limits' using errcode = '22023'; end if;
  if p_derivative_id is null or p_derivative_version is null
    or not expedition_media_private.thumbnail_derivative_bucket_supported()
  then return false; end if;

  select t.* into job from expedition_media_private.thumbnails t
  where t.media_id = p_media_id and t.attempt_id = p_attempt_id for update of t;
  if not found then return false; end if;
  if job.source_object_id is distinct from p_source_id or job.source_version is distinct from p_source_version
    or not exists (
      select 1 from expedition_media_private.thumbnail_source(p_media_id) s
      where s.object_id = p_source_id and s.object_version = p_source_version
    )
  then return false; end if;

  -- A lost successful response may be retried as long as the publication is still current.
  if job.state = 'ready' then
    return job.derivative_object_id = p_derivative_id and job.derivative_version = p_derivative_version
      and job.width = p_width and job.height = p_height and job.size_bytes = p_size_bytes
      and exists (
        select 1 from expedition_media_private.thumbnail_source(p_media_id) s
        cross join lateral public.expedition_thumbnail_lookup(s.project_id, p_media_id) ready
      );
  end if;

  if job.state <> 'processing' or job.lease_until <= clock_timestamp() then return false; end if;
  update expedition_media_private.thumbnail_cleanup c set state = 'held'
  where c.attempt_id = p_attempt_id and c.state = 'pending' and job.lease_until > clock_timestamp()
    and exists (
      select from expedition_media_private.current_storage_object('expedition-media-thumbnails', c.object_key) o
      where o.id = p_derivative_id and o.version = p_derivative_version and btrim(o.version) <> ''
        and not o.is_versioned
        and o.metadata ->> 'size' = p_size_bytes::text and o.metadata ->> 'mimetype' = 'image/webp'
    );
  if not found then return false; end if;
  update expedition_media_private.thumbnails t set state = 'ready', lease_until = null,
    derivative_object_id = p_derivative_id, derivative_version = p_derivative_version,
    width = p_width, height = p_height, size_bytes = p_size_bytes
  where t.media_id = p_media_id;
  return true;
end;
$function$;

create function public.expedition_thumbnail_fail(p_media_id uuid, p_attempt_id uuid, p_error text, p_retry boolean)
returns boolean
language plpgsql volatile security invoker set search_path = '' as $function$
begin
  if p_error is null or p_error not in ('source_missing', 'source_unavailable', 'source_changed', 'invalid_source', 'storage', 'processing') or p_retry is null then
    raise exception 'Invalid thumbnail failure code' using errcode = '22023';
  end if;
  update expedition_media_private.thumbnails t set
    state = case when p_retry and t.attempt_count < 5 and p_error <> 'invalid_source' then 'pending' else 'failed' end,
    available_at = clock_timestamp() + make_interval(secs => 15 * (1 << t.attempt_count)),
    attempt_id = null, lease_until = null, source_object_id = null, source_version = null, last_error = p_error
  where t.media_id = p_media_id and t.attempt_id = p_attempt_id and t.state = 'processing' and t.lease_until > clock_timestamp();
  return found;
end;
$function$;

create function public.expedition_thumbnail_claim_cleanup(p_limit integer default 4, p_lease_seconds integer default 60)
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
  if not expedition_media_private.thumbnail_derivative_bucket_supported() then return; end if;
  for candidate in
    with due as materialized (
      select c.attempt_id, c.attempt_count, c.object_key, c.available_at as due_at
      from expedition_media_private.thumbnail_cleanup c where c.state = 'pending' and c.available_at <= cutoff
      order by c.available_at, c.attempt_id limit p_limit for update of c skip locked
    ), expired as materialized (
      select c.attempt_id, c.attempt_count, c.object_key, c.lease_until as due_at
      from expedition_media_private.thumbnail_cleanup c where c.state = 'processing' and c.lease_until <= cutoff
      order by c.lease_until, c.attempt_id limit p_limit for update of c skip locked
    )
    select * from due union all select * from expired order by due_at, attempt_id limit p_limit
  loop
    object_state := expedition_media_private.thumbnail_cleanup_storage_state(candidate.object_key);
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

-- Acknowledge only a matching cleanup lease and an empty exact Storage path.
-- Archived rows and markers require operator review, including after removal.
create function public.expedition_thumbnail_finish_cleanup(p_attempt_id uuid, p_lease_token uuid)
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
  object_state := case when expedition_media_private.thumbnail_derivative_bucket_supported()
    then expedition_media_private.thumbnail_cleanup_storage_state(job.object_key)
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

-- Keep tombstones. Reappearance is checked independently of the hot claim path.
create function public.expedition_thumbnail_reconcile_cleanup(p_after uuid default null, p_limit integer default 64)
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
  if not expedition_media_private.thumbnail_derivative_bucket_supported() then return next; return; end if;
  for candidate in
    select c.attempt_id, c.object_key from expedition_media_private.thumbnail_cleanup c
    where c.state = 'done' and c.attempt_id >= coalesce(p_after, '00000000-0000-0000-0000-000000000000'::uuid)
      and c.attempt_id is distinct from p_after
    order by c.attempt_id limit p_limit
  loop
    next_after := candidate.attempt_id;
    scanned := scanned + 1;
    object_state := expedition_media_private.thumbnail_cleanup_storage_state(candidate.object_key);
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

create function public.expedition_thumbnail_retry_cleanup(p_attempt_id uuid)
returns boolean
language plpgsql volatile security invoker set search_path = '' as $function$
begin
  update expedition_media_private.thumbnail_cleanup c set state = 'pending', available_at = clock_timestamp(),
    attempt_count = 0, last_error = null
  where c.attempt_id = p_attempt_id and c.state = 'failed';
  return found;
end;
$function$;

-- Only this trigger needs to bridge user-authorized media writes into server
-- tables. It is private, has no callable grant, and takes no caller arguments.
create function expedition_media_private.thumbnail_media_lifecycle()
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
      on conflict (media_id) do nothing;
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    -- Lock manifest before touching its reservation, matching completion order.
    select t.attempt_id into current_attempt from expedition_media_private.thumbnails t
    where t.media_id = old.id for update of t;
    update expedition_media_private.thumbnail_cleanup c set state = 'pending', available_at = clock_timestamp()
    where c.attempt_id = current_attempt and c.state = 'held';
    return old;
  end if;
  raise exception 'Unexpected thumbnail trigger operation';
end;
$function$;

revoke all on all functions in schema expedition_media_private from public, anon, authenticated, service_role;
grant execute on function expedition_media_private.thumbnail_source(uuid),
  expedition_media_private.inspect_thumbnail_source(uuid),
  expedition_media_private.current_storage_object(text, text),
  expedition_media_private.thumbnail_derivative_bucket_supported(),
  expedition_media_private.thumbnail_cleanup_storage_state(text),
  expedition_media_private.reset_thumbnail(uuid, smallint, uuid) to service_role;
revoke all on function
  public.expedition_thumbnail_lookup(uuid, uuid),
  public.expedition_thumbnail_enqueue(uuid, uuid, boolean),
  public.expedition_thumbnail_claim(integer, integer, integer, uuid),
  public.expedition_thumbnail_reconcile_ready(uuid, integer),
  public.expedition_thumbnail_set_version(integer, integer),
  public.expedition_thumbnail_rollout_version(integer, integer),
  public.expedition_thumbnail_may_upload(uuid, uuid),
  public.expedition_thumbnail_complete(uuid, uuid, uuid, text, uuid, text, integer, integer, integer),
  public.expedition_thumbnail_fail(uuid, uuid, text, boolean),
  public.expedition_thumbnail_claim_cleanup(integer, integer),
  public.expedition_thumbnail_finish_cleanup(uuid, uuid),
  public.expedition_thumbnail_reconcile_cleanup(uuid, integer),
  public.expedition_thumbnail_retry_cleanup(uuid)
from public, anon, authenticated, service_role;
grant execute on function
  public.expedition_thumbnail_lookup(uuid, uuid),
  public.expedition_thumbnail_enqueue(uuid, uuid, boolean),
  public.expedition_thumbnail_claim(integer, integer, integer, uuid),
  public.expedition_thumbnail_reconcile_ready(uuid, integer),
  public.expedition_thumbnail_set_version(integer, integer),
  public.expedition_thumbnail_rollout_version(integer, integer),
  public.expedition_thumbnail_may_upload(uuid, uuid),
  public.expedition_thumbnail_complete(uuid, uuid, uuid, text, uuid, text, integer, integer, integer),
  public.expedition_thumbnail_fail(uuid, uuid, text, boolean),
  public.expedition_thumbnail_claim_cleanup(integer, integer),
  public.expedition_thumbnail_finish_cleanup(uuid, uuid),
  public.expedition_thumbnail_reconcile_cleanup(uuid, integer),
  public.expedition_thumbnail_retry_cleanup(uuid)
to service_role;

create trigger expedition_thumbnail_enqueue_after_insert
after insert on public.expedition_project_journal_media
for each row execute function expedition_media_private.thumbnail_media_lifecycle();
create trigger expedition_thumbnail_cancel_before_delete
before delete on public.expedition_project_journal_media
for each row execute function expedition_media_private.thumbnail_media_lifecycle();

notify pgrst, 'reload schema';
commit;
