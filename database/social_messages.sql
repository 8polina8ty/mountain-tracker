-- Social System v1, Phase C. MANUAL DEPLOYMENT ONLY.
-- Apply after social_conversations.sql. Plain text only; no Realtime or attachments.

create table if not exists public.messages (
  id bigint generated always as identity primary key,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete restrict,
  body text not null,
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  constraint messages_body_length_check check (char_length(body) <= 4000),
  constraint messages_deleted_body_check check (deleted_at is null or body = '')
);

create index if not exists messages_conversation_cursor_idx on public.messages (conversation_id, id desc);
create index if not exists messages_sender_rate_idx on public.messages (sender_id, created_at desc);

do $constraints$
begin
  if not exists (select 1 from pg_catalog.pg_constraint where
    conrelid = 'public.conversation_members'::regclass
    and conname = 'conversation_members_last_read_message_fk') then
    alter table public.conversation_members
      add constraint conversation_members_last_read_message_fk
      foreign key (last_read_message_id) references public.messages(id) on delete set null;
  end if;
end
$constraints$;

alter table public.messages enable row level security;
drop policy if exists messages_member_select on public.messages;
create policy messages_member_select on public.messages for select to authenticated
  using (public.is_conversation_member(conversation_id));
revoke all on public.messages from public, anon;
grant select on public.messages to authenticated;

create or replace function public.send_message(requested_conversation_id uuid, message_body text)
returns table(id bigint, conversation_id uuid, sender_id uuid, body text, created_at timestamptz, edited_at timestamptz, deleted_at timestamptz)
language plpgsql volatile security definer set search_path = '' as $function$
#variable_conflict use_column
declare
  actor uuid := auth.uid();
  clean_body text := pg_catalog.regexp_replace(
    message_body,
    '^[[:space:]]+|[[:space:]]+$',
    '',
    'g'
  );
  counterpart uuid;
  low_id uuid;
  high_id uuid;
  friendship_id uuid;
begin
  if actor is null then raise exception 'Authentication is required.' using errcode = '42501'; end if;
  if requested_conversation_id is null or clean_body is null or clean_body = '' or char_length(clean_body) > 4000
    then raise exception 'Message unavailable.' using errcode = '22023'; end if;

  select case when c.direct_user_low_id = actor then c.direct_user_high_id else c.direct_user_low_id end,
         c.direct_user_low_id, c.direct_user_high_id
    into counterpart, low_id, high_id
  from public.conversations c
  join public.conversation_members mine on mine.conversation_id = c.id and mine.user_id = actor and mine.left_at is null
  where c.id = requested_conversation_id and c.kind = 'direct'
    and actor in (c.direct_user_low_id, c.direct_user_high_id)
    and exists (select 1 from public.conversation_members other
      where other.conversation_id = c.id and other.user_id <> actor and other.left_at is null)
  for share of c;
  if counterpart is null then raise exception 'Message unavailable.' using errcode = '22023'; end if;

  select f.id into friendship_id from public.friendships f
  where f.user_low_id = low_id and f.user_high_id = high_id for key share;
  if friendship_id is null then raise exception 'Message unavailable.' using errcode = '22023'; end if;
  if exists (select 1 from public.user_blocks b where
    (b.blocker_id = actor and b.blocked_id = counterpart) or
    (b.blocker_id = counterpart and b.blocked_id = actor)
  ) then raise exception 'Message unavailable.' using errcode = '22023'; end if;

  -- Serialize rate checks per sender so concurrent requests cannot all pass
  -- the same pre-insert count. This lock is transaction-scoped.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(actor::text, 0));
  if (select count(*) from public.messages m where m.sender_id = actor and m.created_at > now() - interval '10 seconds') >= 20
    or (select count(*) from public.messages m where m.sender_id = actor and m.created_at > now() - interval '1 hour') >= 300
    then raise exception 'Message unavailable.' using errcode = '54000'; end if;

  return query insert into public.messages as m (conversation_id, sender_id, body)
    values (requested_conversation_id, actor, clean_body)
    returning m.id, m.conversation_id, m.sender_id, m.body, m.created_at, m.edited_at, m.deleted_at;
  update public.conversations set updated_at = now() where public.conversations.id = requested_conversation_id;
end;
$function$;

create or replace function public.list_messages(requested_conversation_id uuid, result_limit integer default 50, before_message_id bigint default null)
returns table(id bigint, sender_id uuid, body text, created_at timestamptz, edited_at timestamptz, deleted_at timestamptz)
language plpgsql stable security definer set search_path = '' as $function$
begin
  if auth.uid() is null then raise exception 'Authentication is required.' using errcode = '42501'; end if;
  if requested_conversation_id is null or result_limit is null or result_limit < 1 or result_limit > 50
    then raise exception 'Invalid message request.' using errcode = '22023'; end if;
  if not public.is_conversation_member(requested_conversation_id)
    then raise exception 'Conversation unavailable.' using errcode = '42501'; end if;
  return query select m.id, m.sender_id,
    case when m.deleted_at is null then m.body else null end,
    m.created_at, m.edited_at, m.deleted_at
  from public.messages m where m.conversation_id = requested_conversation_id
    and (before_message_id is null or m.id < before_message_id)
  order by m.id desc limit result_limit;
end;
$function$;

create or replace function public.list_conversations(result_limit integer default 30, cursor_updated_at timestamptz default null, cursor_conversation_id uuid default null)
returns table(conversation_id uuid, counterpart_user_id uuid, counterpart_username text, counterpart_display_name text, counterpart_avatar_url text, last_message_id bigint, last_message_body text, last_message_sender_id uuid, last_message_created_at timestamptz, last_read_message_id bigint, messaging_availability text)
language plpgsql stable security definer set search_path = '' as $function$
begin
  if auth.uid() is null then raise exception 'Authentication is required.' using errcode = '42501'; end if;
  if result_limit is null or result_limit < 1 or result_limit > 30 or ((cursor_updated_at is null) <> (cursor_conversation_id is null))
    then raise exception 'Invalid conversation request.' using errcode = '22023'; end if;
  return query
  select c.id, p.id, p.username, p.display_name, p.avatar_url,
    lm.id, case when lm.deleted_at is null then lm.body else null end, lm.sender_id, lm.created_at,
    mine.last_read_message_id,
    case
      when exists (select 1 from public.user_blocks b where (b.blocker_id = auth.uid() and b.blocked_id = p.id) or (b.blocker_id = p.id and b.blocked_id = auth.uid())) then 'unavailable'
      when exists (select 1 from public.friendships f where f.user_low_id = c.direct_user_low_id and f.user_high_id = c.direct_user_high_id) then 'available'
      else 'friendship_required'
    end
  from public.conversation_members mine
  join public.conversations c on c.id = mine.conversation_id and c.kind = 'direct'
  join public.profiles p on p.id = case when c.direct_user_low_id = auth.uid() then c.direct_user_high_id else c.direct_user_low_id end
  left join lateral (select m.id, m.body, m.sender_id, m.created_at, m.deleted_at from public.messages m where m.conversation_id = c.id order by m.id desc limit 1) lm on true
  where mine.user_id = auth.uid()
    and (cursor_updated_at is null or (c.updated_at, c.id) < (cursor_updated_at, cursor_conversation_id))
  order by c.updated_at desc, c.id desc limit result_limit;
end;
$function$;

create or replace function public.mark_conversation_read(requested_conversation_id uuid, through_message_id bigint)
returns boolean language plpgsql volatile security definer set search_path = '' as $function$
declare actor uuid := auth.uid(); current_cursor bigint;
begin
  if actor is null then raise exception 'Authentication is required.' using errcode = '42501'; end if;
  select cm.last_read_message_id into current_cursor from public.conversation_members cm
    where cm.conversation_id = requested_conversation_id and cm.user_id = actor for update;
  if not found then raise exception 'Conversation unavailable.' using errcode = '42501'; end if;
  if not exists (select 1 from public.messages m where m.id = through_message_id and m.conversation_id = requested_conversation_id)
    then raise exception 'Message unavailable.' using errcode = '22023'; end if;
  if current_cursor is not null and through_message_id <= current_cursor then return false; end if;
  update public.conversation_members cm set last_read_message_id = through_message_id
    where cm.conversation_id = requested_conversation_id and cm.user_id = actor;
  return true;
end;
$function$;

create or replace function public.delete_message(requested_message_id bigint)
returns boolean language plpgsql volatile security definer set search_path = '' as $function$
begin
  if auth.uid() is null then raise exception 'Authentication is required.' using errcode = '42501'; end if;
  update public.messages set body = '', deleted_at = now()
  where id = requested_message_id and sender_id = auth.uid() and deleted_at is null;
  if not found then raise exception 'Message unavailable.' using errcode = '22023'; end if;
  return true;
end;
$function$;

revoke all on function public.send_message(uuid,text), public.list_messages(uuid,integer,bigint), public.list_conversations(integer,timestamptz,uuid), public.mark_conversation_read(uuid,bigint), public.delete_message(bigint) from public, anon;
grant execute on function public.send_message(uuid,text), public.list_messages(uuid,integer,bigint), public.list_conversations(integer,timestamptz,uuid), public.mark_conversation_read(uuid,bigint), public.delete_message(bigint) to authenticated;
