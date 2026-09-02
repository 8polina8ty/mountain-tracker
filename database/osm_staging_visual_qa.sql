-- Phase 9B visual-QA decisions and immutable audit history.
-- REVIEW AND APPLY MANUALLY. This artifact never publishes routes and never
-- changes immutable Phase 8 staging evidence.

begin;

create table public.osm_staging_route_visual_qa (
  staging_route_id uuid primary key
    references public.osm_route_import_staging(id) on delete cascade,
  status text not null
    check (status in ('PENDING', 'VISUALLY_APPROVED', 'NEEDS_REVIEW', 'REJECTED')),
  check (status <> 'PENDING'), -- absence is the canonical PENDING representation
  reviewer_note text
    check (reviewer_note is null or char_length(reviewer_note) between 1 and 1000),
  reviewed_at timestamptz not null,
  reviewer_user_id uuid not null references auth.users(id) on delete restrict,
  version bigint not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.osm_staging_route_visual_qa_history (
  id bigint generated always as identity primary key,
  staging_route_id uuid not null
    references public.osm_route_import_staging(id) on delete restrict,
  old_status text not null
    check (old_status in ('PENDING', 'VISUALLY_APPROVED', 'NEEDS_REVIEW', 'REJECTED')),
  new_status text not null
    check (new_status in ('PENDING', 'VISUALLY_APPROVED', 'NEEDS_REVIEW', 'REJECTED')),
  reviewer_note text
    check (reviewer_note is null or char_length(reviewer_note) between 1 and 1000),
  reviewer_user_id uuid not null references auth.users(id) on delete restrict,
  decision_version bigint not null check (decision_version > 0),
  occurred_at timestamptz not null default now(),
  constraint osm_staging_route_visual_qa_history_route_version_key
    unique (staging_route_id, decision_version)
);

create index osm_staging_route_visual_qa_history_route_time_idx
  on public.osm_staging_route_visual_qa_history (staging_route_id, occurred_at, id);

alter table public.osm_staging_route_visual_qa enable row level security;
alter table public.osm_staging_route_visual_qa_history enable row level security;

revoke all on public.osm_staging_route_visual_qa from public, anon, authenticated;
revoke all on public.osm_staging_route_visual_qa_history from public, anon, authenticated;
grant select on public.osm_staging_route_visual_qa to service_role;
grant select on public.osm_staging_route_visual_qa_history to service_role;

create or replace function public.record_osm_staging_visual_qa_decision(
  p_staging_route_id uuid,
  p_status text,
  p_reviewer_note text,
  p_reviewer_user_id uuid,
  p_expected_version bigint,
  p_expected_contract_version text,
  p_expected_idempotency_key text,
  p_expected_payload_hash text,
  p_expected_source_relation_id text,
  p_expected_canonical_source_id text,
  p_expected_peak_osm_id text,
  p_expected_mountain_id bigint,
  p_expected_summit_count integer
)
returns table (
  status text,
  reviewer_note text,
  reviewed_at timestamptz,
  version bigint,
  changed boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_route public.osm_route_import_staging%rowtype;
  v_current public.osm_staging_route_visual_qa%rowtype;
  v_has_current boolean;
  v_summit_count integer;
  v_now timestamptz := clock_timestamp();
  v_note text := nullif(btrim(p_reviewer_note), '');
  v_latest_history_version bigint;
  v_next_version bigint;
begin
  if p_status not in ('PENDING', 'VISUALLY_APPROVED', 'NEEDS_REVIEW', 'REJECTED') then
    raise exception using errcode = '22023', message = 'INVALID_QA_STATUS';
  end if;
  if p_reviewer_user_id is null then
    raise exception using errcode = '22023', message = 'REVIEWER_REQUIRED';
  end if;
  if v_note is not null and char_length(v_note) > 1000 then
    raise exception using errcode = '22023', message = 'QA_NOTE_TOO_LONG';
  end if;

  -- Locking the parent row serializes first decisions where no QA row exists.
  select * into v_route
  from public.osm_route_import_staging
  where id = p_staging_route_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'STAGING_ROUTE_NOT_FOUND';
  end if;
  if v_route.contract_version <> p_expected_contract_version
    or v_route.idempotency_key <> p_expected_idempotency_key
    or v_route.payload_hash <> p_expected_payload_hash
    or v_route.source_relation_id <> p_expected_source_relation_id
    or v_route.canonical_source_id <> p_expected_canonical_source_id
    or v_route.import_eligibility <> 'AUTO_IMPORT_READY'
  then
    raise exception using errcode = '23514', message = 'STAGING_ROUTE_REVALIDATION_FAILED';
  end if;

  select count(*) into v_summit_count
  from public.osm_route_import_summit_staging summit
  where summit.staging_route_id = p_staging_route_id
    and summit.peak_osm_id = p_expected_peak_osm_id
    and summit.mountain_id = p_expected_mountain_id
    and summit.final_association = 'CONFIRMED'
    and summit.mountain_match_classification = 'EXACT_MOUNTAIN_MATCH';

  if v_summit_count <> p_expected_summit_count
    or v_summit_count <> (
      select count(*)::integer
      from public.osm_route_import_summit_staging all_summits
      where all_summits.staging_route_id = p_staging_route_id
    )
  then
    raise exception using errcode = '23514', message = 'STAGING_SUMMIT_REVALIDATION_FAILED';
  end if;

  select * into v_current
  from public.osm_staging_route_visual_qa qa
  where qa.staging_route_id = p_staging_route_id
  for update;
  v_has_current := found;

  -- The locked staging parent serializes every RPC call for this route, including
  -- decisions made while PENDING is represented by an absent current-state row.
  select coalesce(max(history.decision_version), 0)::bigint
  into v_latest_history_version
  from public.osm_staging_route_visual_qa_history history
  where history.staging_route_id = p_staging_route_id;

  if (not v_has_current and p_expected_version is not null)
    or (v_has_current and p_expected_version is distinct from v_current.version)
  then
    raise exception using errcode = '40001', message = 'QA_DECISION_CONFLICT';
  end if;
  if v_has_current and v_current.version <> v_latest_history_version then
    raise exception using errcode = '23514', message = 'QA_HISTORY_CURRENT_VERSION_MISMATCH';
  end if;

  if p_status = 'PENDING' then
    if not v_has_current then
      return query select 'PENDING'::text, null::text, null::timestamptz, null::bigint, false;
      return;
    end if;
    v_next_version := v_latest_history_version + 1;
    delete from public.osm_staging_route_visual_qa qa
    where qa.staging_route_id = p_staging_route_id;
    insert into public.osm_staging_route_visual_qa_history (
      staging_route_id, old_status, new_status, reviewer_note,
      reviewer_user_id, decision_version, occurred_at
    ) values (
      p_staging_route_id, v_current.status, 'PENDING', v_note,
      p_reviewer_user_id, v_next_version, v_now
    );
    return query select 'PENDING'::text, null::text, null::timestamptz, null::bigint, true;
    return;
  end if;

  if not v_has_current then
    v_next_version := v_latest_history_version + 1;
    insert into public.osm_staging_route_visual_qa (
      staging_route_id, status, reviewer_note, reviewed_at,
      reviewer_user_id, version, created_at, updated_at
    ) values (
      p_staging_route_id, p_status, v_note, v_now,
      p_reviewer_user_id, v_next_version, v_now, v_now
    );
    insert into public.osm_staging_route_visual_qa_history (
      staging_route_id, old_status, new_status, reviewer_note,
      reviewer_user_id, decision_version, occurred_at
    ) values (
      p_staging_route_id, 'PENDING', p_status, v_note,
      p_reviewer_user_id, v_next_version, v_now
    );
  else
    v_next_version := v_latest_history_version + 1;
    update public.osm_staging_route_visual_qa qa set
      status = p_status,
      reviewer_note = v_note,
      reviewed_at = v_now,
      reviewer_user_id = p_reviewer_user_id,
      version = v_next_version,
      updated_at = v_now
    where qa.staging_route_id = p_staging_route_id;
    insert into public.osm_staging_route_visual_qa_history (
      staging_route_id, old_status, new_status, reviewer_note,
      reviewer_user_id, decision_version, occurred_at
    ) values (
      p_staging_route_id, v_current.status, p_status, v_note,
      p_reviewer_user_id, v_next_version, v_now
    );
  end if;

  return query select p_status, v_note, v_now, v_next_version, true;
end;
$$;

revoke all on function public.record_osm_staging_visual_qa_decision(
  uuid, text, text, uuid, bigint, text, text, text, text, text, text, bigint, integer
) from public, anon, authenticated, service_role;
grant execute on function public.record_osm_staging_visual_qa_decision(
  uuid, text, text, uuid, bigint, text, text, text, text, text, text, bigint, integer
) to service_role;

comment on table public.osm_staging_route_visual_qa is
  'Current non-PENDING Phase 9B decisions; an absent row means PENDING and never authorizes publication.';
comment on table public.osm_staging_route_visual_qa_history is
  'Immutable Phase 9B QA transition history; writes are restricted to the decision RPC.';
comment on function public.record_osm_staging_visual_qa_decision(
  uuid, text, text, uuid, bigint, text, text, text, text, text, text, bigint, integer
) is
  'Atomically revalidates one reviewed staging record and records QA state/history. Never publishes routes.';

commit;
