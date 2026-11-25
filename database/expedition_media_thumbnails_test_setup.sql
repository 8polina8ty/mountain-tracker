-- Disposable local PostgreSQL only. This bootstraps Storage/Auth catalogs for
-- the rollback-only regression. It must never be applied to a Supabase project.
begin;

do $guard$
begin
  if current_database() <> 'mountain_tracker_thumbnail_test' or current_user <> 'postgres'
    or (inet_server_addr() is not null and inet_server_addr() not in ('127.0.0.1'::inet, '::1'::inet))
    or to_regnamespace('auth') is not null or to_regnamespace('storage') is not null
  then raise exception 'Use a fresh, disposable local thumbnail test database'; end if;
end;
$guard$;

create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema thumbnail_contract_test;
create schema auth;
create schema storage;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable set search_path = '' as $uid$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$uid$;
create table public.mountains (id bigint primary key);
create table storage.buckets (
  id text primary key,
  name text not null,
  public boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  versioning_status text not null default 'DISABLED'
    constraint buckets_versioning_status_check check (versioning_status in ('DISABLED', 'ENABLED', 'SUSPENDED'))
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text,
  version text,
  metadata jsonb,
  archived_at timestamptz,
  is_delete_marker boolean not null default false,
  is_versioned boolean not null default false
);
create index idx_objects_bucket_id_name on storage.objects (bucket_id, name collate "C");
create index idx_objects_bucket_id_name_lower on storage.objects (bucket_id, lower(name) collate "C");
create unique index idx_objects_current_version on storage.objects (bucket_id, name collate "C") where archived_at is null;
create index idx_objects_delete_markers on storage.objects (bucket_id, name collate "C") where is_delete_marker;
create unique index idx_objects_null_version on storage.objects (bucket_id, name collate "C") where not is_versioned;
create index name_prefix_search on storage.objects (name text_pattern_ops);
create index objects_archived_due_idx on storage.objects (bucket_id, archived_at, name collate "C")
  include (id, version, is_delete_marker) where archived_at is not null;
create unique index objects_archived_order_uq on storage.objects (bucket_id, name collate "C", archived_at) where archived_at is not null;
create unique index objects_bucket_id_name_version_key on storage.objects (bucket_id, name collate "C", version) nulls not distinct;
alter table storage.buckets enable row level security;
alter table storage.objects enable row level security;
create function storage.foldername(path text) returns text[] language sql immutable set search_path = '' as $folder$
  select parts[1:cardinality(parts) - 1] from (select string_to_array(path, '/') parts) s;
$folder$;
create function storage.filename(path text) returns text language sql immutable set search_path = '' as $file$
  select parts[cardinality(parts)] from (select string_to_array(path, '/') parts) s;
$file$;
grant usage on schema auth, storage to anon, authenticated, service_role;
grant select, insert, update, delete on storage.objects, storage.buckets to anon, authenticated;
grant select on storage.objects, storage.buckets to service_role;
alter default privileges in schema public grant select on tables to service_role;

-- Test stand-in for API provisioning. There is no Storage service or blob.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('expedition-media-thumbnails', 'expedition-media-thumbnails', false, 65536, array['image/webp']);

commit;
