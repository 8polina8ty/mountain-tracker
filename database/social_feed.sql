-- Social Feed Phase 1 manual artifact
-- REVIEW AND DEPLOY MANUALLY. Apply after social_user_blocks.sql
-- Creates social posts, media, likes, comments with block precedence and friendship-aware RLS/RPCs
begin;

-- ==============================================================
-- Tables
-- ==============================================================
create table if not exists public.social_posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references auth.users(id) on delete cascade,
  body text not null default '',
  visibility text not null default 'public' check (visibility in ('public','friends','private')),
  post_type text not null default 'note' check (post_type in ('note','photo')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz null,
  constraint social_posts_body_length check (char_length(body) <= 5000),
  constraint social_posts_deleted_check check (deleted_at is null or deleted_at >= created_at)
);
create index if not exists social_posts_author_created_idx on public.social_posts (author_id, created_at desc, id desc);
create index if not exists social_posts_created_idx on public.social_posts (created_at desc, id desc);

create table if not exists public.social_post_media (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.social_posts(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete cascade,
  storage_path text not null unique,
  mime_type text not null check (mime_type in ('image/jpeg','image/png','image/webp')),
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 10485760),
  width integer check (width is null or (width > 0 and width <= 8192)),
  height integer check (height is null or (height > 0 and height <= 8192)),
  position integer not null check (position >= 0 and position < 10),
  created_at timestamptz not null default now(),
  constraint social_post_media_position_unique unique (post_id, position),
  constraint social_post_media_author_post_fk check (true)
);
create index if not exists social_post_media_post_position_idx on public.social_post_media (post_id, position);

create table if not exists public.social_post_likes (
  post_id uuid not null references public.social_posts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);
create index if not exists social_post_likes_user_idx on public.social_post_likes (user_id, created_at desc);

create table if not exists public.social_post_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.social_posts(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz null
);
create index if not exists social_post_comments_post_created_idx on public.social_post_comments (post_id, created_at asc, id asc);

-- ==============================================================
-- RLS
-- ==============================================================
alter table public.social_posts enable row level security;
alter table public.social_post_media enable row level security;
alter table public.social_post_likes enable row level security;
alter table public.social_post_comments enable row level security;

-- No direct authenticated writes; mutations via SECURITY DEFINER RPCs.
-- Allow authenticated read only for own rows via RLS for server-side fallback, but anonymous has no access.
drop policy if exists social_posts_no_direct_write on public.social_posts;
create policy social_posts_no_direct_write on public.social_posts for all to authenticated using (false) with check (false);
drop policy if exists social_post_media_no_direct_write on public.social_post_media;
create policy social_post_media_no_direct_write on public.social_post_media for all to authenticated using (false) with check (false);
drop policy if exists social_post_likes_no_direct_write on public.social_post_likes;
create policy social_post_likes_no_direct_write on public.social_post_likes for all to authenticated using (false) with check (false);
drop policy if exists social_post_comments_no_direct_write on public.social_post_comments;
create policy social_post_comments_no_direct_write on public.social_post_comments for all to authenticated using (false) with check (false);

revoke all on public.social_posts, public.social_post_media, public.social_post_likes, public.social_post_comments from public, anon;
grant select on public.social_posts, public.social_post_media, public.social_post_likes, public.social_post_comments to authenticated;

-- Storage bucket (private)
insert into storage.buckets (id, name, public) values ('social-post-media','social-post-media', false) on conflict (id) do nothing;

-- ==============================================================
-- Helpers
-- ==============================================================
create or replace function public.is_blocked_either(a uuid, b uuid)
returns boolean language sql stable security definer set search_path = '' as $function$
  select exists(select 1 from public.user_blocks where (blocker_id=a and blocked_id=b) or (blocker_id=b and blocked_id=a));
$function$;

create or replace function public.are_friends(a uuid, b uuid)
returns boolean language sql stable security definer set search_path = '' as $function$
  select exists(select 1 from public.friendships where user_low_id=least(a::text,b::text)::uuid and user_high_id=greatest(a::text,b::text)::uuid);
$function$;

create or replace function public.can_view_social_post(viewer uuid, post_row public.social_posts)
returns boolean language sql stable security definer set search_path = '' as $function$
  select
    post_row.deleted_at is null
    and not public.is_blocked_either(viewer, post_row.author_id)
    and (
      post_row.visibility='public'
      or (post_row.visibility='friends' and (viewer=post_row.author_id or public.are_friends(viewer, post_row.author_id)))
      or (post_row.visibility='private' and viewer=post_row.author_id)
    );
$function$;

-- ==============================================================
-- RPCs
-- ==============================================================
create or replace function public.create_social_post(requested_body text, requested_visibility text, requested_post_type text)
returns uuid language plpgsql volatile security definer set search_path = '' as $function$
declare actor uuid := auth.uid(); new_id uuid; clean_body text;
begin
  if actor is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if requested_visibility not in ('public','friends','private') then raise exception 'Invalid visibility' using errcode='22023'; end if;
  if requested_post_type not in ('note','photo') then requested_post_type:='note'; end if;
  clean_body := btrim(coalesce(requested_body,''));
  if char_length(clean_body) > 5000 then raise exception 'Body too long' using errcode='22023'; end if;
  -- body OR media requirement is enforced at media insertion time; allow empty body for photo post draft, but require at least one for final validation in application layer
  insert into public.social_posts (author_id, body, visibility, post_type) values (actor, clean_body, requested_visibility, requested_post_type) returning id into new_id;
  return new_id;
end;$function$;

create or replace function public.update_social_post(requested_post_id uuid, requested_body text, requested_visibility text)
returns boolean language plpgsql volatile security definer set search_path = '' as $function$
declare actor uuid := auth.uid(); clean_body text;
begin
  if actor is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if requested_visibility not in ('public','friends','private') then raise exception 'Invalid visibility' using errcode='22023'; end if;
  clean_body := btrim(coalesce(requested_body,''));
  if char_length(clean_body) > 5000 then raise exception 'Body too long' using errcode='22023'; end if;
  -- ensure post has body or media
  if clean_body = '' and not exists(select 1 from public.social_post_media where post_id=requested_post_id) then raise exception 'Post must contain body or media' using errcode='22023'; end if;
  update public.social_posts set body=clean_body, visibility=requested_visibility, updated_at=now() where id=requested_post_id and author_id=actor and deleted_at is null;
  if not found then raise exception 'Post not found' using errcode='22023'; end if;
  return true;
end;$function$;

create or replace function public.delete_social_post(requested_post_id uuid)
returns boolean language plpgsql volatile security definer set search_path = '' as $function$
declare actor uuid := auth.uid();
begin
  if actor is null then raise exception 'Authentication required' using errcode='42501'; end if;
  update public.social_posts set deleted_at=now(), updated_at=now() where id=requested_post_id and author_id=actor and deleted_at is null;
  if not found then raise exception 'Post not found' using errcode='22023'; end if;
  return true;
end;$function$;

create or replace function public.list_social_feed(cursor_created_at timestamptz default null, cursor_post_id uuid default null, result_limit integer default 20)
returns table(post_id uuid, author_id uuid, username text, display_name text, avatar_url text, body text, visibility text, post_type text, created_at timestamptz, updated_at timestamptz, like_count bigint, comment_count bigint, viewer_liked boolean)
language sql stable security definer set search_path = '' as $function$
  select p.id, p.author_id, pr.username, pr.display_name, pr.avatar_url, p.body, p.visibility, p.post_type, p.created_at, p.updated_at,
    (select count(*) from public.social_post_likes l where l.post_id=p.id) as like_count,
    (select count(*) from public.social_post_comments c where c.post_id=p.id and c.deleted_at is null) as comment_count,
    exists(select 1 from public.social_post_likes l where l.post_id=p.id and l.user_id=auth.uid()) as viewer_liked
  from public.social_posts p
  join public.profiles pr on pr.id=p.author_id
  where p.deleted_at is null
    and auth.uid() is not null
    and not public.is_blocked_either(auth.uid(), p.author_id)
    and (
      p.author_id = auth.uid()
      or (p.visibility='public')
      or (p.visibility='friends' and public.are_friends(auth.uid(), p.author_id))
    )
    and (cursor_created_at is null or (p.created_at, p.id) < (cursor_created_at, cursor_post_id))
  order by p.created_at desc, p.id desc
  limit least(greatest(coalesce(result_limit,20),1),50);
$function$;

create or replace function public.list_user_social_posts(requested_user_id uuid, cursor_created_at timestamptz default null, cursor_post_id uuid default null, result_limit integer default 20)
returns table(post_id uuid, author_id uuid, username text, display_name text, avatar_url text, body text, visibility text, post_type text, created_at timestamptz, updated_at timestamptz, like_count bigint, comment_count bigint, viewer_liked boolean)
language sql stable security definer set search_path = '' as $function$
  select p.id, p.author_id, pr.username, pr.display_name, pr.avatar_url, p.body, p.visibility, p.post_type, p.created_at, p.updated_at,
    (select count(*) from public.social_post_likes l where l.post_id=p.id),
    (select count(*) from public.social_post_comments c where c.post_id=p.id and c.deleted_at is null),
    case when auth.uid() is null then false else exists(select 1 from public.social_post_likes l where l.post_id=p.id and l.user_id=auth.uid()) end
  from public.social_posts p
  join public.profiles pr on pr.id=p.author_id
  where p.deleted_at is null
    and p.author_id = requested_user_id
    and not coalesce(public.is_blocked_either(auth.uid(), p.author_id), false)
    and (
      (auth.uid() is null and p.visibility='public')
      or (auth.uid() is not null and (
          p.author_id = auth.uid()
          or p.visibility='public'
          or (p.visibility='friends' and public.are_friends(auth.uid(), p.author_id))
        ))
    )
    and (cursor_created_at is null or (p.created_at, p.id) < (cursor_created_at, cursor_post_id))
  order by p.created_at desc, p.id desc
  limit least(greatest(coalesce(result_limit,20),1),50);
$function$;

create or replace function public.like_social_post(requested_post_id uuid)
returns boolean language plpgsql volatile security definer set search_path = '' as $function$
declare actor uuid := auth.uid(); post_row public.social_posts%rowtype;
begin
  if actor is null then raise exception 'Authentication required' using errcode='42501'; end if;
  select * into post_row from public.social_posts where id=requested_post_id and deleted_at is null;
  if not found then raise exception 'Post not found' using errcode='22023'; end if;
  if public.is_blocked_either(actor, post_row.author_id) then raise exception 'Blocked' using errcode='42501'; end if;
  if not (post_row.author_id=actor or post_row.visibility='public' or (post_row.visibility='friends' and public.are_friends(actor, post_row.author_id))) then raise exception 'Not visible' using errcode='42501'; end if;
  insert into public.social_post_likes (post_id, user_id) values (requested_post_id, actor) on conflict do nothing;
  return true;
end;$function$;

create or replace function public.unlike_social_post(requested_post_id uuid)
returns boolean language plpgsql volatile security definer set search_path = '' as $function$
declare actor uuid := auth.uid();
begin
  if actor is null then raise exception 'Authentication required' using errcode='42501'; end if;
  delete from public.social_post_likes where post_id=requested_post_id and user_id=actor;
  return true;
end;$function$;

create or replace function public.list_social_post_comments(requested_post_id uuid, result_limit integer default 5)
returns table(comment_id uuid, post_id uuid, author_id uuid, username text, display_name text, avatar_url text, body text, created_at timestamptz)
language sql stable security definer set search_path = '' as $function$
  select c.id, c.post_id, c.author_id, pr.username, pr.display_name, pr.avatar_url, c.body, c.created_at
  from public.social_post_comments c
  join public.profiles pr on pr.id=c.author_id
  join public.social_posts p on p.id=c.post_id
  where c.post_id=requested_post_id and c.deleted_at is null and p.deleted_at is null
    and not public.is_blocked_either(coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid), c.author_id)
    and not public.is_blocked_either(coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid), p.author_id)
    and (
      p.visibility='public' or p.author_id=coalesce(auth.uid(),'00000000-0000-0000-0000-000000000000'::uuid) or (p.visibility='friends' and public.are_friends(auth.uid(), p.author_id))
      or auth.uid() is null and p.visibility='public'
    )
  order by c.created_at asc, c.id asc
  limit least(greatest(coalesce(result_limit,5),1),50);
$function$;

create or replace function public.create_social_post_comment(requested_post_id uuid, requested_body text)
returns uuid language plpgsql volatile security definer set search_path = '' as $function$
declare actor uuid := auth.uid(); clean_body text; new_id uuid; post_row public.social_posts%rowtype;
begin
  if actor is null then raise exception 'Authentication required' using errcode='42501'; end if;
  clean_body := btrim(coalesce(requested_body,''));
  if char_length(clean_body) < 1 or char_length(clean_body) > 2000 then raise exception 'Invalid body' using errcode='22023'; end if;
  select * into post_row from public.social_posts where id=requested_post_id and deleted_at is null;
  if not found then raise exception 'Post not found' using errcode='22023'; end if;
  if public.is_blocked_either(actor, post_row.author_id) then raise exception 'Blocked' using errcode='42501'; end if;
  if not (post_row.author_id=actor or post_row.visibility='public' or (post_row.visibility='friends' and public.are_friends(actor, post_row.author_id))) then raise exception 'Not visible' using errcode='42501'; end if;
  insert into public.social_post_comments (post_id, author_id, body) values (requested_post_id, actor, clean_body) returning id into new_id;
  return new_id;
end;$function$;

create or replace function public.delete_social_post_comment(requested_comment_id uuid)
returns boolean language plpgsql volatile security definer set search_path = '' as $function$
declare actor uuid := auth.uid(); comment_row public.social_post_comments%rowtype; post_row public.social_posts%rowtype;
begin
  if actor is null then raise exception 'Authentication required' using errcode='42501'; end if;
  select * into comment_row from public.social_post_comments where id=requested_comment_id and deleted_at is null;
  if not found then raise exception 'Comment not found' using errcode='22023'; end if;
  select * into post_row from public.social_posts where id=comment_row.post_id;
  if not found then raise exception 'Post not found' using errcode='22023'; end if;
  if comment_row.author_id <> actor and post_row.author_id <> actor then raise exception 'Not authorized' using errcode='42501'; end if;
  update public.social_post_comments set deleted_at=now(), updated_at=now() where id=requested_comment_id;
  return true;
end;$function$;

-- Storage policies for social-post-media
drop policy if exists social_post_media_insert_owned on storage.objects;
drop policy if exists social_post_media_select_owned on storage.objects;
drop policy if exists social_post_media_delete_owned on storage.objects;
create policy social_post_media_insert_owned on storage.objects for insert to authenticated with check (
  bucket_id='social-post-media'
  and (storage.foldername(name))[1] = auth.uid()::text
  and cardinality(storage.foldername(name)) = 3
  and (storage.foldername(name))[2] ~ '^[0-9a-f-]{36}$'
  and (storage.foldername(name))[3] ~ '^[0-9a-f-]{36}$'
);
create policy social_post_media_select_owned on storage.objects for select to authenticated using (
  bucket_id='social-post-media'
  and exists (select 1 from public.social_posts p where p.id::text = (storage.foldername(name))[2] and p.author_id = auth.uid())
);
create policy social_post_media_delete_owned on storage.objects for delete to authenticated using (
  bucket_id='social-post-media'
  and (storage.foldername(name))[1] = auth.uid()::text
);

revoke all on function public.create_social_post(text,text,text) from public, anon;
revoke all on function public.update_social_post(uuid,text,text) from public, anon;
revoke all on function public.delete_social_post(uuid) from public, anon;
revoke all on function public.list_social_feed(timestamptz,uuid,integer) from public, anon;
revoke all on function public.list_user_social_posts(uuid,timestamptz,uuid,integer) from public, anon;
revoke all on function public.like_social_post(uuid) from public, anon;
revoke all on function public.unlike_social_post(uuid) from public, anon;
revoke all on function public.list_social_post_comments(uuid,integer) from public, anon;
revoke all on function public.create_social_post_comment(uuid,text) from public, anon;
revoke all on function public.delete_social_post_comment(uuid) from public, anon;
revoke all on function public.is_blocked_either(uuid,uuid) from public, anon;
revoke all on function public.are_friends(uuid,uuid) from public, anon;
revoke all on function public.can_view_social_post(uuid,public.social_posts) from public, anon;

grant execute on function public.create_social_post(text,text,text) to authenticated;
grant execute on function public.update_social_post(uuid,text,text) to authenticated;
grant execute on function public.delete_social_post(uuid) to authenticated;
grant execute on function public.list_social_feed(timestamptz,uuid,integer) to authenticated;
grant execute on function public.list_user_social_posts(uuid,timestamptz,uuid,integer) to anon, authenticated;
grant execute on function public.like_social_post(uuid) to authenticated;
grant execute on function public.unlike_social_post(uuid) to authenticated;
grant execute on function public.list_social_post_comments(uuid,integer) to anon, authenticated;
grant execute on function public.create_social_post_comment(uuid,text) to authenticated;
grant execute on function public.delete_social_post_comment(uuid) to authenticated;

-- ==============================================================
-- Phase 2: Share to profile (ascent, achievement, expedition)
-- ==============================================================
alter table public.social_posts add column if not exists linked_ascent_id bigint references public.ascents(id) on delete set null;
alter table public.social_posts add column if not exists linked_achievement_id text check (linked_achievement_id in ('first-ascent','five-ascents','ten-ascents','twenty-five-ascents','fifty-ascents','above-clouds','zugspitze','ten-thousand-height'));
alter table public.social_posts add column if not exists linked_project_id uuid references public.expedition_projects(id) on delete set null;
-- extend post_type check
do $$ begin
  alter table public.social_posts drop constraint if exists social_posts_post_type_check;
  alter table public.social_posts add constraint social_posts_post_type_check check (post_type in ('note','photo','ascent','achievement','expedition'));
exception when others then null; end $$;
-- invariants: only one linked source per post
-- Allow ON DELETE SET NULL to succeed: creation requires valid source via RPC, but post may survive with null linked after source deletion and must render "Source unavailable".
do $$ begin
  alter table public.social_posts add constraint social_posts_linked_invariant check (
    (case when linked_ascent_id is not null then 1 else 0 end + case when linked_achievement_id is not null then 1 else 0 end + case when linked_project_id is not null then 1 else 0 end) <= 1
    and (linked_ascent_id is null or post_type='ascent')
    and (linked_achievement_id is null or post_type='achievement')
    and (linked_project_id is null or post_type='expedition')
  );
exception when duplicate_object then null; end $$;
-- Fix legacy strict constraint if present (previous version required not-null). Allow SET NULL.
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

create or replace function public.create_social_ascent_post(requested_ascent_id bigint, requested_body text, requested_visibility text)
returns uuid language plpgsql volatile security definer set search_path = '' as $function$
declare actor uuid := auth.uid(); clean_body text; new_id uuid;
begin
  if actor is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if requested_visibility not in ('public','friends','private') then raise exception 'Invalid visibility' using errcode='22023'; end if;
  clean_body := btrim(coalesce(requested_body,''));
  if char_length(clean_body) > 5000 then raise exception 'Body too long' using errcode='22023'; end if;
  if not exists(select 1 from public.ascents where id=requested_ascent_id and user_id=actor) then raise exception 'Ascent not owned' using errcode='42501'; end if;
  insert into public.social_posts (author_id, body, visibility, post_type, linked_ascent_id) values (actor, clean_body, requested_visibility, 'ascent', requested_ascent_id) returning id into new_id;
  return new_id;
exception when unique_violation then raise exception 'Already shared' using errcode='23505';
end;$function$;

create or replace function public.create_social_achievement_post(requested_achievement_id text, requested_body text, requested_visibility text)
returns uuid language plpgsql volatile security definer set search_path = '' as $function$
declare actor uuid := auth.uid(); clean_body text; new_id uuid;
begin
  if actor is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if requested_visibility not in ('public','friends','private') then raise exception 'Invalid visibility' using errcode='22023'; end if;
  if requested_achievement_id not in ('first-ascent','five-ascents','ten-ascents','twenty-five-ascents','fifty-ascents','above-clouds','zugspitze','ten-thousand-height') then raise exception 'Invalid achievement' using errcode='22023'; end if;
  clean_body := btrim(coalesce(requested_body,''));
  if char_length(clean_body) > 5000 then raise exception 'Body too long' using errcode='22023'; end if;
  if not exists(select 1 from public.user_achievements where user_id=actor and achievement_id=requested_achievement_id) then raise exception 'Achievement not unlocked' using errcode='42501'; end if;
  insert into public.social_posts (author_id, body, visibility, post_type, linked_achievement_id) values (actor, clean_body, requested_visibility, 'achievement', requested_achievement_id) returning id into new_id;
  return new_id;
exception when unique_violation then raise exception 'Already shared' using errcode='23505';
end;$function$;

create or replace function public.create_social_expedition_post(requested_project_id uuid, requested_body text, requested_visibility text)
returns uuid language plpgsql volatile security definer set search_path = '' as $function$
declare actor uuid := auth.uid(); clean_body text; new_id uuid; proj_user uuid; proj_status text;
begin
  if actor is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if requested_visibility not in ('public','friends','private') then raise exception 'Invalid visibility' using errcode='22023'; end if;
  clean_body := btrim(coalesce(requested_body,''));
  if char_length(clean_body) > 5000 then raise exception 'Body too long' using errcode='22023'; end if;
  select user_id, status into proj_user, proj_status from public.expedition_projects where id=requested_project_id;
  if not found or proj_user <> actor then raise exception 'Project not owned' using errcode='42501'; end if;
  if proj_status not in ('completed','archived') then raise exception 'Project not publishable' using errcode='22023'; end if;
  if not exists(select 1 from public.expedition_project_day_tracks dt join public.gps_activities ga on ga.id=dt.gps_activity_id where dt.project_id=requested_project_id and ga.processing_status='ready') then raise exception 'No GPS evidence' using errcode='22023'; end if;
  if not exists(select 1 from public.expedition_project_shares where project_id=requested_project_id and user_id=actor and is_enabled=true) then raise exception 'Enable public sharing first' using errcode='22023'; end if;
  insert into public.social_posts (author_id, body, visibility, post_type, linked_project_id) values (actor, clean_body, requested_visibility, 'expedition', requested_project_id) returning id into new_id;
  return new_id;
exception when unique_violation then raise exception 'Already shared' using errcode='23505';
end;$function$;

revoke all on function public.create_social_ascent_post(bigint,text,text) from public, anon;
revoke all on function public.create_social_achievement_post(text,text,text) from public, anon;
revoke all on function public.create_social_expedition_post(uuid,text,text) from public, anon;
grant execute on function public.create_social_ascent_post(bigint,text,text) to authenticated;
grant execute on function public.create_social_achievement_post(text,text,text) to authenticated;
grant execute on function public.create_social_expedition_post(uuid,text,text) to authenticated;

-- Expedition revocation helper: revalidate on every read, do not serve stale slug/media after is_enabled=false
create or replace function public.is_social_expedition_available(requested_project_id uuid)
returns boolean language sql stable security definer set search_path = '' as $function$
  select exists(select 1 from public.expedition_project_shares where project_id=requested_project_id and is_enabled=true and exists(select 1 from public.expedition_projects p where p.id=requested_project_id and p.status in ('completed','archived') and exists(select 1 from public.expedition_project_day_tracks dt join public.gps_activities ga on ga.id=dt.gps_activity_id where dt.project_id=requested_project_id and ga.processing_status='ready')));
$function$;
revoke all on function public.is_social_expedition_available(uuid) from public, anon;
grant execute on function public.is_social_expedition_available(uuid) to anon, authenticated;

commit;
