-- Social Feed Phase 2 upgrade artifact
-- Manual deployment if Phase 1 already deployed. For fresh installs, social_feed.sql already includes Phase 2.
begin;
-- same Phase 2 delta as appended to social_feed.sql (idempotent)
alter table public.social_posts add column if not exists linked_ascent_id bigint references public.ascents(id) on delete set null;
alter table public.social_posts add column if not exists linked_achievement_id text check (linked_achievement_id in ('first-ascent','five-ascents','ten-ascents','twenty-five-ascents','fifty-ascents','above-clouds','zugspitze','ten-thousand-height'));
alter table public.social_posts add column if not exists linked_project_id uuid references public.expedition_projects(id) on delete set null;
do $$ begin
  alter table public.social_posts drop constraint if exists social_posts_post_type_check;
  alter table public.social_posts add constraint social_posts_post_type_check check (post_type in ('note','photo','ascent','achievement','expedition'));
exception when others then null; end $$;
do $$ begin
  alter table public.social_posts add constraint social_posts_linked_invariant check (
    (case when linked_ascent_id is not null then 1 else 0 end + case when linked_achievement_id is not null then 1 else 0 end + case when linked_project_id is not null then 1 else 0 end) <= 1
    and (linked_ascent_id is null or post_type='ascent')
    and (linked_achievement_id is null or post_type='achievement')
    and (linked_project_id is null or post_type='expedition')
  );
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.social_posts drop constraint if exists social_posts_linked_invariant;
  alter table public.social_posts add constraint social_posts_linked_invariant check (
    (case when linked_ascent_id is not null then 1 else 0 end + case when linked_achievement_id is not null then 1 else 0 end + case when linked_project_id is not null then 1 else 0 end) <= 1
    and (linked_ascent_id is null or post_type='ascent')
    and (linked_achievement_id is null or post_type='achievement')
    and (linked_project_id is null or post_type='expedition')
  );
exception when others then null; end $$;
create unique index if not exists social_posts_unique_ascent_per_author on public.social_posts (author_id, linked_ascent_id) where deleted_at is null and linked_ascent_id is not null;
create unique index if not exists social_posts_unique_achievement_per_author on public.social_posts (author_id, linked_achievement_id) where deleted_at is null and linked_achievement_id is not null;
create unique index if not exists social_posts_unique_project_per_author on public.social_posts (author_id, linked_project_id) where deleted_at is null and linked_project_id is not null;
-- RPCs
create or replace function public.create_social_ascent_post(requested_ascent_id bigint, requested_body text, requested_visibility text) returns uuid language plpgsql volatile security definer set search_path = '' as $function$ declare actor uuid := auth.uid(); clean_body text; new_id uuid; begin if actor is null then raise exception 'Authentication required' using errcode='42501'; end if; if requested_visibility not in ('public','friends','private') then raise exception 'Invalid visibility' using errcode='22023'; end if; clean_body := btrim(coalesce(requested_body,'')); if char_length(clean_body) > 5000 then raise exception 'Body too long' using errcode='22023'; end if; if not exists(select 1 from public.ascents where id=requested_ascent_id and user_id=actor) then raise exception 'Ascent not owned' using errcode='42501'; end if; insert into public.social_posts (author_id, body, visibility, post_type, linked_ascent_id) values (actor, clean_body, requested_visibility, 'ascent', requested_ascent_id) returning id into new_id; return new_id; exception when unique_violation then raise exception 'Already shared' using errcode='23505'; end;$function$;
create or replace function public.create_social_achievement_post(requested_achievement_id text, requested_body text, requested_visibility text) returns uuid language plpgsql volatile security definer set search_path = '' as $function$ declare actor uuid := auth.uid(); clean_body text; new_id uuid; begin if actor is null then raise exception 'Authentication required' using errcode='42501'; end if; if requested_visibility not in ('public','friends','private') then raise exception 'Invalid visibility' using errcode='22023'; end if; if requested_achievement_id not in ('first-ascent','five-ascents','ten-ascents','twenty-five-ascents','fifty-ascents','above-clouds','zugspitze','ten-thousand-height') then raise exception 'Invalid achievement' using errcode='22023'; end if; clean_body := btrim(coalesce(requested_body,'')); if char_length(clean_body) > 5000 then raise exception 'Body too long' using errcode='22023'; end if; if not exists(select 1 from public.user_achievements where user_id=actor and achievement_id=requested_achievement_id) then raise exception 'Achievement not unlocked' using errcode='42501'; end if; insert into public.social_posts (author_id, body, visibility, post_type, linked_achievement_id) values (actor, clean_body, requested_visibility, 'achievement', requested_achievement_id) returning id into new_id; return new_id; exception when unique_violation then raise exception 'Already shared' using errcode='23505'; end;$function$;
create or replace function public.create_social_expedition_post(requested_project_id uuid, requested_body text, requested_visibility text) returns uuid language plpgsql volatile security definer set search_path = '' as $function$ declare actor uuid := auth.uid(); clean_body text; new_id uuid; proj_user uuid; proj_status text; begin if actor is null then raise exception 'Authentication required' using errcode='42501'; end if; if requested_visibility not in ('public','friends','private') then raise exception 'Invalid visibility' using errcode='22023'; end if; clean_body := btrim(coalesce(requested_body,'')); if char_length(clean_body) > 5000 then raise exception 'Body too long' using errcode='22023'; end if; select user_id, status into proj_user, proj_status from public.expedition_projects where id=requested_project_id; if not found or proj_user <> actor then raise exception 'Project not owned' using errcode='42501'; end if; if proj_status not in ('completed','archived') then raise exception 'Project not publishable' using errcode='22023'; end if; if not exists(select 1 from public.expedition_project_day_tracks dt join public.gps_activities ga on ga.id=dt.gps_activity_id where dt.project_id=requested_project_id and ga.processing_status='ready') then raise exception 'No GPS evidence' using errcode='22023'; end if; if not exists(select 1 from public.expedition_project_shares where project_id=requested_project_id and user_id=actor and is_enabled=true) then raise exception 'Enable public sharing first' using errcode='22023'; end if; insert into public.social_posts (author_id, body, visibility, post_type, linked_project_id) values (actor, clean_body, requested_visibility, 'expedition', requested_project_id) returning id into new_id; return new_id; exception when unique_violation then raise exception 'Already shared' using errcode='23505'; end;$function$;
revoke all on function public.create_social_ascent_post(bigint,text,text) from public, anon;
revoke all on function public.create_social_achievement_post(text,text,text) from public, anon;
revoke all on function public.create_social_expedition_post(uuid,text,text) from public, anon;
grant execute on function public.create_social_ascent_post(bigint,text,text) to authenticated;
grant execute on function public.create_social_achievement_post(text,text,text) to authenticated;
grant execute on function public.create_social_expedition_post(uuid,text,text) to authenticated;
create or replace function public.is_social_expedition_available(requested_project_id uuid) returns boolean language sql stable security definer set search_path = '' as $function$ select exists(select 1 from public.expedition_project_shares where project_id=requested_project_id and is_enabled=true and exists(select 1 from public.expedition_projects p where p.id=requested_project_id and p.status in ('completed','archived') and exists(select 1 from public.expedition_project_day_tracks dt join public.gps_activities ga on ga.id=dt.gps_activity_id where dt.project_id=requested_project_id and ga.processing_status='ready')));$function$;
revoke all on function public.is_social_expedition_available(uuid) from public, anon;
grant execute on function public.is_social_expedition_available(uuid) to anon, authenticated;
commit;
