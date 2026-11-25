-- Social Feed Phase 3: Notifications + Mentions (manual deployment)
-- Apply after social_feed_phase2.sql
begin;

-- Mentions tables
create table if not exists public.social_post_mentions (
  post_id uuid not null references public.social_posts(id) on delete cascade,
  mentioned_user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, mentioned_user_id)
);
create table if not exists public.social_comment_mentions (
  comment_id uuid not null references public.social_post_comments(id) on delete cascade,
  mentioned_user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (comment_id, mentioned_user_id)
);

-- Social notifications
create table if not exists public.social_notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  actor_user_id uuid not null references auth.users(id) on delete cascade,
  notification_type text not null check (notification_type in ('social.post_liked','social.post_commented','social.mentioned_in_post','social.mentioned_in_comment')),
  post_id uuid references public.social_posts(id) on delete set null,
  comment_id uuid references public.social_post_comments(id) on delete set null,
  source_key text,
  metadata jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  constraint social_notifications_not_self check (recipient_user_id <> actor_user_id),
  constraint social_notifications_metadata_object check (jsonb_typeof(metadata)='object'),
  constraint social_notifications_metadata_size check (octet_length(metadata::text) <= 1024)
);
create unique index if not exists social_notifications_source_recipient_idx on public.social_notifications(recipient_user_id, notification_type, source_key) where source_key is not null;
create index if not exists social_notifications_inbox_idx on public.social_notifications(recipient_user_id, created_at desc, id desc);
create index if not exists social_notifications_unread_idx on public.social_notifications(recipient_user_id) where read_at is null;

alter table public.social_notifications enable row level security;
alter table public.social_post_mentions enable row level security;
alter table public.social_comment_mentions enable row level security;
drop policy if exists social_notifications_recipient_select on public.social_notifications;
create policy social_notifications_recipient_select on public.social_notifications for select to authenticated using (recipient_user_id = auth.uid());
drop policy if exists social_post_mentions_no_direct on public.social_post_mentions;
create policy social_post_mentions_no_direct on public.social_post_mentions for all to authenticated using (false) with check (false);
drop policy if exists social_comment_mentions_no_direct on public.social_comment_mentions;
create policy social_comment_mentions_no_direct on public.social_comment_mentions for all to authenticated using (false) with check (false);
revoke all on public.social_notifications, public.social_post_mentions, public.social_comment_mentions from public, anon;
grant select on public.social_notifications to authenticated;

-- Helper: extract mentions server-side (boundary-aware, PostgreSQL ARE compatible, no \b)
-- Grammar: (^|[^a-zA-Z0-9_.-])@([a-zA-Z0-9_.-]{3,20})($|[^a-zA-Z0-9_.-])
-- Must handle "@alex @maria" both, trailing delimiter not consumed for next leading check.
create or replace function public.extract_mentions(requested_body text)
returns text[] language plpgsql immutable set search_path='' as $function$
declare
  result text[] := '{}';
  body text := coalesce(requested_body,'');
  len int := char_length(body);
  i int;
  ch text;
  prev text;
  nxt text;
  username text;
  j int;
begin
  for i in 1..len loop
    if substring(body from i for 1) = '@' then
      if i > 1 then
        prev := substring(body from i-1 for 1);
        if prev ~ '[a-zA-Z0-9_.-]' then continue; end if;
      end if;
      username := '';
      for j in 1..20 loop
        if i + j > len then exit; end if;
        ch := substring(body from i + j for 1);
        if ch ~ '[a-zA-Z0-9_.-]' then
          username := username || ch;
        else
          exit;
        end if;
      end loop;
      if char_length(username) < 3 or char_length(username) > 20 then continue; end if;
      if substring(username from 1 for 1) ~ '[\\.-]' or substring(username from char_length(username) for 1) ~ '[\\.-]' then continue; end if;
      if i + 1 + char_length(username) <= len then
        nxt := substring(body from i + 1 + char_length(username) for 1);
        if nxt ~ '[a-zA-Z0-9_]' then continue; end if;
      end if;
      if not (username = any(result)) then
        result := array_append(result, username);
      end if;
    end if;
  end loop;
  return result;
end;$function$;

-- Mention helpers: resolve username to user_id with block/visibility checks, fail closed on ambiguous case
create or replace function public.resolve_mention_user(requested_username text)
returns uuid language plpgsql stable security definer set search_path='' as $function$
declare cnt int; uid uuid;
begin
  if requested_username is null or btrim(requested_username) = '' then return null; end if;
  select count(*) into cnt from public.profiles where lower(username)=lower(requested_username);
  if cnt <> 1 then return null; end if;
  select id into uid from public.profiles where lower(username)=lower(requested_username) limit 1;
  return uid;
end;$function$;

-- Triggers for notifications
create or replace function public.notify_social_post_liked()
returns trigger language plpgsql security definer set search_path='' as $function$
declare post_row public.social_posts%rowtype; actor uuid := new.user_id;
begin
  select * into post_row from public.social_posts where id=new.post_id;
  if post_row.deleted_at is not null then return new; end if;
  if post_row.author_id = actor then return new; end if;
  if public.is_blocked_either(actor, post_row.author_id) then return new; end if;
  if not (post_row.visibility='public' or (post_row.visibility='friends' and public.are_friends(actor, post_row.author_id))) then return new; end if;
  insert into public.social_notifications(recipient_user_id, actor_user_id, notification_type, post_id, source_key, metadata)
  values (post_row.author_id, actor, 'social.post_liked', new.post_id, 'post:'||new.post_id::text||':liked', jsonb_build_object('postType', post_row.post_type))
  on conflict (recipient_user_id, notification_type, source_key) do update set actor_user_id = excluded.actor_user_id, read_at = null, created_at = now(), metadata = excluded.metadata;
  return new;
end;$function$;

create or replace function public.notify_social_post_commented()
returns trigger language plpgsql security definer set search_path='' as $function$
declare post_row public.social_posts%rowtype; actor uuid := new.author_id;
begin
  select * into post_row from public.social_posts where id=new.post_id;
  if post_row.deleted_at is not null or new.deleted_at is not null then return new; end if;
  if post_row.author_id = actor then return new; end if;
  if public.is_blocked_either(actor, post_row.author_id) then return new; end if;
  if not (post_row.author_id=actor or post_row.visibility='public' or (post_row.visibility='friends' and public.are_friends(actor, post_row.author_id))) then return new; end if;
  insert into public.social_notifications(recipient_user_id, actor_user_id, notification_type, post_id, comment_id, source_key, metadata)
  values (post_row.author_id, actor, 'social.post_commented', new.post_id, new.id, 'comment:'||new.id::text, jsonb_build_object('postType', post_row.post_type))
  on conflict do nothing;
  return new;
end;$function$;

-- Mention processing on post/comment insert/update
create or replace function public.process_social_post_mentions()
returns trigger language plpgsql security definer set search_path='' as $function$
declare actor uuid := new.author_id; uname text; mentioned uuid; post_row public.social_posts%rowtype;
begin
  if tg_op='UPDATE' and old.body = new.body then return new; end if;
  delete from public.social_post_mentions where post_id=new.id;
  -- naive mention extraction: look for @username tokens
  for uname in select distinct unnest(public.extract_mentions(new.body)) loop
    select public.resolve_mention_user(uname) into mentioned;
    if mentioned is null or mentioned=actor then continue; end if;
    if public.is_blocked_either(actor, mentioned) then continue; end if;
    select * into post_row from public.social_posts where id=new.id;
    if not (post_row.visibility='public' or (post_row.visibility='friends' and public.are_friends(mentioned, post_row.author_id)) or post_row.author_id=mentioned) then continue; end if;
    insert into public.social_post_mentions(post_id, mentioned_user_id) values (new.id, mentioned) on conflict do nothing;
    if mentioned <> post_row.author_id then
      insert into public.social_notifications(recipient_user_id, actor_user_id, notification_type, post_id, source_key, metadata)
      values (mentioned, actor, 'social.mentioned_in_post', new.id, 'mention_post:'||new.id::text||':'||mentioned::text, jsonb_build_object('postType', post_row.post_type))
      on conflict do nothing;
    end if;
  end loop;
  return new;
end;$function$;

create or replace function public.process_social_comment_mentions()
returns trigger language plpgsql security definer set search_path='' as $function$
declare actor uuid := new.author_id; uname text; mentioned uuid; post_row public.social_posts%rowtype;
begin
  for uname in select distinct unnest(public.extract_mentions(new.body)) loop
    select public.resolve_mention_user(uname) into mentioned;
    if mentioned is null or mentioned=actor then continue; end if;
    if public.is_blocked_either(actor, mentioned) then continue; end if;
    select * into post_row from public.social_posts where id=new.post_id;
    if post_row.deleted_at is not null then continue; end if;
    if not (post_row.visibility='public' or (post_row.visibility='friends' and public.are_friends(mentioned, post_row.author_id)) or post_row.author_id=mentioned) then continue; end if;
    insert into public.social_comment_mentions(comment_id, mentioned_user_id) values (new.id, mentioned) on conflict do nothing;
    insert into public.social_notifications(recipient_user_id, actor_user_id, notification_type, post_id, comment_id, source_key, metadata)
    values (mentioned, actor, 'social.mentioned_in_comment', new.post_id, new.id, 'mention_comment:'||new.id::text||':'||mentioned::text, jsonb_build_object('postType', post_row.post_type))
    on conflict do nothing;
  end loop;
  -- dedupe: if post author was mentioned in this comment, suppress generic commented notification for same recipient
  if exists (select 1 from public.social_comment_mentions where comment_id=new.id and mentioned_user_id=post_row.author_id) then
    delete from public.social_notifications where recipient_user_id=post_row.author_id and notification_type='social.post_commented' and post_id=new.post_id and comment_id=new.id;
  end if;
  return new;
end;$function$;

drop trigger if exists social_post_liked_notify on public.social_post_likes;
create trigger social_post_liked_notify after insert on public.social_post_likes for each row execute function public.notify_social_post_liked();
drop trigger if exists social_post_commented_notify on public.social_post_comments;
create trigger social_post_commented_notify after insert on public.social_post_comments for each row execute function public.notify_social_post_commented();
drop trigger if exists social_post_mentions_trigger on public.social_posts;
create trigger social_post_mentions_trigger after insert or update of body on public.social_posts for each row execute function public.process_social_post_mentions();
drop trigger if exists social_comment_mentions_trigger on public.social_post_comments;
create trigger social_comment_mentions_trigger after insert on public.social_post_comments for each row execute function public.process_social_comment_mentions();

-- Unified listing: social notifications are hidden if blocked
create or replace function public.list_social_notifications(cursor_created_at timestamptz default null, cursor_id uuid default null, result_limit integer default 20)
returns table(id uuid, notification_type text, post_id uuid, comment_id uuid, actor_user_id uuid, actor_username text, actor_display_name text, actor_avatar_url text, metadata jsonb, read_at timestamptz, created_at timestamptz)
language sql stable security definer set search_path='' as $function$
  select n.id, n.notification_type, n.post_id, n.comment_id, n.actor_user_id, pr.username, pr.display_name, pr.avatar_url, n.metadata, n.read_at, n.created_at
  from public.social_notifications n
  join public.profiles pr on pr.id=n.actor_user_id
  left join public.social_posts p on p.id=n.post_id
  where n.recipient_user_id=auth.uid()
    and not public.is_blocked_either(auth.uid(), n.actor_user_id)
    and (p.id is null or p.deleted_at is null)
    and (cursor_created_at is null or (n.created_at, n.id) < (cursor_created_at, cursor_id))
  order by n.created_at desc, n.id desc
  limit least(greatest(coalesce(result_limit,20),1),50);
$function$;

create or replace function public.list_unified_notifications(cursor_created_at timestamptz default null, cursor_id uuid default null, result_limit integer default 20, filter_kind text default 'all')
returns table(id uuid, kind text, notification_type text, post_id uuid, comment_id uuid, project_id uuid, actor_username text, metadata jsonb, read_at timestamptz, created_at timestamptz, can_navigate boolean)
language sql stable security definer set search_path='' as $function$
  select * from (
    select n.id, 'social'::text as kind, n.notification_type, n.post_id, n.comment_id, null::uuid as project_id, pr.username as actor_username, n.metadata, n.read_at, n.created_at,
      case when n.post_id is not null and exists(select 1 from public.social_posts p where p.id=n.post_id and p.deleted_at is null and not public.is_blocked_either(auth.uid(), p.author_id) and (p.visibility='public' or p.author_id=auth.uid() or (p.visibility='friends' and public.are_friends(auth.uid(), p.author_id)))) then true else false end as can_navigate
    from public.social_notifications n join public.profiles pr on pr.id=n.actor_user_id where n.recipient_user_id=auth.uid() and (filter_kind='all' or filter_kind='social') and not public.is_blocked_either(auth.uid(), n.actor_user_id)
    union all
    select n.id, 'expedition'::text as kind, n.notification_type, null::uuid, null::uuid, n.project_id, pr.username, n.metadata, n.read_at, n.created_at,
      case when n.project_id is not null and exists(select 1 from public.expedition_projects p where p.id=n.project_id) then true else false end
    from public.expedition_project_notifications n join public.profiles pr on pr.id=n.actor_user_id where n.recipient_user_id=auth.uid() and (filter_kind='all' or filter_kind='expedition')
  ) u where (cursor_created_at is null or (u.created_at, u.id) < (cursor_created_at, cursor_id)) order by u.created_at desc, u.id desc limit least(greatest(coalesce(result_limit,20),1),50);
$function$;

create or replace function public.mark_social_notification_read(requested_notification_id uuid)
returns boolean language plpgsql volatile security definer set search_path='' as $function$
begin if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if; update public.social_notifications set read_at=coalesce(read_at, now()) where id=requested_notification_id and recipient_user_id=auth.uid(); return found; end;$function$;
create or replace function public.mark_all_social_notifications_read()
returns integer language plpgsql volatile security definer set search_path='' as $function$
declare changed integer; begin if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if; update public.social_notifications set read_at=now() where recipient_user_id=auth.uid() and read_at is null; get diagnostics changed=row_count; return changed; end;$function$;

-- Extend inbox summary
create or replace function public.get_social_inbox_summary()
returns jsonb language sql stable security definer set search_path='' as $function$
  with unread_by_conversation as (
    select cm.conversation_id,count(*)::integer unread_count from public.conversation_members cm join public.messages m on m.conversation_id=cm.conversation_id and m.id>coalesce(cm.last_read_message_id,0) and m.sender_id<>cm.user_id and m.deleted_at is null where cm.user_id=auth.uid() and cm.left_at is null group by cm.conversation_id
  ), message_summary as (
    select coalesce(sum(unread_count),0)::integer total,coalesce(jsonb_object_agg(conversation_id::text,unread_count),'{}'::jsonb) conversations from unread_by_conversation
  )
  select jsonb_build_object('totalUnreadMessages',message_summary.total,'unreadConversations',message_summary.conversations,'totalUnreadProjectNotifications',(select count(*)::integer from public.expedition_project_notifications n where n.recipient_user_id=auth.uid() and n.read_at is null),'totalUnreadSocialNotifications',(select count(*)::integer from public.social_notifications n where n.recipient_user_id=auth.uid() and n.read_at is null and not public.is_blocked_either(auth.uid(), n.actor_user_id)),'totalUnreadNotifications',(select count(*)::integer from public.expedition_project_notifications n where n.recipient_user_id=auth.uid() and n.read_at is null)+(select count(*)::integer from public.social_notifications n where n.recipient_user_id=auth.uid() and n.read_at is null and not public.is_blocked_either(auth.uid(), n.actor_user_id))) from message_summary;
$function$;

revoke all on function public.list_social_notifications(timestamptz,uuid,integer) from public, anon;
revoke all on function public.list_unified_notifications(timestamptz,uuid,integer,text) from public, anon;
revoke all on function public.mark_social_notification_read(uuid) from public, anon;
revoke all on function public.mark_all_social_notifications_read() from public, anon;
revoke all on function public.get_social_inbox_summary() from public, anon;
grant execute on function public.list_social_notifications(timestamptz,uuid,integer) to authenticated;
grant execute on function public.list_unified_notifications(timestamptz,uuid,integer,text) to authenticated;
grant execute on function public.mark_social_notification_read(uuid) to authenticated;
grant execute on function public.mark_all_social_notifications_read() to authenticated;
grant execute on function public.get_social_inbox_summary() to authenticated;

create or replace function public.get_social_post(requested_post_id uuid)
returns table(post_id uuid, author_id uuid, username text, display_name text, avatar_url text, body text, visibility text, post_type text, created_at timestamptz, updated_at timestamptz, like_count bigint, comment_count bigint, viewer_liked boolean)
language sql stable security definer set search_path='' as $unction$
  select p.id, p.author_id, pr.username, pr.display_name, pr.avatar_url, p.body, p.visibility, p.post_type, p.created_at, p.updated_at,
    (select count(*) from public.social_post_likes l where l.post_id=p.id),
    (select count(*) from public.social_post_comments c where c.post_id=p.id and c.deleted_at is null),
    exists(select 1 from public.social_post_likes l where l.post_id=p.id and l.user_id=auth.uid())
  from public.social_posts p
  join public.profiles pr on pr.id=p.author_id
  where p.id=requested_post_id
    and p.deleted_at is null
    and not public.is_blocked_either(auth.uid(), p.author_id)
    and (p.visibility='public' or p.author_id=auth.uid() or (p.visibility='friends' and public.are_friends(auth.uid(), p.author_id)))
  limit 1;
$unction$;
revoke all on function public.get_social_post(uuid) from public, anon;
grant execute on function public.get_social_post(uuid) to anon, authenticated;

commit;
