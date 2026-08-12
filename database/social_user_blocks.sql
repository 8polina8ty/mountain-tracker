-- Social System v1, Phase B. Apply after social_friendships.sql.
-- This final artifact creates blocks and all cross-table RPCs. Functions are
-- tightly bounded SECURITY DEFINER because table writes have no client RLS
-- policies. Every function derives the actor from auth.uid().

create table if not exists public.user_blocks (
  blocker_id uuid not null references auth.users(id) on delete cascade,
  blocked_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint user_blocks_distinct_users check (blocker_id <> blocked_id)
);
create index if not exists user_blocks_blocked_idx on public.user_blocks (blocked_id, blocker_id);
alter table public.user_blocks enable row level security;
drop policy if exists user_blocks_blocker_select on public.user_blocks;
create policy user_blocks_blocker_select on public.user_blocks for select to authenticated using (auth.uid() = blocker_id);
revoke all on public.user_blocks from public, anon;
grant select on public.user_blocks to authenticated;

create or replace function public.send_friend_request(requested_user_id uuid)
returns uuid language plpgsql volatile security definer set search_path = '' as $function$
declare actor uuid := auth.uid(); created_id uuid;
begin
  if actor is null then raise exception 'Authentication is required.' using errcode='42501'; end if;
  if requested_user_id is null or requested_user_id = actor then raise exception 'Request unavailable.' using errcode='22023'; end if;
  if not exists (select 1 from public.profiles where id=requested_user_id) then raise exception 'Request unavailable.' using errcode='22023'; end if;
  if exists (select 1 from public.user_blocks where (blocker_id=actor and blocked_id=requested_user_id) or (blocker_id=requested_user_id and blocked_id=actor)) then raise exception 'Request unavailable.' using errcode='22023'; end if;
  if exists (select 1 from public.friendships where user_low_id=least(actor::text,requested_user_id::text)::uuid and user_high_id=greatest(actor::text,requested_user_id::text)::uuid) then raise exception 'Request unavailable.' using errcode='22023'; end if;
  if (select count(*) from public.friend_requests where requester_id=actor and status='pending') >= 25 then raise exception 'Request limit reached.' using errcode='54000'; end if;
  if exists (select 1 from public.friend_requests where least(requester_id::text,addressee_id::text)=least(actor::text,requested_user_id::text) and greatest(requester_id::text,addressee_id::text)=greatest(actor::text,requested_user_id::text) and status='rejected' and responded_at > now()-interval '7 days') then raise exception 'Request unavailable.' using errcode='22023'; end if;
  insert into public.friend_requests(requester_id,addressee_id) values(actor,requested_user_id) returning id into created_id;
  return created_id;
exception when unique_violation then raise exception 'Request unavailable.' using errcode='23505';
end;$function$;

create or replace function public.respond_to_friend_request(request_id uuid, response text)
returns boolean language plpgsql volatile security definer set search_path='' as $function$
declare actor uuid:=auth.uid(); item public.friend_requests%rowtype; low_id uuid; high_id uuid;
begin
  if actor is null then raise exception 'Authentication is required.' using errcode='42501'; end if;
  if response not in ('accepted','rejected') then raise exception 'Invalid response.' using errcode='22023'; end if;
  select * into item from public.friend_requests where id=request_id for update;
  if not found or item.addressee_id<>actor or item.status<>'pending' then raise exception 'Request unavailable.' using errcode='22023'; end if;
  if exists(select 1 from public.user_blocks where (blocker_id=item.requester_id and blocked_id=item.addressee_id) or (blocker_id=item.addressee_id and blocked_id=item.requester_id)) then raise exception 'Request unavailable.' using errcode='22023'; end if;
  update public.friend_requests set status=response, responded_at=now() where id=item.id;
  if response='accepted' then low_id:=least(item.requester_id::text,item.addressee_id::text)::uuid; high_id:=greatest(item.requester_id::text,item.addressee_id::text)::uuid; insert into public.friendships(user_low_id,user_high_id,created_from_request_id) values(low_id,high_id,item.id) on conflict(user_low_id,user_high_id) do nothing; end if;
  return true;
end;$function$;

create or replace function public.cancel_friend_request(request_id uuid)
returns boolean language plpgsql volatile security definer set search_path='' as $function$
declare actor uuid:=auth.uid();
begin
  if actor is null then raise exception 'Authentication is required.' using errcode='42501'; end if;
  update public.friend_requests set status='cancelled',cancelled_at=now() where id=request_id and requester_id=actor and status='pending';
  if not found then raise exception 'Request unavailable.' using errcode='22023'; end if; return true;
end;$function$;

create or replace function public.remove_friend(requested_user_id uuid)
returns boolean language plpgsql volatile security definer set search_path='' as $function$
declare actor uuid:=auth.uid();
begin if actor is null then raise exception 'Authentication is required.' using errcode='42501'; end if;
  delete from public.friendships where user_low_id=least(actor::text,requested_user_id::text)::uuid and user_high_id=greatest(actor::text,requested_user_id::text)::uuid;
  return found; end;$function$;

create or replace function public.block_user(requested_user_id uuid)
returns boolean language plpgsql volatile security definer set search_path='' as $function$
declare actor uuid:=auth.uid(); low_id uuid; high_id uuid;
begin if actor is null then raise exception 'Authentication is required.' using errcode='42501'; end if; if requested_user_id is null or requested_user_id=actor then raise exception 'Block unavailable.' using errcode='22023'; end if;
  insert into public.user_blocks(blocker_id,blocked_id) values(actor,requested_user_id) on conflict do nothing;
  update public.friend_requests set status='cancelled',cancelled_at=now() where status='pending' and ((requester_id=actor and addressee_id=requested_user_id) or (requester_id=requested_user_id and addressee_id=actor));
  low_id:=least(actor::text,requested_user_id::text)::uuid; high_id:=greatest(actor::text,requested_user_id::text)::uuid; delete from public.friendships where user_low_id=low_id and user_high_id=high_id; return true; end;$function$;

create or replace function public.unblock_user(requested_user_id uuid)
returns boolean language plpgsql volatile security definer set search_path='' as $function$
declare actor uuid:=auth.uid(); begin if actor is null then raise exception 'Authentication is required.' using errcode='42501'; end if; delete from public.user_blocks where blocker_id=actor and blocked_id=requested_user_id; return found; end;$function$;

create or replace function public.get_friendship_state(requested_user_id uuid)
returns table(user_id uuid,username text,display_name text,avatar_url text,relationship_state text,request_id uuid,can_send_request boolean,can_cancel_request boolean,can_respond_to_request boolean,can_remove_friend boolean,can_unblock boolean)
language sql stable security definer set search_path='' as $function$
with actor as (select auth.uid() id), pending as (select fr.* from public.friend_requests fr,actor where fr.status='pending' and least(fr.requester_id::text,fr.addressee_id::text)=least(actor.id::text,requested_user_id::text) and greatest(fr.requester_id::text,fr.addressee_id::text)=greatest(actor.id::text,requested_user_id::text) limit 1), facts as (select exists(select 1 from public.user_blocks b,actor where (b.blocker_id=actor.id and b.blocked_id=requested_user_id) or (b.blocker_id=requested_user_id and b.blocked_id=actor.id)) blocked, exists(select 1 from public.user_blocks b,actor where b.blocker_id=actor.id and b.blocked_id=requested_user_id) own_block, exists(select 1 from public.friendships f,actor where f.user_low_id=least(actor.id::text,requested_user_id::text)::uuid and f.user_high_id=greatest(actor.id::text,requested_user_id::text)::uuid) friends)
select p.id,p.username,p.display_name,p.avatar_url,case when facts.blocked then 'blocked_or_unavailable' when facts.friends then 'friends' when pending.requester_id=(select id from actor) then 'outgoing_pending' when pending.addressee_id=(select id from actor) then 'incoming_pending' else 'none' end,pending.id,not facts.blocked and not facts.friends and pending.id is null,pending.requester_id=(select id from actor),pending.addressee_id=(select id from actor),facts.friends,facts.own_block from public.profiles p cross join facts left join pending on true where p.id=requested_user_id and (select id from actor) is not null;
$function$;

create or replace function public.search_public_users(search_text text,result_limit integer default 20,cursor_username text default null,cursor_user_id uuid default null)
returns table(user_id uuid,username text,display_name text,avatar_url text,relationship_state text,request_id uuid,can_send_request boolean,can_cancel_request boolean,can_respond_to_request boolean,can_remove_friend boolean,can_unblock boolean)
language sql stable security definer set search_path='' as $function$
select s.* from public.profiles p cross join lateral public.get_friendship_state(p.id) s where auth.uid() is not null and p.id<>auth.uid() and length(btrim(search_text))>=2 and (lower(p.username) like lower(btrim(search_text))||'%' or lower(coalesce(p.display_name,'')) like lower(btrim(search_text))||'%') and (cursor_username is null or (lower(p.username),p.id)>(lower(cursor_username),cursor_user_id)) order by (lower(p.username) like lower(btrim(search_text))||'%') desc,lower(p.username),p.id limit least(greatest(coalesce(result_limit,20),1),20);
$function$;

create or replace function public.list_friends(result_limit integer default 20,cursor_username text default null,cursor_user_id uuid default null)
returns table(user_id uuid,username text,display_name text,avatar_url text,relationship_state text,request_id uuid,can_send_request boolean,can_cancel_request boolean,can_respond_to_request boolean,can_remove_friend boolean,can_unblock boolean)
language sql stable security definer set search_path='' as $function$
select s.* from public.friendships f cross join lateral public.get_friendship_state(case when f.user_low_id=auth.uid() then f.user_high_id else f.user_low_id end) s where auth.uid() in(f.user_low_id,f.user_high_id) and (cursor_username is null or (lower(s.username),s.user_id)>(lower(cursor_username),cursor_user_id)) order by lower(s.username),s.user_id limit least(greatest(coalesce(result_limit,20),1),20);
$function$;

create or replace function public.list_friend_requests(direction text,result_limit integer default 20,cursor_created_at timestamptz default null,cursor_request_id uuid default null)
returns table(request_id uuid,user_id uuid,username text,display_name text,avatar_url text,created_at timestamptz)
language sql stable security definer set search_path='' as $function$
select fr.id,p.id,p.username,p.display_name,p.avatar_url,fr.created_at from public.friend_requests fr join public.profiles p on p.id=case when direction='incoming' then fr.requester_id else fr.addressee_id end where auth.uid() is not null and direction in('incoming','outgoing') and fr.status='pending' and ((direction='incoming' and fr.addressee_id=auth.uid()) or(direction='outgoing' and fr.requester_id=auth.uid())) and (cursor_created_at is null or (fr.created_at,fr.id)<(cursor_created_at,cursor_request_id)) order by fr.created_at desc,fr.id desc limit least(greatest(coalesce(result_limit,20),1),20);
$function$;

create or replace function public.list_blocked_users(result_limit integer default 20,cursor_username text default null,cursor_user_id uuid default null)
returns table(user_id uuid,username text,display_name text,avatar_url text,relationship_state text,request_id uuid,can_send_request boolean,can_cancel_request boolean,can_respond_to_request boolean,can_remove_friend boolean,can_unblock boolean)
language sql stable security definer set search_path='' as $function$
select s.* from public.user_blocks b cross join lateral public.get_friendship_state(b.blocked_id) s where b.blocker_id=auth.uid() and (cursor_username is null or(lower(s.username),s.user_id)>(lower(cursor_username),cursor_user_id)) order by lower(s.username),s.user_id limit least(greatest(coalesce(result_limit,20),1),20);
$function$;

revoke all on function
  public.send_friend_request(uuid),
  public.respond_to_friend_request(uuid,text),
  public.cancel_friend_request(uuid),
  public.remove_friend(uuid),
  public.block_user(uuid),
  public.unblock_user(uuid),
  public.get_friendship_state(uuid),
  public.search_public_users(text,integer,text,uuid),
  public.list_friends(integer,text,uuid),
  public.list_friend_requests(text,integer,timestamptz,uuid),
  public.list_blocked_users(integer,text,uuid)
from public, anon;

grant execute on function
  public.send_friend_request(uuid),
  public.respond_to_friend_request(uuid,text),
  public.cancel_friend_request(uuid),
  public.remove_friend(uuid),
  public.block_user(uuid),
  public.unblock_user(uuid),
  public.get_friendship_state(uuid),
  public.search_public_users(text,integer,text,uuid),
  public.list_friends(integer,text,uuid),
  public.list_friend_requests(text,integer,timestamptz,uuid),
  public.list_blocked_users(integer,text,uuid)
to authenticated;