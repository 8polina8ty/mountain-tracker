-- Phase 10B.1 exact data rollback for relation 11192622.
-- REVIEW AND APPLY MANUALLY only to undo the reviewed version repair.
-- The corrected RPC is deliberately retained; after this rollback it will fail
-- closed on this route until the repair is applied again.

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
    and route.source_relation_id = '11192622'
    and route.payload_hash = '63519eb0533a94a940081d39b27d8dfdc19ece570d35916bab64afa7293d7aa5'
  for update;
  if not found then
    raise exception using errcode = '23514', message = 'PHASE10B1_ROLLBACK_STAGING_GUARD_FAILED';
  end if;

  if (
    select count(*) from public.osm_staging_route_visual_qa_history history
    where history.staging_route_id = '6d86c0c8-8e1b-45ee-8ec5-7053078d4824'::uuid
  ) <> 3 then
    raise exception using errcode = '23514', message = 'PHASE10B1_ROLLBACK_HISTORY_COUNT_GUARD_FAILED';
  end if;

  update public.osm_staging_route_visual_qa qa
  set version = 1
  where qa.staging_route_id = '6d86c0c8-8e1b-45ee-8ec5-7053078d4824'::uuid
    and qa.status = 'VISUALLY_APPROVED'
    and qa.reviewer_note is null
    and qa.reviewer_user_id = '23b17e48-4b08-48d3-bc09-f2f6da1311a2'::uuid
    and qa.reviewed_at = '2026-08-26T18:13:03.481854+00:00'::timestamptz
    and qa.version = 3
    and qa.created_at = '2026-08-26T18:13:03.481854+00:00'::timestamptz
    and qa.updated_at = '2026-08-26T18:13:03.481854+00:00'::timestamptz;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception using errcode = '23514', message = 'PHASE10B1_ROLLBACK_CURRENT_FAILED';
  end if;

  drop index if exists public.osm_staging_route_visual_qa_history_route_version_key;

  update public.osm_staging_route_visual_qa_history history
  set decision_version = 1
  where history.id = 5
    and history.staging_route_id = '6d86c0c8-8e1b-45ee-8ec5-7053078d4824'::uuid
    and history.old_status = 'PENDING'
    and history.new_status = 'VISUALLY_APPROVED'
    and history.reviewer_note is null
    and history.reviewer_user_id = '23b17e48-4b08-48d3-bc09-f2f6da1311a2'::uuid
    and history.decision_version = 3
    and history.occurred_at = '2026-08-26T18:13:03.481854+00:00'::timestamptz;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception using errcode = '23514', message = 'PHASE10B1_ROLLBACK_HISTORY_FAILED';
  end if;
end;
$$;

commit;
