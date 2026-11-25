-- MANUAL DEPLOYMENT ONLY. Review mountain_countries_review.md first.
-- Additive multi-country membership for border peaks. No mountains rows are changed.
-- Expected ~364k insert rows on first apply; second apply is idempotent.

begin;
set local lock_timeout = '30s';
set local statement_timeout = '300s';

-- 1) Table
create table if not exists public.mountain_countries (
  mountain_id bigint not null references public.mountains(id) on delete cascade,
  country_code text not null check (country_code ~ '^[A-Z]{2}$'),
  is_primary boolean not null default false,
  source text null check (char_length(source) between 1 and 64),
  created_at timestamptz not null default now(),
  primary key (mountain_id, country_code)
);

-- 2) Indexes
create index if not exists mountain_countries_country_mountain_idx
  on public.mountain_countries (country_code, mountain_id);
-- mountain_id is already leading in PK; separate index for country lookups covers the country-scoped queries.

-- 3) Backfill primary membership from legacy mountains.country_code
--    Do not overwrite existing reviewed memberships. ~364k rows.
insert into public.mountain_countries (mountain_id, country_code, is_primary, source)
select m.id, m.country_code, true, 'legacy_country_code'
from public.mountains m
where m.country_code is not null
  and m.country_code ~ '^[A-Z]{2}$'
on conflict (mountain_id, country_code) do nothing;

-- 4) Grants / RLS — public reference data, read-only for app clients
alter table public.mountain_countries enable row level security;
do $pol$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='mountain_countries' and policyname='mountain_countries_select_all') then
    create policy mountain_countries_select_all on public.mountain_countries
      for select to anon, authenticated using (true);
  end if;
end $pol$;

revoke insert, update, delete, truncate on table public.mountain_countries from anon, authenticated;
grant select on table public.mountain_countries to anon, authenticated;

-- 5) Comment for discoverability
comment on table public.mountain_countries is 'Multi-country membership for mountains; legacy mountains.country_code remains primary country. Auth residence filtering uses EXISTS on this table.';

notify pgrst, 'reload schema';
commit;
