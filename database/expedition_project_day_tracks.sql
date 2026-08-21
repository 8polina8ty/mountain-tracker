-- Phase 7A manual artifact. The target deployment contract was manually
-- verified as public.gps_activities.id bigint (int8).

alter table public.expedition_projects
  add constraint expedition_projects_id_user_id_unique unique (id, user_id);

alter table public.gps_activities
  add constraint gps_activities_phase7a_id_user_id_unique unique (id, user_id);

create table if not exists public.expedition_project_day_tracks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  project_day_id uuid not null,
  gps_activity_id bigint not null,
  user_id uuid not null,
  created_at timestamptz not null default now(),
  constraint expedition_project_day_tracks_project_owner_fk
    foreign key (project_id, user_id) references public.expedition_projects(id, user_id) on delete cascade,
  constraint expedition_project_day_tracks_project_day_fk
    foreign key (project_id, project_day_id) references public.expedition_project_days(project_id, id) on delete cascade,
  constraint expedition_project_day_tracks_activity_owner_fk
    foreign key (gps_activity_id, user_id) references public.gps_activities(id, user_id) on delete cascade,
  constraint expedition_project_day_tracks_day_activity_unique unique (project_day_id, gps_activity_id)
);

create index if not exists expedition_project_day_tracks_project_id_idx on public.expedition_project_day_tracks(project_id);
create index if not exists expedition_project_day_tracks_activity_id_idx on public.expedition_project_day_tracks(gps_activity_id);

alter table public.expedition_project_day_tracks enable row level security;

-- Phase 11B installs the single canonical SELECT policy in
-- expedition_project_collaboration_access.sql. Keep SELECT authorization out of
-- this base artifact so it cannot directly re-enter gps_activities RLS.

create policy expedition_project_day_tracks_insert_owned on public.expedition_project_day_tracks
for insert to authenticated with check (
  expedition_project_day_tracks.user_id = auth.uid()
  and exists (select 1 from public.expedition_projects p where p.id = expedition_project_day_tracks.project_id and p.user_id = auth.uid())
  and exists (select 1 from public.expedition_project_days d where d.id = expedition_project_day_tracks.project_day_id and d.project_id = expedition_project_day_tracks.project_id)
  and exists (select 1 from public.gps_activities a where a.id = expedition_project_day_tracks.gps_activity_id and a.user_id = auth.uid())
);

create policy expedition_project_day_tracks_delete_owned on public.expedition_project_day_tracks
for delete to authenticated using (
  expedition_project_day_tracks.user_id = auth.uid()
  and exists (select 1 from public.expedition_projects p where p.id = expedition_project_day_tracks.project_id and p.user_id = auth.uid())
  and exists (select 1 from public.gps_activities a where a.id = expedition_project_day_tracks.gps_activity_id and a.user_id = auth.uid())
);

revoke all on public.expedition_project_day_tracks from public, anon;
grant select, insert, delete on public.expedition_project_day_tracks to authenticated;
