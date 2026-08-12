-- Social System v1, Phase B. Apply after social_friend_requests.sql.

create table if not exists public.friendships (
  id uuid primary key default gen_random_uuid(),
  user_low_id uuid not null references auth.users(id) on delete cascade,
  user_high_id uuid not null references auth.users(id) on delete cascade,
  created_from_request_id uuid references public.friend_requests(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint friendships_distinct_users check (user_low_id <> user_high_id),
  constraint friendships_canonical_pair check (user_low_id::text < user_high_id::text),
  constraint friendships_unique_pair unique (user_low_id, user_high_id)
);
create index if not exists friendships_high_user_idx on public.friendships (user_high_id, created_at desc, id);

alter table public.friendships enable row level security;
drop policy if exists friendships_participant_select on public.friendships;
create policy friendships_participant_select on public.friendships for select to authenticated
  using (auth.uid() = user_low_id or auth.uid() = user_high_id);
revoke all on public.friendships from public, anon;
grant select on public.friendships to authenticated;

