-- Phase 12A append-oriented quality/safety decision evidence.
-- REVIEWED MANUAL-DEPLOYMENT ARTIFACT. DO NOT EXECUTE AUTOMATICALLY.
-- Depends on gpx_import_runs.sql, gpx_source_tracks.sql, and
-- gpx_route_clusters.sql. Creates no QA decisions and publishes nothing.

begin;

create table public.gpx_import_qa (
  id uuid primary key default gen_random_uuid(),
  import_run_id uuid references public.gpx_import_runs(id) on delete restrict,
  track_id uuid references public.gpx_source_tracks(id) on delete restrict,
  cluster_id uuid references public.gpx_route_clusters(id) on delete restrict,
  gate_code text not null check (gate_code in (
    'INVALID_GEOMETRY','POINT_LIMIT_EXCEEDED','TELEPORT_JUMP','TINY_TRACK',
    'EXTREME_LENGTH','CORRUPT_ELEVATION','SUMMIT_MISS','AMBIGUOUS_SUMMIT',
    'HIGH_MOUNTAIN_START','ROAD_OR_MOTORWAY_RISK','DUPLICATE_ROUTE',
    'NON_HIKING_ACTIVITY','PRIVACY_REVIEW_REQUIRED','HUMAN_ROUTE_REVIEW'
  )),
  decision_status text not null
    check (decision_status in ('PASSED','REVIEW_REQUIRED','REJECTED','OVERRIDDEN')),
  decision_origin text not null check (decision_origin in ('AUTOMATED','HUMAN')),
  decision_version text not null check (char_length(decision_version) between 1 and 100),
  evidence jsonb not null check (jsonb_typeof(evidence) = 'object'),
  evidence_hash text not null check (evidence_hash ~ '^[0-9a-f]{64}$'),
  reviewer_user_id uuid references auth.users(id) on delete set null,
  reviewer_note text check (reviewer_note is null or char_length(reviewer_note) <= 4000),
  decided_at timestamptz not null default clock_timestamp(),
  check (num_nonnulls(import_run_id, track_id, cluster_id) = 1),
  check (decision_origin <> 'HUMAN' or reviewer_user_id is not null)
);

create index gpx_import_qa_track_history_idx
  on public.gpx_import_qa (track_id, decided_at desc) where track_id is not null;
create index gpx_import_qa_cluster_history_idx
  on public.gpx_import_qa (cluster_id, decided_at desc) where cluster_id is not null;
create index gpx_import_qa_review_queue_idx
  on public.gpx_import_qa (decision_status, decided_at)
  where decision_status = 'REVIEW_REQUIRED';

alter table public.gpx_import_qa enable row level security;
revoke all on public.gpx_import_qa from public, anon, authenticated;
grant select, insert on public.gpx_import_qa to service_role;

comment on table public.gpx_import_qa is
  'Service-only immutable decision history for Phase 12 quality, safety, '
  'privacy, and human calibration gates.';

commit;

