-- Phase 12A resumable external GPX import-run contract.
-- REVIEWED MANUAL-DEPLOYMENT ARTIFACT. DO NOT EXECUTE AUTOMATICALLY.
-- Depends on database/gpx_source_registry.sql and creates no data rows.

begin;

create table public.gpx_import_runs (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.gpx_source_registry(id) on delete restrict,
  source_snapshot_key text not null check (char_length(source_snapshot_key) between 1 and 200),
  dataset_fingerprint text not null check (dataset_fingerprint ~ '^[0-9a-f]{64}$'),
  adapter_version text not null check (char_length(adapter_version) between 1 and 100),
  run_idempotency_key text not null unique check (run_idempotency_key ~ '^[0-9a-f]{64}$'),
  run_state text not null default 'PLANNED'
    check (run_state in ('PLANNED','RUNNING','PAUSED','COMPLETED','FAILED','CANCELLED')),
  manifest jsonb not null check (jsonb_typeof(manifest) = 'object'),
  manifest_hash text not null check (manifest_hash ~ '^[0-9a-f]{64}$'),
  source_cursor jsonb check (source_cursor is null or jsonb_typeof(source_cursor) = 'object'),
  stage_counts jsonb not null default '{}'::jsonb check (jsonb_typeof(stage_counts) = 'object'),
  retry_state jsonb not null default '{}'::jsonb check (jsonb_typeof(retry_state) = 'object'),
  last_checkpoint_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  failure_code text check (failure_code is null or char_length(failure_code) <= 100),
  failure_detail text check (failure_detail is null or char_length(failure_detail) <= 4000),
  operator_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (source_id, source_snapshot_key)
);

create index gpx_import_runs_resume_idx
  on public.gpx_import_runs (run_state, last_checkpoint_at)
  where run_state in ('PLANNED','RUNNING','PAUSED','FAILED');

alter table public.gpx_import_runs enable row level security;
revoke all on public.gpx_import_runs from public, anon, authenticated;
grant select, insert, update on public.gpx_import_runs to service_role;

comment on table public.gpx_import_runs is
  'Service-only run manifests, cursors, counters, retry state, and durable '
  'checkpoints for idempotent Phase 12 ingestion.';

commit;

