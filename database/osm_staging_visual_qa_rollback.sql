-- Phase 9B visual-QA rollback.
-- REVIEW AND APPLY MANUALLY only if the isolated decision schema must be removed.

begin;

drop function if exists public.record_osm_staging_visual_qa_decision(
  uuid, text, text, uuid, bigint, text, text, text, text, text, text, bigint, integer
);
drop table if exists public.osm_staging_route_visual_qa_history;
drop table if exists public.osm_staging_route_visual_qa;

commit;
