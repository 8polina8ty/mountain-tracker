-- Read-only snapshot for before deployment, after deployment, and after rollback.
-- The JSON fields "baseline" and "thumbnails" are compared independently.
begin read only;
set local statement_timeout = '15s';
set local search_path = pg_catalog, public;

with roles as (
  select oid, rolname, rolsuper, rolbypassrls from pg_roles
  where rolname in ('anon', 'authenticated', 'service_role')
), relations as (
  select c.oid, n.nspname, c.relname, c.relrowsecurity, c.relforcerowsecurity, c.relacl
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where (n.nspname, c.relname) in (
    ('auth', 'users'), ('storage', 'buckets'), ('storage', 'objects'),
    ('public', 'expedition_projects'), ('public', 'expedition_project_days'),
    ('public', 'expedition_project_journal_entries'), ('public', 'expedition_project_journal_media'),
    ('public', 'expedition_project_members'), ('public', 'expedition_project_shares')
  )
), policies as (
  select p.* from pg_policies p
  join relations r on (r.nspname, r.relname) = (p.schemaname, p.tablename)
), routines as (
  select p.oid as routine_oid, n.nspname as schema_name, p.proname as routine_name,
    pg_get_function_identity_arguments(p.oid) as identity_arguments,
    pg_get_userbyid(p.proowner) as owner, p.prosecdef as security_definer,
    p.proconfig as settings, md5(pg_get_functiondef(p.oid)) as definition_fingerprint,
    exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
            where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_execute,
    has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
    has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute,
    has_function_privilege('service_role', p.oid, 'EXECUTE') as service_execute
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where p.prokind = 'f' and (
    n.nspname = 'expedition_media_private' or (n.nspname = 'public' and (
      p.proname like 'expedition_thumbnail_%' or p.proname in (
        'resolve_public_expedition_share', 'get_public_expedition_report'
      )
    ))
  )
), media_grants as (
  select r.rolname, p.privilege,
    has_table_privilege(r.oid, m.oid, p.privilege) as table_grant,
    array(select a.attname from pg_attribute a where a.attrelid = m.oid
      and a.attnum > 0 and not a.attisdropped
      and has_column_privilege(r.oid, m.oid, a.attnum, p.privilege) order by a.attname) as columns
  from roles r cross join relations m cross join
    (values ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) p(privilege)
  where m.nspname = 'public' and m.relname = 'expedition_project_journal_media'
  union all
  select r.rolname, p.privilege, has_table_privilege(r.oid, m.oid, p.privilege), null::name[]
  from roles r cross join relations m cross join
    (values ('DELETE'), ('TRUNCATE'), ('TRIGGER'), ('MAINTAIN')) p(privilege)
  where m.nspname = 'public' and m.relname = 'expedition_project_journal_media'
), triggers as (
  select r.nspname, r.relname, t.tgname, t.tgenabled, pg_get_triggerdef(t.oid) as definition
  from pg_trigger t join relations r on r.oid = t.tgrelid where not t.tgisinternal
), thumbnail_policies as (
  select p.* from policies p where p.schemaname = 'storage'
    and (p.policyname ilike '%thumbnail%' or coalesce(p.qual, '') like '%expedition-media-thumbnails%'
      or coalesce(p.with_check, '') like '%expedition-media-thumbnails%')
), extension_state as (
  select wanted.name, a.default_version, a.installed_version
  from (values ('pg_cron'), ('pg_net'), ('pgmq'), ('supabase_vault')) wanted(name)
  left join pg_available_extensions a using (name)
)
select jsonb_build_object(
  'baseline', jsonb_build_object(
    'relations', coalesce((select jsonb_agg(to_jsonb(r) - 'oid' order by r.nspname, r.relname) from relations r), '[]'),
    'constraints', coalesce((select jsonb_agg(jsonb_build_array(r.nspname, r.relname, c.conname,
      c.convalidated, pg_get_constraintdef(c.oid)) order by r.nspname, r.relname, c.conname)
      from pg_constraint c join relations r on r.oid = c.conrelid), '[]'),
    'storage_object_columns', coalesce((select jsonb_agg(jsonb_build_array(a.attname,
      format_type(a.atttypid, a.atttypmod), a.attnotnull) order by a.attname)
      from pg_attribute a where a.attrelid = 'storage.objects'::regclass and a.attname in (
        'id', 'version', 'metadata', 'bucket_id', 'name', 'archived_at', 'is_delete_marker', 'is_versioned'
      )), '[]'),
    'storage_object_indexes', coalesce((select jsonb_agg(jsonb_build_array(i.indexrelid::regclass::text,
      i.indisunique, i.indisvalid, pg_get_indexdef(i.indexrelid)) order by i.indexrelid::regclass::text)
      from pg_index i where i.indrelid = 'storage.objects'::regclass), '[]'),
    'policies', coalesce((select jsonb_agg((to_jsonb(p) - 'qual' - 'with_check') ||
      jsonb_build_object('using_fingerprint', md5(p.qual), 'check_fingerprint', md5(p.with_check))
      order by p.schemaname, p.tablename, p.policyname)
      from policies p where not exists (select 1 from thumbnail_policies tp
        where (tp.schemaname, tp.tablename, tp.policyname) = (p.schemaname, p.tablename, p.policyname))), '[]'),
    'triggers', coalesce((select jsonb_agg((to_jsonb(t) - 'definition') ||
      jsonb_build_object('definition_fingerprint', md5(t.definition)) order by t.nspname, t.relname, t.tgname)
      from triggers t where t.tgname not ilike '%thumbnail%'), '[]'),
    'media_grants', coalesce((select jsonb_agg(to_jsonb(g) order by g.rolname, g.privilege) from media_grants g), '[]'),
    'service_catalog_select', coalesce((select jsonb_agg(jsonb_build_array(r.nspname, r.relname,
      has_schema_privilege('service_role', r.nspname, 'USAGE'),
      has_table_privilege('service_role', r.oid, 'SELECT')) order by r.nspname, r.relname)
      from relations r where r.relname in ('objects', 'buckets', 'expedition_project_journal_media')), '[]'),
    'api_role_flags', coalesce((select jsonb_agg(jsonb_build_array(r.rolname, r.rolsuper, r.rolbypassrls,
      pg_has_role(r.oid, 'service_role', 'MEMBER')) order by r.rolname) from roles r), '[]'),
    'sharing_resolvers', coalesce((select jsonb_agg(to_jsonb(f) - 'routine_oid' order by f.routine_name, f.identity_arguments)
      from routines f where f.routine_name in ('resolve_public_expedition_share', 'get_public_expedition_report')), '[]'),
    'original_bucket', (select jsonb_build_array(id, name, public, allowed_mime_types, file_size_limit,
      to_jsonb(b)->'versioning_status') from storage.buckets b where id = 'expedition-media'),
    'extensions', (select jsonb_agg(to_jsonb(e) order by e.name) from extension_state e)
  ),
  'thumbnails', jsonb_build_object(
    'schema', (select jsonb_build_array(n.nspname, pg_get_userbyid(n.nspowner), n.nspacl,
      has_schema_privilege('anon', n.oid, 'USAGE'), has_schema_privilege('authenticated', n.oid, 'USAGE'),
      has_schema_privilege('service_role', n.oid, 'USAGE'))
      from pg_namespace n where n.nspname = 'expedition_media_private'),
    'tables', coalesce((select jsonb_agg(jsonb_build_object(
      'name', c.relname, 'rls', c.relrowsecurity, 'acl', c.relacl,
      'column_acl', (select jsonb_object_agg(a.attname, a.attacl) from pg_attribute a
        where a.attrelid = c.oid and a.attnum > 0 and a.attacl is not null),
      'policies', (select count(*) from pg_policy p where p.polrelid = c.oid),
      'constraints', (select jsonb_agg(jsonb_build_array(x.conname, x.convalidated, pg_get_constraintdef(x.oid)) order by x.conname)
        from pg_constraint x where x.conrelid = c.oid),
      'indexes', (select jsonb_agg(jsonb_build_array(i.indexrelid::regclass::text,
        i.indisvalid, pg_get_indexdef(i.indexrelid)) order by i.indexrelid::regclass::text)
        from pg_index i where i.indrelid = c.oid)
      ) order by c.relname) from pg_class c
      where c.relnamespace = to_regnamespace('expedition_media_private') and c.relkind = 'r'), '[]'),
    'routines', coalesce((select jsonb_agg(to_jsonb(f) - 'routine_oid'
      order by f.schema_name, f.routine_name, f.identity_arguments) from routines f
      where f.routine_name not in ('resolve_public_expedition_share', 'get_public_expedition_report')), '[]'),
    'triggers', coalesce((select jsonb_agg(to_jsonb(t) order by t.nspname, t.relname, t.tgname)
      from triggers t where t.tgname ilike '%thumbnail%'), '[]'),
    'policies', coalesce((select jsonb_agg(to_jsonb(p) order by p.tablename, p.policyname) from thumbnail_policies p), '[]'),
    'bucket', (select jsonb_build_array(id, name, public, allowed_mime_types, file_size_limit,
      to_jsonb(b)->'versioning_status') from storage.buckets b where id = 'expedition-media-thumbnails')
  )
) as snapshot;

rollback;
