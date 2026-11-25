-- Phase 12A external GPX-to-mountain matching evidence.
-- REVIEWED MANUAL-DEPLOYMENT ARTIFACT. DO NOT EXECUTE AUTOMATICALLY.
-- Depends on gpx_source_tracks.sql. A track may have zero, one, multiple, or
-- ambiguous associations; no summit match is ever forced.

begin;

create table public.gpx_track_mountain_associations (
  id uuid primary key default gen_random_uuid(),
  track_id uuid not null references public.gpx_source_tracks(id) on delete cascade,
  mountain_id bigint not null references public.mountains(id) on delete restrict,
  match_classification text not null
    check (match_classification in ('DIRECT','POSSIBLE','REJECTED')),
  minimum_geometry_distance_m double precision not null
    check (minimum_geometry_distance_m >= 0),
  endpoint_distance_m double precision check (endpoint_distance_m is null or endpoint_distance_m >= 0),
  confidence numeric(5,4) not null check (confidence between 0 and 1),
  is_primary boolean not null default false,
  matcher_version text not null check (char_length(matcher_version) between 1 and 100),
  evidence jsonb not null check (jsonb_typeof(evidence) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  unique (track_id, mountain_id),
  check (not is_primary or match_classification = 'DIRECT')
);

create unique index gpx_track_mountain_primary_unique
  on public.gpx_track_mountain_associations (track_id)
  where is_primary;
create index gpx_track_mountain_lookup_idx
  on public.gpx_track_mountain_associations
  (mountain_id, match_classification, confidence desc);

alter table public.gpx_track_mountain_associations enable row level security;
revoke all on public.gpx_track_mountain_associations from public, anon, authenticated;
grant select, insert, update, delete on public.gpx_track_mountain_associations to service_role;

comment on table public.gpx_track_mountain_associations is
  'Service-only, versioned multi-summit matching evidence. Ambiguous/no-summit '
  'outcomes remain explicit on gpx_source_tracks.';

commit;

