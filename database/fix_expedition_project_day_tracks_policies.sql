-- Phase 7A production repair: remove ambiguity in the deployed INSERT policy's
-- project-day ownership predicate. Apply manually after review.
begin;

drop policy expedition_project_day_tracks_insert_owned
  on public.expedition_project_day_tracks;

create policy expedition_project_day_tracks_insert_owned
on public.expedition_project_day_tracks
for insert to authenticated with check (
  expedition_project_day_tracks.user_id = auth.uid()
  and exists (select 1 from public.expedition_projects p where p.id = expedition_project_day_tracks.project_id and p.user_id = auth.uid())
  and exists (select 1 from public.expedition_project_days d where d.id = expedition_project_day_tracks.project_day_id and d.project_id = expedition_project_day_tracks.project_id)
  and exists (select 1 from public.gps_activities a where a.id = expedition_project_day_tracks.gps_activity_id and a.user_id = auth.uid())
);

commit;
