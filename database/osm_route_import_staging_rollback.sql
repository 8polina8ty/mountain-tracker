-- Phase 8 OSM route staging rollback.
-- REVIEW AND APPLY MANUALLY only if the isolated staging schema must be removed.
-- This intentionally touches no Mountain Tracker application or production-route data.

begin;

drop function if exists public.stage_osm_route_import(jsonb, jsonb);
drop table if exists public.osm_route_import_summit_staging;
drop table if exists public.osm_route_import_staging;

commit;
