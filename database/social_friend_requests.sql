-- Social System v1, Phase B. Apply after social_profile_contract.sql.

create table if not exists public.friend_requests (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references auth.users(id) on delete cascade,
  addressee_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  cancelled_at timestamptz,
  constraint friend_requests_distinct_users check (requester_id <> addressee_id),
  constraint friend_requests_status_check check (status in ('pending','accepted','rejected','cancelled')),
  constraint friend_requests_timestamps_check check (
    (status = 'pending' and responded_at is null and cancelled_at is null) or
    (status in ('accepted','rejected') and responded_at is not null and cancelled_at is null) or
    (status = 'cancelled' and cancelled_at is not null and responded_at is null)
  )
);

create unique index if not exists friend_requests_one_pending_pair_idx
  on public.friend_requests (least(requester_id, addressee_id), greatest(requester_id, addressee_id))
  where status = 'pending';
create index if not exists friend_requests_addressee_pending_idx on public.friend_requests (addressee_id, created_at desc, id) where status = 'pending';
create index if not exists friend_requests_requester_pending_idx on public.friend_requests (requester_id, created_at desc, id) where status = 'pending';
create index if not exists friend_requests_pair_history_idx on public.friend_requests (least(requester_id, addressee_id), greatest(requester_id, addressee_id), created_at desc);

alter table public.friend_requests enable row level security;
drop policy if exists friend_requests_participant_select on public.friend_requests;
create policy friend_requests_participant_select on public.friend_requests for select to authenticated
  using (auth.uid() = requester_id or auth.uid() = addressee_id);
revoke all on public.friend_requests from public, anon;
grant select on public.friend_requests to authenticated;

