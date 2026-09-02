-- Phase 10B.1 exact QA-history repair plus future monotonic-version hardening.
-- REVIEW AND APPLY MANUALLY. This file is intentionally scoped to the one
-- proven inconsistent route and performs no staging or publication writes.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $$
declare
  v_rows integer;
begin
  perform 1
  from public.osm_route_import_staging route
  where route.id = '6d86c0c8-8e1b-45ee-8ec5-7053078d4824'::uuid
    and route.contract_version = 'mountain-tracker-osm-route/v1'
    and route.idempotency_key = 'openstreetmap:relation:11192622:mountain-tracker-osm-route/v1'
    and route.source_relation_id = '11192622'
    and route.canonical_source_id = '11192622'
    and route.payload_hash = '63519eb0533a94a940081d39b27d8dfdc19ece570d35916bab64afa7293d7aa5'
  for update;
  if not found then
    raise exception using errcode = '23514', message = 'PHASE10B1_STAGING_GUARD_FAILED';
  end if;

  perform 1
  from public.osm_staging_route_visual_qa qa
  where qa.staging_route_id = '6d86c0c8-8e1b-45ee-8ec5-7053078d4824'::uuid
    and qa.status = 'VISUALLY_APPROVED'
    and qa.reviewer_note is null
    and qa.reviewer_user_id = '23b17e48-4b08-48d3-bc09-f2f6da1311a2'::uuid
    and qa.reviewed_at = '2026-08-26T18:13:03.481854+00:00'::timestamptz
    and qa.version = 1
    and qa.created_at = '2026-08-26T18:13:03.481854+00:00'::timestamptz
    and qa.updated_at = '2026-08-26T18:13:03.481854+00:00'::timestamptz
  for update;
  if not found then
    raise exception using errcode = '23514', message = 'PHASE10B1_CURRENT_GUARD_FAILED';
  end if;

  if (
    select count(*)
    from public.osm_staging_route_visual_qa_history history
    where history.staging_route_id = '6d86c0c8-8e1b-45ee-8ec5-7053078d4824'::uuid
  ) <> 3 then
    raise exception using errcode = '23514', message = 'PHASE10B1_HISTORY_COUNT_GUARD_FAILED';
  end if;

  if not exists (
    select 1 from public.osm_staging_route_visual_qa_history history
    where history.id = 1
      and history.staging_route_id = '6d86c0c8-8e1b-45ee-8ec5-7053078d4824'::uuid
      and history.old_status = 'PENDING'
      and history.new_status = 'NEEDS_REVIEW'
      and history.reviewer_note = 'Phase 9B controlled write test — long 79.7 km route with 6 components.'
      and history.reviewer_user_id = '23b17e48-4b08-48d3-bc09-f2f6da1311a2'::uuid
      and history.decision_version = 1
      and history.occurred_at = '2026-08-25T21:08:12.943714+00:00'::timestamptz
  ) or not exists (
    select 1 from public.osm_staging_route_visual_qa_history history
    where history.id = 2
      and history.staging_route_id = '6d86c0c8-8e1b-45ee-8ec5-7053078d4824'::uuid
      and history.old_status = 'NEEDS_REVIEW'
      and history.new_status = 'PENDING'
      and history.reviewer_note = 'Phase 9B controlled write test — long 79.7 km route with 6 components.'
      and history.reviewer_user_id = '23b17e48-4b08-48d3-bc09-f2f6da1311a2'::uuid
      and history.decision_version = 2
      and history.occurred_at = '2026-08-25T21:11:14.73116+00:00'::timestamptz
  ) or not exists (
    select 1 from public.osm_staging_route_visual_qa_history history
    where history.id = 5
      and history.staging_route_id = '6d86c0c8-8e1b-45ee-8ec5-7053078d4824'::uuid
      and history.old_status = 'PENDING'
      and history.new_status = 'VISUALLY_APPROVED'
      and history.reviewer_note is null
      and history.reviewer_user_id = '23b17e48-4b08-48d3-bc09-f2f6da1311a2'::uuid
      and history.decision_version = 1
      and history.occurred_at = '2026-08-26T18:13:03.481854+00:00'::timestamptz
  ) then
    raise exception using errcode = '23514', message = 'PHASE10B1_HISTORY_VALUES_GUARD_FAILED';
  end if;

  update public.osm_staging_route_visual_qa_history history
  set decision_version = 3
  where history.id = 5
    and history.staging_route_id = '6d86c0c8-8e1b-45ee-8ec5-7053078d4824'::uuid
    and history.old_status = 'PENDING'
    and history.new_status = 'VISUALLY_APPROVED'
    and history.reviewer_note is null
    and history.reviewer_user_id = '23b17e48-4b08-48d3-bc09-f2f6da1311a2'::uuid
    and history.decision_version = 1
    and history.occurred_at = '2026-08-26T18:13:03.481854+00:00'::timestamptz;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception using errcode = '23514', message = 'PHASE10B1_HISTORY_REPAIR_FAILED';
  end if;

  update public.osm_staging_route_visual_qa qa
  set version = 3
  where qa.staging_route_id = '6d86c0c8-8e1b-45ee-8ec5-7053078d4824'::uuid
    and qa.status = 'VISUALLY_APPROVED'
    and qa.reviewer_note is null
    and qa.reviewer_user_id = '23b17e48-4b08-48d3-bc09-f2f6da1311a2'::uuid
    and qa.reviewed_at = '2026-08-26T18:13:03.481854+00:00'::timestamptz
    and qa.version = 1
    and qa.created_at = '2026-08-26T18:13:03.481854+00:00'::timestamptz
    and qa.updated_at = '2026-08-26T18:13:03.481854+00:00'::timestamptz;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception using errcode = '23514', message = 'PHASE10B1_CURRENT_REPAIR_FAILED';
  end if;
end;
$$;

create unique index osm_staging_route_visual_qa_history_route_version_key
  on public.osm_staging_route_visual_qa_history (staging_route_id, decision_version);

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

  v_next_version := v_latest_history_version + 1;
  if not v_has_current then
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

do $$
begin
  if not exists (
    select 1 from public.osm_staging_route_visual_qa_history history
    where history.id = 5
      and history.staging_route_id = '6d86c0c8-8e1b-45ee-8ec5-7053078d4824'::uuid
      and history.decision_version = 3
  ) or not exists (
    select 1 from public.osm_staging_route_visual_qa qa
    where qa.staging_route_id = '6d86c0c8-8e1b-45ee-8ec5-7053078d4824'::uuid
      and qa.version = 3
  ) then
    raise exception using errcode = '23514', message = 'PHASE10B1_POST_REPAIR_ASSERTION_FAILED';
  end if;
end;
$$;

commit;
