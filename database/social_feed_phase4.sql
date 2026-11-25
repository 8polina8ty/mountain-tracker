-- Phase 4: MANUAL deployment only, after reviewed Phase 1, 2, 3 artifacts.
-- Preflight and rollback-only regression instructions: social_feed_phase4_review.md.
begin;
do $$ begin
  if current_user <> 'postgres' then raise exception 'Review and deploy Phase 4 as postgres'; end if;
  if to_regprocedure('public.get_social_post(uuid)') is null
     or to_regprocedure('public.is_social_expedition_available(uuid)') is null
     or to_regprocedure('public.block_user(uuid)') is null
     or to_regclass('public.social_notifications') is null then
    raise exception 'Deploy and verify Social Phases 1-3 first';
  end if;
  if not exists(select 1 from storage.buckets where id='social-post-media' and public=false) then
    raise exception 'The existing social-post-media bucket must be private';
  end if;
end $$;

create table if not exists public.social_follows (
  follower_user_id uuid not null references auth.users(id) on delete cascade,
  followed_user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_user_id, followed_user_id),
  check (follower_user_id <> followed_user_id)
);
create index if not exists social_follows_followers_idx on public.social_follows(followed_user_id, created_at desc, follower_user_id desc);
create index if not exists social_follows_following_idx on public.social_follows(follower_user_id, created_at desc, followed_user_id desc);
alter table public.social_follows enable row level security;
revoke all on public.social_follows from public, anon, authenticated;

alter table public.social_notifications drop constraint if exists social_notifications_notification_type_check;
alter table public.social_notifications add constraint social_notifications_notification_type_check check (notification_type in (
  'social.post_liked','social.post_commented','social.mentioned_in_post','social.mentioned_in_comment','social.user_followed'
));

-- Serialize block and follow mutations for both directions of the same pair.
-- A trigger integrates with the existing block_user without replacing its deployed body.
create or replace function public.social_follow_block_cleanup()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'Follow/block writes require READ COMMITTED' using errcode='25001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(least(new.blocker_id::text,new.blocked_id::text)||greatest(new.blocker_id::text,new.blocked_id::text), 4));
  delete from public.social_follows where
    (follower_user_id=new.blocker_id and followed_user_id=new.blocked_id) or
    (follower_user_id=new.blocked_id and followed_user_id=new.blocker_id);
  return new;
end $$;
drop trigger if exists social_follow_block_cleanup on public.user_blocks;
create trigger social_follow_block_cleanup before insert on public.user_blocks for each row execute function public.social_follow_block_cleanup();

create or replace function public.follow_social_user(requested_user_id uuid)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare actor uuid := auth.uid(); inserted integer;
begin
  if actor is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'Follow/block writes require READ COMMITTED' using errcode='25001';
  end if;
  if requested_user_id is null or actor=requested_user_id or not exists(select 1 from public.profiles where id=requested_user_id) then
    raise exception 'Follow unavailable' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(least(actor::text,requested_user_id::text)||greatest(actor::text,requested_user_id::text), 4));
  if public.is_blocked_either(actor,requested_user_id) then raise exception 'Follow unavailable' using errcode='42501'; end if;
  insert into public.social_follows(follower_user_id,followed_user_id) values(actor,requested_user_id) on conflict do nothing;
  get diagnostics inserted=row_count;
  if inserted=1 then
    -- Lifetime pair key: unfollow/re-follow never resets read state or sends again.
    insert into public.social_notifications(recipient_user_id,actor_user_id,notification_type,source_key,metadata)
    values(requested_user_id,actor,'social.user_followed','follow:'||actor::text,'{}'::jsonb) on conflict do nothing;
  end if;
  return true;
end $$;
create or replace function public.unfollow_social_user(requested_user_id uuid)
returns boolean language plpgsql volatile security definer set search_path='' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  delete from public.social_follows where follower_user_id=auth.uid() and followed_user_id=requested_user_id;
  return true;
end $$;
create or replace function public.get_social_follow_summary(requested_user_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'followersCount',(select count(*) from public.social_follows f where f.followed_user_id=p.id and not public.is_blocked_either(auth.uid(),f.follower_user_id)),
    'followingCount',(select count(*) from public.social_follows f where f.follower_user_id=p.id and not public.is_blocked_either(auth.uid(),f.followed_user_id)),
    'isFollowing',exists(select 1 from public.social_follows where follower_user_id=auth.uid() and followed_user_id=p.id))
  from public.profiles p where p.id=requested_user_id and not public.is_blocked_either(auth.uid(),p.id);
$$;
create or replace function public.list_social_followers(requested_user_id uuid, cursor_created_at timestamptz default null, cursor_user_id uuid default null, result_limit integer default 20)
returns table(user_id uuid,username text,display_name text,avatar_url text,created_at timestamptz)
language sql stable security definer set search_path='' as $$
  select p.id,p.username,p.display_name,p.avatar_url,f.created_at from public.social_follows f join public.profiles p on p.id=f.follower_user_id
  where auth.uid() is not null and f.followed_user_id=requested_user_id
    and not public.is_blocked_either(auth.uid(),requested_user_id) and not public.is_blocked_either(auth.uid(),p.id)
    and (cursor_created_at is null or (f.created_at,p.id)<(cursor_created_at,cursor_user_id))
  order by f.created_at desc,p.id desc limit least(greatest(coalesce(result_limit,20),1),50);
$$;
create or replace function public.list_social_following(requested_user_id uuid, cursor_created_at timestamptz default null, cursor_user_id uuid default null, result_limit integer default 20)
returns table(user_id uuid,username text,display_name text,avatar_url text,created_at timestamptz)
language sql stable security definer set search_path='' as $$
  select p.id,p.username,p.display_name,p.avatar_url,f.created_at from public.social_follows f join public.profiles p on p.id=f.followed_user_id
  where auth.uid() is not null and f.follower_user_id=requested_user_id
    and not public.is_blocked_either(auth.uid(),requested_user_id) and not public.is_blocked_either(auth.uid(),p.id)
    and (cursor_created_at is null or (f.created_at,p.id)<(cursor_created_at,cursor_user_id))
  order by f.created_at desc,p.id desc limit least(greatest(coalesce(result_limit,20),1),50);
$$;

alter table public.social_posts add column if not exists title text;
alter table public.social_posts add column if not exists published_at timestamptz;
alter table public.social_posts add column if not exists blog_mountain_id bigint references public.mountains(id) on delete set null;
-- Separate reference preserves the Phase 2 one-source invariant and unique shares.
alter table public.social_posts add column if not exists blog_project_id uuid references public.expedition_projects(id) on delete set null;
alter table public.social_posts drop constraint if exists social_posts_post_type_check;
alter table public.social_posts add constraint social_posts_post_type_check check (post_type in ('note','photo','ascent','achievement','expedition','blog'));
alter table public.social_posts drop constraint if exists social_posts_body_length;
alter table public.social_posts add constraint social_posts_body_length check (char_length(body)<=case when post_type='blog' then 20000 else 5000 end);
alter table public.social_posts drop constraint if exists social_posts_blog_contract;
alter table public.social_posts add constraint social_posts_blog_contract check (
  (post_type<>'blog' and title is null and published_at is null and blog_mountain_id is null and blog_project_id is null) or
  (post_type='blog' and title is not null and char_length(btrim(title)) between 1 and 160 and char_length(btrim(body)) between 1 and 20000
   and ((published_at is null and visibility='private') or (published_at is not null and visibility='public')))
);
create index if not exists social_posts_public_phase4_idx on public.social_posts(created_at desc,id desc) where deleted_at is null and visibility='public';

-- Preserve the legacy signatures and note/photo behavior, but never edit blogs here.
create or replace function public.create_social_post(requested_body text, requested_visibility text, requested_post_type text)
returns uuid language plpgsql volatile security definer set search_path='' as $$
declare actor uuid:=auth.uid(); new_id uuid; clean_body text;
begin
  if actor is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if requested_post_type='blog' then raise exception 'Use the blog publication workflow' using errcode='22023'; end if;
  if requested_visibility is null or requested_visibility not in ('public','friends','private') then raise exception 'Invalid visibility' using errcode='22023'; end if;
  if requested_post_type is null or requested_post_type not in ('note','photo') then requested_post_type:='note'; end if;
  clean_body:=btrim(coalesce(requested_body,''));
  if char_length(clean_body)>5000 then raise exception 'Body too long' using errcode='22023'; end if;
  insert into public.social_posts(author_id,body,visibility,post_type) values(actor,clean_body,requested_visibility,requested_post_type) returning id into new_id;
  return new_id;
end $$;
create or replace function public.update_social_post(requested_post_id uuid, requested_body text, requested_visibility text)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare actor uuid:=auth.uid(); clean_body text; item public.social_posts%rowtype;
begin
  if actor is null then raise exception 'Authentication required' using errcode='42501'; end if;
  select * into item from public.social_posts where id=requested_post_id and author_id=actor and deleted_at is null for update;
  if not found then raise exception 'Post unavailable' using errcode='42501'; end if;
  if item.post_type='blog' then raise exception 'Use the blog publication workflow' using errcode='22023'; end if;
  if requested_visibility is null or requested_visibility not in ('public','friends','private') then raise exception 'Invalid visibility' using errcode='22023'; end if;
  clean_body:=btrim(coalesce(requested_body,''));
  if char_length(clean_body)>5000 then raise exception 'Body too long' using errcode='22023'; end if;
  if clean_body='' and not exists(select 1 from public.social_post_media where post_id=item.id) then raise exception 'Post must contain body or media' using errcode='22023'; end if;
  update public.social_posts set body=clean_body,visibility=requested_visibility,updated_at=now() where id=item.id;
  return true;
end $$;
revoke insert,update,delete on public.social_posts,public.social_post_media from public,anon,authenticated;
revoke all on function public.create_social_post(text,text,text),public.update_social_post(uuid,text,text) from public,anon,authenticated;
grant execute on function public.create_social_post(text,text,text),public.update_social_post(uuid,text,text) to authenticated;

create or replace function public.social_blog_cover_is_valid(requested_post_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.social_posts p join public.social_post_media m on m.post_id=p.id and m.author_id=p.author_id
    join storage.objects o on o.bucket_id='social-post-media' and o.name=m.storage_path
    where p.id=requested_post_id and p.deleted_at is null and m.position=0
      and m.storage_path=p.author_id::text||'/'||p.id::text||'/'||m.id::text||case m.mime_type when 'image/jpeg' then '.jpg' when 'image/png' then '.png' when 'image/webp' then '.webp' end
      and o.metadata->>'mimetype'=m.mime_type and (o.metadata->>'size')::bigint=m.size_bytes);
$$;

create or replace function public.social_phase4_source_available(p public.social_posts)
returns boolean language sql stable security definer set search_path='' as $$
  select case p.post_type
    when 'ascent' then exists(select 1 from public.ascents a where a.id=p.linked_ascent_id and a.user_id=p.author_id)
    when 'achievement' then exists(select 1 from public.user_achievements a where a.user_id=p.author_id and a.achievement_id=p.linked_achievement_id)
    when 'expedition' then public.is_social_expedition_available(p.linked_project_id)
    else true end;
$$;
create or replace function public.can_view_social_post(viewer uuid, post_row public.social_posts)
returns boolean language sql stable security definer set search_path='' as $$
  select post_row.deleted_at is null and not public.is_blocked_either(viewer,post_row.author_id)
    and (post_row.visibility='public' or viewer=post_row.author_id or (post_row.visibility='friends' and public.are_friends(viewer,post_row.author_id)))
    and (post_row.post_type<>'blog' or post_row.published_at is not null or viewer=post_row.author_id);
$$;

-- Internal, least-data projection. No storage paths, private source images, GPS, or project IDs.
create or replace function public.social_phase4_post_json(p public.social_posts, pr public.profiles)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('post_id',p.id,'author_id',p.author_id,'username',pr.username,'display_name',pr.display_name,'avatar_url',pr.avatar_url,
    'body',p.body,'title',p.title,'published_at',p.published_at,'visibility',p.visibility,'post_type',p.post_type,'created_at',p.created_at,'updated_at',p.updated_at,
    'like_count',(select count(*) from public.social_post_likes l where l.post_id=p.id),
    'comment_count',(select count(*) from public.social_post_comments c where c.post_id=p.id and c.deleted_at is null and not public.is_blocked_either(auth.uid(),c.author_id)),
    'viewer_liked',exists(select 1 from public.social_post_likes l where l.post_id=p.id and l.user_id=auth.uid()),
    'media',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'post_id',m.post_id,'author_id',m.author_id,'mime_type',m.mime_type,'size_bytes',m.size_bytes,'width',m.width,'height',m.height,'position',m.position) order by m.position) from public.social_post_media m where m.post_id=p.id),'[]'::jsonb),
    'mountain_attachment',(select jsonb_build_object('mountainId',m.id,'mountainName',coalesce(m.name_de,m.name)) from public.mountains m where m.id=p.blog_mountain_id),
    'ascent_attachment',(select jsonb_build_object('mountainId',a.mountain_id,'mountainName',coalesce(m.name_de,m.name),'height',m.height,'climbedAt',a.climbed_at) from public.ascents a join public.mountains m on m.id=a.mountain_id where a.id=p.linked_ascent_id and a.user_id=p.author_id),
    'achievement_attachment',(select jsonb_build_object('achievementId',a.achievement_id,'icon','','unlockedAt',a.unlocked_at) from public.user_achievements a where a.user_id=p.author_id and a.achievement_id=p.linked_achievement_id),
    'expedition_attachment',(select jsonb_build_object('slug',s.public_slug,'title',e.name,'available',true) from public.expedition_project_shares s join public.expedition_projects e on e.id=s.project_id and e.user_id=s.user_id
      where s.project_id=coalesce(p.blog_project_id,p.linked_project_id) and s.is_enabled and public.is_social_expedition_available(s.project_id)));
$$;

-- Additive query; old Phase 1-3 signatures and semantics stay intact.
create or replace function public.list_social_feed_phase4(requested_mode text default 'discover', requested_user_id uuid default null, search_text text default '', sort_mode text default 'newest', cursor_created_at timestamptz default null, cursor_post_id uuid default null, result_limit integer default 20)
returns setof jsonb language sql stable security definer set search_path='' as $$
  select public.social_phase4_post_json(p,pr) from public.social_posts p join public.profiles pr on pr.id=p.author_id
  where public.can_view_social_post(auth.uid(),p)
    and (requested_user_id is null or p.author_id=requested_user_id)
    and case requested_mode
      when 'following' then auth.uid() is not null and exists(select 1 from public.social_follows f where f.follower_user_id=auth.uid() and f.followed_user_id=p.author_id)
      when 'friends' then auth.uid() is not null and (p.author_id=auth.uid() or public.are_friends(auth.uid(),p.author_id))
      when 'all' then auth.uid() is not null
      when 'owner' then auth.uid() is not null and p.author_id=auth.uid()
      when 'profile' then requested_user_id is not null
      when 'blog' then p.post_type='blog' and p.visibility='public' and p.published_at is not null
      when 'activity' then p.post_type in ('ascent','achievement','expedition') and p.visibility='public' and public.social_phase4_source_available(p)
      when 'discover' then p.visibility='public' and (p.post_type<>'blog' or p.published_at is not null) and public.social_phase4_source_available(p)
      else false end
    and (coalesce(btrim(search_text),'')='' or position(lower(left(btrim(search_text),80)) in lower(coalesce(p.title,'')||' '||p.body))>0)
    and (cursor_created_at is null or case when sort_mode='oldest' then (p.created_at,p.id)>(cursor_created_at,cursor_post_id) else (p.created_at,p.id)<(cursor_created_at,cursor_post_id) end)
  order by case when sort_mode='oldest' then p.created_at end asc,case when sort_mode='oldest' then p.id end asc,
    case when sort_mode is distinct from 'oldest' then p.created_at end desc,case when sort_mode is distinct from 'oldest' then p.id end desc
  limit least(greatest(coalesce(result_limit,20),1),50);
$$;
create or replace function public.get_public_social_blog(requested_post_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select public.social_phase4_post_json(p,pr) from public.social_posts p join public.profiles pr on pr.id=p.author_id where p.id=requested_post_id and p.post_type='blog'
    and p.visibility='public' and p.published_at is not null and public.can_view_social_post(auth.uid(),p);
$$;
create or replace function public.get_social_post_phase4(requested_post_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select public.social_phase4_post_json(p,pr) from public.social_posts p join public.profiles pr on pr.id=p.author_id where p.id=requested_post_id and public.can_view_social_post(auth.uid(),p);
$$;
create or replace function public.discover_social_authors(search_text text default '', cursor_name text default null, cursor_user_id uuid default null, result_limit integer default 20)
returns table(user_id uuid,username text,display_name text,avatar_url text,sort_name text,is_following boolean)
language sql stable security definer set search_path='' as $$
  select pr.id,pr.username,pr.display_name,pr.avatar_url,lower(coalesce(pr.display_name,pr.username)),
    exists(select 1 from public.social_follows f where f.follower_user_id=auth.uid() and f.followed_user_id=pr.id)
  from public.profiles pr where not public.is_blocked_either(auth.uid(),pr.id)
    and exists(select 1 from public.social_posts p where p.author_id=pr.id and p.visibility='public' and p.deleted_at is null and (p.post_type<>'blog' or p.published_at is not null) and public.social_phase4_source_available(p))
    and (coalesce(btrim(search_text),'')='' or position(lower(left(btrim(search_text),80)) in lower(pr.username||' '||coalesce(pr.display_name,'')))>0)
    and (cursor_name is null or (lower(coalesce(pr.display_name,pr.username)),pr.id)>(cursor_name,cursor_user_id))
  order by lower(coalesce(pr.display_name,pr.username)),pr.id limit least(greatest(coalesce(result_limit,20),1),50);
$$;

create or replace function public.save_social_blog(requested_post_id uuid, requested_title text, requested_body text, requested_mountain_id bigint default null, requested_expedition_slug text default null, publish boolean default false)
returns uuid language plpgsql volatile security definer set search_path='' as $$
declare actor uuid:=auth.uid(); created_id uuid; project_id uuid; item public.social_posts%rowtype;
begin
  if actor is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if current_setting('transaction_isolation') <> 'read committed' then raise exception 'Media writes require READ COMMITTED' using errcode='25001'; end if;
  if char_length(btrim(coalesce(requested_title,''))) not between 1 and 160 or char_length(btrim(coalesce(requested_body,''))) not between 1 and 20000 then raise exception 'Invalid article' using errcode='22023'; end if;
  if requested_mountain_id is not null and not exists(select 1 from public.mountains where id=requested_mountain_id) then raise exception 'Mountain unavailable' using errcode='22023'; end if;
  if nullif(btrim(requested_expedition_slug),'') is not null then
    select s.project_id into project_id from public.expedition_project_shares s where s.public_slug=requested_expedition_slug and s.is_enabled and public.is_social_expedition_available(s.project_id);
    if project_id is null then raise exception 'Public expedition unavailable' using errcode='22023'; end if;
  end if;
  if requested_post_id is null then
    -- Creating always produces a private draft. Uploads finish before explicit publication.
    insert into public.social_posts(author_id,post_type,visibility,title,body,blog_mountain_id,blog_project_id)
      values(actor,'blog','private',btrim(requested_title),btrim(requested_body),requested_mountain_id,project_id) returning id into created_id;
    return created_id;
  end if;
  select * into item from public.social_posts where id=requested_post_id and author_id=actor and post_type='blog' and deleted_at is null for update;
  if not found then raise exception 'Article unavailable' using errcode='42501'; end if;
  if (coalesce(publish,false) or item.published_at is not null) and not public.social_blog_cover_is_valid(item.id) then raise exception 'Valid uploaded cover required' using errcode='22023'; end if;
  update public.social_posts set title=btrim(requested_title),body=btrim(requested_body),blog_mountain_id=requested_mountain_id,blog_project_id=project_id,
    published_at=case when publish then coalesce(item.published_at,now()) else item.published_at end,
    visibility=case when publish or item.published_at is not null then 'public' else 'private' end,updated_at=now() where id=item.id;
  return item.id;
end $$;

-- Register only an existing, correctly owned object. Never accept a client storage path.
create or replace function public.register_social_post_media(requested_post_id uuid, requested_media_id uuid, requested_mime text, requested_size bigint, requested_position integer)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare actor uuid:=auth.uid(); object_path text; extension text;
begin
  if actor is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if current_setting('transaction_isolation') <> 'read committed' then raise exception 'Media writes require READ COMMITTED' using errcode='25001'; end if;
  perform 1 from public.social_posts where id=requested_post_id and author_id=actor and deleted_at is null for update;
  if not found then raise exception 'Post unavailable' using errcode='42501'; end if;
  extension:=case requested_mime when 'image/jpeg' then 'jpg' when 'image/png' then 'png' when 'image/webp' then 'webp' end;
  if extension is null or requested_size is null or requested_size not between 1 and 10485760 or requested_position is null or requested_position not between 0 and 9 then raise exception 'Invalid media' using errcode='22023'; end if;
  object_path:=actor::text||'/'||requested_post_id::text||'/'||requested_media_id::text||'.'||extension;
  if not exists(select 1 from storage.objects where bucket_id='social-post-media' and name=object_path and (metadata->>'size')::bigint=requested_size and metadata->>'mimetype'=requested_mime) then raise exception 'Upload unavailable' using errcode='22023'; end if;
  insert into public.social_post_media(id,post_id,author_id,storage_path,mime_type,size_bytes,position) values(requested_media_id,requested_post_id,actor,object_path,requested_mime,requested_size,requested_position)
    on conflict(post_id,position) do update set id=excluded.id,storage_path=excluded.storage_path,mime_type=excluded.mime_type,size_bytes=excluded.size_bytes,width=null,height=null;
  return true;
end $$;
create or replace function public.remove_social_post_media(requested_post_id uuid, requested_media_id uuid)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare item public.social_posts%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if current_setting('transaction_isolation') <> 'read committed' then raise exception 'Media writes require READ COMMITTED' using errcode='25001'; end if;
  select * into item from public.social_posts where id=requested_post_id and author_id=auth.uid() and deleted_at is null for update;
  if not found then raise exception 'Post unavailable' using errcode='42501'; end if;
  if item.post_type='blog' and item.published_at is not null and exists(select 1 from public.social_post_media where id=requested_media_id and post_id=item.id and position=0) then raise exception 'Published cover required' using errcode='22023'; end if;
  delete from public.social_post_media where id=requested_media_id and post_id=item.id;
  return true;
end $$;
-- Correct existing folder-depth contract: user/post/file has two folders.
create or replace function public.owns_social_post_storage(requested_post_id text)
returns boolean language sql stable security definer set search_path='' as $$
  select auth.uid() is not null and exists(select 1 from public.social_posts where id::text=requested_post_id and author_id=auth.uid());
$$;
revoke all on function public.owns_social_post_storage(text) from public,anon,authenticated;
grant execute on function public.owns_social_post_storage(text) to authenticated;
drop policy if exists social_post_media_insert_owned on storage.objects;
create policy social_post_media_insert_owned on storage.objects for insert to authenticated with check (
  bucket_id='social-post-media' and (storage.foldername(name))[1]=auth.uid()::text
  and cardinality(storage.foldername(name))=2 and (storage.foldername(name))[2] ~ '^[0-9a-f-]{36}$'
  and public.owns_social_post_storage((storage.foldername(name))[2])
);
drop policy if exists social_post_media_select_owned on storage.objects;
create policy social_post_media_select_owned on storage.objects for select to authenticated using (
  bucket_id='social-post-media' and (storage.foldername(name))[1]=auth.uid()::text
  and public.owns_social_post_storage((storage.foldername(name))[2])
);
-- Published blog cover must not be deletable via direct Storage API; deletion must go
-- through remove_social_post_media which enforces Published cover required.
-- The delete policy preserves draft/abandoned/ordinary cleanup while blocking
-- deletion of storage_path tied to a published blog's position=0 media.
drop policy if exists social_post_media_delete_owned on storage.objects;
create policy social_post_media_delete_owned on storage.objects for delete to authenticated using (
  bucket_id='social-post-media'
  and (storage.foldername(name))[1]=auth.uid()::text
  and not exists (
    select 1 from public.social_posts p
    join public.social_post_media m on m.post_id=p.id and m.storage_path=name
    where p.author_id=auth.uid()
      and p.post_type='blog'
      and p.published_at is not null
      and p.deleted_at is null
      and m.position=0
  )
);

-- Explicit grants: private helpers cannot be called with fabricated row/actor data.
revoke all on function public.social_follow_block_cleanup() from public,anon,authenticated;
revoke all on function public.social_blog_cover_is_valid(uuid) from public,anon,authenticated;
revoke all on function public.social_phase4_source_available(public.social_posts) from public,anon,authenticated;
revoke all on function public.social_phase4_post_json(public.social_posts,public.profiles) from public,anon,authenticated;
-- can_view_social_post is an internal helper; it was previously revoked from public,anon
-- but remained executable by authenticated. Revoke from authenticated as well so only
-- SECURITY DEFINER contexts can use it with a supplied post row.
revoke all on function public.can_view_social_post(uuid,public.social_posts) from public,anon,authenticated;
revoke all on function public.follow_social_user(uuid),public.unfollow_social_user(uuid),public.get_social_follow_summary(uuid),public.list_social_followers(uuid,timestamptz,uuid,integer),public.list_social_following(uuid,timestamptz,uuid,integer),public.list_social_feed_phase4(text,uuid,text,text,timestamptz,uuid,integer),public.get_public_social_blog(uuid),public.get_social_post_phase4(uuid),public.discover_social_authors(text,text,uuid,integer),public.save_social_blog(uuid,text,text,bigint,text,boolean),public.register_social_post_media(uuid,uuid,text,bigint,integer),public.remove_social_post_media(uuid,uuid) from public,anon,authenticated;
grant execute on function public.follow_social_user(uuid),public.unfollow_social_user(uuid),public.list_social_followers(uuid,timestamptz,uuid,integer),public.list_social_following(uuid,timestamptz,uuid,integer),public.save_social_blog(uuid,text,text,bigint,text,boolean),public.register_social_post_media(uuid,uuid,text,bigint,integer),public.remove_social_post_media(uuid,uuid) to authenticated;
grant execute on function public.get_social_follow_summary(uuid),public.list_social_feed_phase4(text,uuid,text,text,timestamptz,uuid,integer),public.get_public_social_blog(uuid),public.get_social_post_phase4(uuid),public.discover_social_authors(text,text,uuid,integer) to anon,authenticated;

-- Phase 3 uses a partial unique index; its conflict target must include the predicate.
create or replace function public.notify_social_post_liked()
returns trigger language plpgsql security definer set search_path='' as $$
declare post_row public.social_posts%rowtype; actor uuid:=new.user_id;
begin
  select * into post_row from public.social_posts where id=new.post_id;
  if post_row.author_id=actor or not public.can_view_social_post(actor,post_row) then return new; end if;
  insert into public.social_notifications(recipient_user_id,actor_user_id,notification_type,post_id,source_key,metadata)
  values(post_row.author_id,actor,'social.post_liked',new.post_id,'post:'||new.post_id::text||':liked',jsonb_build_object('postType',post_row.post_type))
  on conflict(recipient_user_id,notification_type,source_key) where source_key is not null
    do update set actor_user_id=excluded.actor_user_id,read_at=null,created_at=now(),metadata=excluded.metadata;
  return new;
end $$;
revoke all on function public.notify_social_post_liked() from public,anon,authenticated;
commit;
