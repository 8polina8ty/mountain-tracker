-- Social System v1, Phase C. MANUAL DEPLOYMENT ONLY.
-- Apply after all Phase B social artifacts and verified friendship/block behavior.

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'direct',
  created_by uuid not null references auth.users(id) on delete restrict,
  direct_user_low_id uuid references auth.users(id) on delete restrict,
  direct_user_high_id uuid references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint conversations_kind_check check (char_length(kind) between 1 and 32),
  constraint conversations_pair_shape_check check (
    (kind = 'direct' and direct_user_low_id is not null and direct_user_high_id is not null
      and direct_user_low_id <> direct_user_high_id
      and direct_user_low_id::text < direct_user_high_id::text)
    or
    (kind <> 'direct' and direct_user_low_id is null and direct_user_high_id is null)
  ),
  constraint conversations_direct_pair_unique unique (direct_user_low_id, direct_user_high_id)
);

create table if not exists public.conversation_members (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member',
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  last_read_message_id bigint,
  primary key (conversation_id, user_id),
  constraint conversation_members_role_check check (role = 'member')
);

create index if not exists conversation_members_user_active_idx
  on public.conversation_members (user_id, conversation_id) where left_at is null;
create index if not exists conversations_updated_cursor_idx
  on public.conversations (updated_at desc, id desc);

alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;

create or replace function public.is_conversation_member(requested_conversation_id uuid)
returns boolean language sql stable security definer set search_path = '' as $function$
  select auth.uid() is not null and exists (
    select 1 from public.conversation_members cm
    where cm.conversation_id = requested_conversation_id
      and cm.user_id = auth.uid()
  );
$function$;

drop policy if exists conversations_member_select on public.conversations;
create policy conversations_member_select on public.conversations for select to authenticated
  using (public.is_conversation_member(id));
drop policy if exists conversation_members_member_select
on public.conversation_members;

create policy conversation_members_member_select
on public.conversation_members
for select
to authenticated
using (
  user_id = auth.uid()
);
revoke all on public.conversations, public.conversation_members from public, anon;
grant select on public.conversations, public.conversation_members to authenticated;

create or replace function public.get_or_create_direct_conversation(requested_user_id uuid)
returns uuid language plpgsql volatile security definer set search_path = '' as $function$
declare
  actor uuid := auth.uid();
  low_id uuid;
  high_id uuid;
  friendship_id uuid;
  resolved_conversation_id uuid;
begin
  if actor is null then raise exception 'Authentication is required.' using errcode = '42501'; end if;
  if requested_user_id is null or requested_user_id = actor then raise exception 'Messaging unavailable.' using errcode = '22023'; end if;
  low_id := least(actor::text, requested_user_id::text)::uuid;
  high_id := greatest(actor::text, requested_user_id::text)::uuid;

  -- The relationship row is held through commit. Phase B remove/block deletes
  -- this row, so an in-flight send/create finishes before that change commits;
  -- after it commits, no new write can acquire a valid friendship row.
  select f.id into friendship_id from public.friendships f
  where f.user_low_id = low_id and f.user_high_id = high_id
  for key share;
  if friendship_id is null then raise exception 'Messaging unavailable.' using errcode = '22023'; end if;
  if exists (select 1 from public.user_blocks b where
    (b.blocker_id = actor and b.blocked_id = requested_user_id) or
    (b.blocker_id = requested_user_id and b.blocked_id = actor)
  ) then raise exception 'Messaging unavailable.' using errcode = '22023'; end if;

  insert into public.conversations (kind, created_by, direct_user_low_id, direct_user_high_id)
  values ('direct', actor, low_id, high_id)
  on conflict (direct_user_low_id, direct_user_high_id)
  do update set direct_user_low_id = excluded.direct_user_low_id
  returning id into resolved_conversation_id;

  insert into public.conversation_members (conversation_id, user_id)
  values (resolved_conversation_id, low_id), (resolved_conversation_id, high_id)
  on conflict (conversation_id, user_id) do update set left_at = null;

  return resolved_conversation_id;
end;
$function$;

revoke all on function public.is_conversation_member(uuid), public.get_or_create_direct_conversation(uuid) from public, anon;
grant execute on function public.is_conversation_member(uuid), public.get_or_create_direct_conversation(uuid) to authenticated;
