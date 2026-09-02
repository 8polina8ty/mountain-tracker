-- Phase 10B.1 read-only post-repair verification for relation 11192622.

select
  qa.staging_route_id,
  qa.status,
  qa.reviewer_note,
  qa.reviewer_user_id,
  qa.reviewed_at,
  qa.version
from public.osm_staging_route_visual_qa qa
where qa.staging_route_id = '6d86c0c8-8e1b-45ee-8ec5-7053078d4824'::uuid;

select
  history.id,
  history.old_status,
  history.new_status,
  history.decision_version,
  history.reviewer_user_id,
  history.reviewer_note,
  history.occurred_at
from public.osm_staging_route_visual_qa_history history
where history.staging_route_id = '6d86c0c8-8e1b-45ee-8ec5-7053078d4824'::uuid
order by history.occurred_at asc, history.id asc;

with ordered as (
  select
    history.*,
    row_number() over (
      partition by history.staging_route_id
      order by history.occurred_at asc, history.id asc
    ) as expected_version,
    lag(history.new_status, 1, 'PENDING') over (
      partition by history.staging_route_id
      order by history.occurred_at asc, history.id asc
    ) as expected_old_status
  from public.osm_staging_route_visual_qa_history history
  where history.staging_route_id = '6d86c0c8-8e1b-45ee-8ec5-7053078d4824'::uuid
)
select
  count(*) as history_event_count,
  count(*) filter (where decision_version <> expected_version) as version_problem_count,
  count(*) filter (where old_status <> expected_old_status) as transition_problem_count,
  array_agg(decision_version order by occurred_at asc, id asc) as actual_version_sequence
from ordered;

select
  indexname,
  indexdef
from pg_indexes
where schemaname = 'public'
  and indexname = 'osm_staging_route_visual_qa_history_route_version_key';
