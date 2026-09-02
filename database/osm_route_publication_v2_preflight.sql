-- Phase 11C-CAT production schema diagnostic.
-- READ ONLY. Run manually before reviewing osm_route_publication_v2.sql again.

select
  columns.column_name,
  columns.data_type,
  columns.is_nullable,
  columns.column_default
from information_schema.columns columns
where columns.table_schema = 'public'
  and columns.table_name = 'mountain_routes'
  and columns.column_name = 'route_type';

select
  constraints.conname as constraint_name,
  constraints.contype as constraint_type,
  pg_catalog.pg_get_constraintdef(constraints.oid, true) as constraint_definition
from pg_catalog.pg_constraint constraints
inner join pg_catalog.pg_class tables on tables.oid = constraints.conrelid
inner join pg_catalog.pg_namespace schemas on schemas.oid = tables.relnamespace
where schemas.nspname = 'public'
  and tables.relname = 'mountain_routes'
  and pg_catalog.pg_get_constraintdef(constraints.oid, true) ilike '%route_type%'
order by constraints.conname;

select
  constraints.conname as constraint_name,
  pg_catalog.pg_get_constraintdef(constraints.oid, true) as constraint_definition
from pg_catalog.pg_constraint constraints
inner join pg_catalog.pg_class tables on tables.oid = constraints.conrelid
inner join pg_catalog.pg_namespace schemas on schemas.oid = tables.relnamespace
where schemas.nspname = 'public'
  and tables.relname = 'osm_route_publication_provenance'
order by constraints.conname;

select
  routines.oid::regprocedure::text as routine_identity,
  encode(extensions.digest(
    convert_to(pg_catalog.pg_get_functiondef(routines.oid), 'UTF8'),
    'sha256'
  ), 'hex') as definition_sha256
from pg_catalog.pg_proc routines
inner join pg_catalog.pg_namespace schemas on schemas.oid = routines.pronamespace
where schemas.nspname = 'public'
  and routines.proname = 'publish_approved_osm_route'
order by routines.oid::regprocedure::text;

select id, source_url, route_type
from public.mountain_routes
where id between 2 and 7
order by id;

select
  mountain_route_id,
  canonical_relation_id,
  publication_contract_version,
  publication_status,
  publication_idempotency_key,
  staging_payload_hash,
  candidate_content_hash,
  candidate_manifest_hash,
  geometry_hash,
  qa_history_hash,
  target_payload_hash
from public.osm_route_publication_provenance
where mountain_route_id between 2 and 7
order by mountain_route_id;
