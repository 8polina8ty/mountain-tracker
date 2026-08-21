-- Expedition Projects Phase 1. MANUAL REVIEW AND DEPLOYMENT ONLY.
--
-- VERIFIED DEPLOYMENT PREREQUISITE:
-- The deployed public.mountains.id column is PostgreSQL bigint (int8).
-- All project mountain identifiers below deliberately use the compatible bigint type.

create table if not exists public.expedition_projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  description text,
  status text not null default 'planning',
  start_date date,
  end_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint expedition_projects_name_check
    check (char_length(btrim(name)) between 1 and 120),
  constraint expedition_projects_description_check
    check (description is null or char_length(description) <= 4000),
  constraint expedition_projects_status_check
    check (status in ('planning', 'ready', 'active', 'completed', 'archived')),
  constraint expedition_projects_date_pair_check
    check ((start_date is null) = (end_date is null)),
  constraint expedition_projects_date_order_check
    check (end_date is null or end_date >= start_date),
  constraint expedition_projects_date_span_check
    check (end_date is null or end_date - start_date < 60)
);

create table if not exists public.expedition_project_mountains (
  project_id uuid not null references public.expedition_projects(id) on delete cascade,
  mountain_id bigint not null references public.mountains(id) on delete restrict,
  sort_order integer not null default 0,
  added_at timestamptz not null default now(),
  primary key (project_id, mountain_id),
  constraint expedition_project_mountains_sort_order_check check (sort_order >= 0)
);

create table if not exists public.expedition_project_days (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.expedition_projects(id) on delete cascade,
  day_number integer not null,
  date date,
  title text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint expedition_project_days_project_id_id_unique unique (project_id, id),
  constraint expedition_project_days_number_unique
    unique (project_id, day_number) deferrable initially immediate,
  constraint expedition_project_days_number_check check (day_number >= 1),
  constraint expedition_project_days_title_check
    check (title is null or char_length(title) <= 160),
  constraint expedition_project_days_notes_check
    check (notes is null or char_length(notes) <= 8000)
);

-- project_id is deliberately repeated here so composite foreign keys can prove
-- both that the day belongs to the project and that the mountain is a member of
-- that same project. It prevents cross-project or non-member assignments in SQL.
create table if not exists public.expedition_project_day_mountains (
  project_day_id uuid not null,
  project_id uuid not null,
  mountain_id bigint not null,
  sort_order integer not null default 0,
  primary key (project_day_id, mountain_id),
  constraint expedition_project_day_mountains_day_fk
    foreign key (project_id, project_day_id)
    references public.expedition_project_days(project_id, id) on delete cascade,
  constraint expedition_project_day_mountains_membership_fk
    foreign key (project_id, mountain_id)
    references public.expedition_project_mountains(project_id, mountain_id) on delete cascade,
  constraint expedition_project_day_mountains_sort_order_check check (sort_order >= 0)
);

create table if not exists public.expedition_project_journal_entries (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.expedition_projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  entry_date timestamptz not null default now(),
  title text,
  body text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint expedition_project_journal_title_check
    check (title is null or char_length(title) <= 160),
  constraint expedition_project_journal_body_check
    check (char_length(btrim(body)) between 1 and 12000)
);

create index if not exists expedition_projects_user_updated_idx
  on public.expedition_projects (user_id, updated_at desc, id);
create index if not exists expedition_project_mountains_order_idx
  on public.expedition_project_mountains (project_id, sort_order, added_at, mountain_id);
create index if not exists expedition_project_days_order_idx
  on public.expedition_project_days (project_id, day_number, id);
create index if not exists expedition_project_day_mountains_order_idx
  on public.expedition_project_day_mountains (project_day_id, sort_order, mountain_id);
create index if not exists expedition_project_journal_order_idx
  on public.expedition_project_journal_entries (project_id, entry_date desc, id desc);

create or replace function public.set_expedition_updated_at()
returns trigger language plpgsql set search_path = '' as $function$
begin
  new.updated_at := now();
  return new;
end;
$function$;

drop trigger if exists expedition_projects_set_updated_at on public.expedition_projects;
create trigger expedition_projects_set_updated_at before update on public.expedition_projects
for each row execute function public.set_expedition_updated_at();
drop trigger if exists expedition_project_days_set_updated_at on public.expedition_project_days;
create trigger expedition_project_days_set_updated_at before update on public.expedition_project_days
for each row execute function public.set_expedition_updated_at();
drop trigger if exists expedition_project_journal_set_updated_at on public.expedition_project_journal_entries;
create trigger expedition_project_journal_set_updated_at before update on public.expedition_project_journal_entries
for each row execute function public.set_expedition_updated_at();

alter table public.expedition_projects enable row level security;
alter table public.expedition_project_mountains enable row level security;
alter table public.expedition_project_days enable row level security;
alter table public.expedition_project_day_mountains enable row level security;
alter table public.expedition_project_journal_entries enable row level security;

drop policy if exists expedition_projects_owner_all on public.expedition_projects;
create policy expedition_projects_owner_all on public.expedition_projects
for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists expedition_project_mountains_owner_all on public.expedition_project_mountains;
create policy expedition_project_mountains_owner_all on public.expedition_project_mountains
for all to authenticated
using (exists (select 1 from public.expedition_projects p where p.id = project_id and p.user_id = auth.uid()))
with check (exists (select 1 from public.expedition_projects p where p.id = project_id and p.user_id = auth.uid()));

drop policy if exists expedition_project_days_owner_all on public.expedition_project_days;
create policy expedition_project_days_owner_all on public.expedition_project_days
for all to authenticated
using (exists (select 1 from public.expedition_projects p where p.id = project_id and p.user_id = auth.uid()))
with check (exists (select 1 from public.expedition_projects p where p.id = project_id and p.user_id = auth.uid()));

drop policy if exists expedition_project_day_mountains_owner_all on public.expedition_project_day_mountains;
create policy expedition_project_day_mountains_owner_all on public.expedition_project_day_mountains
for all to authenticated
using (exists (select 1 from public.expedition_projects p where p.id = project_id and p.user_id = auth.uid()))
with check (exists (select 1 from public.expedition_projects p where p.id = project_id and p.user_id = auth.uid()));

drop policy if exists expedition_project_journal_owner_all on public.expedition_project_journal_entries;
create policy expedition_project_journal_owner_all on public.expedition_project_journal_entries
for all to authenticated
using (user_id = auth.uid() and exists (
  select 1 from public.expedition_projects p where p.id = project_id and p.user_id = auth.uid()
))
with check (user_id = auth.uid() and exists (
  select 1 from public.expedition_projects p where p.id = project_id and p.user_id = auth.uid()
));

revoke all on public.expedition_projects, public.expedition_project_mountains,
  public.expedition_project_days, public.expedition_project_day_mountains,
  public.expedition_project_journal_entries from public, anon;
grant select, insert, update, delete on public.expedition_projects,
  public.expedition_project_mountains, public.expedition_project_days,
  public.expedition_project_day_mountains, public.expedition_project_journal_entries
  to authenticated;

create or replace function public.create_expedition_project(
  requested_name text,
  requested_description text default null,
  requested_start_date date default null,
  requested_end_date date default null
) returns uuid language plpgsql volatile security definer set search_path = '' as $function$
declare
  actor uuid := auth.uid();
  clean_name text := btrim(requested_name);
  created_project_id uuid;
  day_count integer;
begin
  if actor is null then raise exception 'Authentication is required.' using errcode = '42501'; end if;
  if clean_name is null or char_length(clean_name) not between 1 and 120 then
    raise exception 'Project name must contain 1 to 120 characters.' using errcode = '22023';
  end if;
  if requested_description is not null and char_length(requested_description) > 4000 then
    raise exception 'Project description is too long.' using errcode = '22023';
  end if;
  if (requested_start_date is null) <> (requested_end_date is null) then
    raise exception 'Start and end dates must be provided together.' using errcode = '22023';
  end if;
  if requested_end_date < requested_start_date then
    raise exception 'End date must not precede start date.' using errcode = '22023';
  end if;
  day_count := case when requested_start_date is null then 0 else requested_end_date - requested_start_date + 1 end;
  if day_count > 60 then raise exception 'A project may contain at most 60 dated days.' using errcode = '22023'; end if;

  insert into public.expedition_projects (user_id, name, description, start_date, end_date)
  values (actor, clean_name, nullif(btrim(requested_description), ''), requested_start_date, requested_end_date)
  returning id into created_project_id;

  if day_count > 0 then
    insert into public.expedition_project_days (project_id, day_number, date)
    select created_project_id, offset_value + 1, requested_start_date + offset_value
    from generate_series(0, day_count - 1) as offset_value;
  end if;
  return created_project_id;
end;
$function$;

create or replace function public.remove_expedition_project_mountain(
  requested_project_id uuid,
  requested_mountain_id bigint
) returns boolean language plpgsql volatile security definer set search_path = '' as $function$
declare actor uuid := auth.uid(); removed boolean;
begin
  if actor is null then raise exception 'Authentication is required.' using errcode = '42501'; end if;
  perform 1 from public.expedition_projects p
    where p.id = requested_project_id and p.user_id = actor for update;
  if not found then raise exception 'Project not found.' using errcode = '42501'; end if;
  delete from public.expedition_project_mountains
    where project_id = requested_project_id and mountain_id = requested_mountain_id;
  removed := found;
  return removed;
end;
$function$;

create or replace function public.add_expedition_project_day(
  requested_project_id uuid,
  requested_title text default null,
  requested_notes text default null
) returns uuid language plpgsql volatile security definer set search_path = '' as $function$
declare actor uuid := auth.uid(); next_day_number integer; created_day_id uuid;
begin
  if actor is null then raise exception 'Authentication is required.' using errcode = '42501'; end if;
  perform 1 from public.expedition_projects p
    where p.id = requested_project_id and p.user_id = actor for update;
  if not found then raise exception 'Project not found.' using errcode = '42501'; end if;
  if requested_title is not null and char_length(requested_title) > 160 then
    raise exception 'Day title is too long.' using errcode = '22023';
  end if;
  if requested_notes is not null and char_length(requested_notes) > 8000 then
    raise exception 'Day notes are too long.' using errcode = '22023';
  end if;
  select coalesce(max(day_number), 0) + 1 into next_day_number
    from public.expedition_project_days where project_id = requested_project_id;
  if next_day_number > 60 then raise exception 'A project may contain at most 60 days.' using errcode = '22023'; end if;
  insert into public.expedition_project_days (project_id, day_number, date, title, notes)
  select requested_project_id, next_day_number,
    case when p.start_date is null then null else p.start_date + next_day_number - 1 end,
    nullif(btrim(requested_title), ''), nullif(btrim(requested_notes), '')
  from public.expedition_projects p where p.id = requested_project_id
  returning id into created_day_id;
  return created_day_id;
end;
$function$;

create or replace function public.delete_expedition_project_day(requested_day_id uuid)
returns boolean language plpgsql volatile security definer set search_path = '' as $function$
declare actor uuid := auth.uid(); owned_project_id uuid;
begin
  if actor is null then raise exception 'Authentication is required.' using errcode = '42501'; end if;
  select d.project_id into owned_project_id
  from public.expedition_project_days d join public.expedition_projects p on p.id = d.project_id
  where d.id = requested_day_id and p.user_id = actor for update of p;
  if owned_project_id is null then raise exception 'Project day not found.' using errcode = '42501'; end if;
  set constraints expedition_project_days_number_unique deferred;
  delete from public.expedition_project_days where id = requested_day_id;
  update public.expedition_project_days d set day_number = ranked.new_day_number
  from (
    select id, row_number() over (order by day_number, id)::integer as new_day_number
    from public.expedition_project_days where project_id = owned_project_id
  ) ranked where d.id = ranked.id;
  return true;
end;
$function$;

create or replace function public.reorder_expedition_project_days(
  requested_project_id uuid,
  requested_day_ids uuid[]
) returns boolean language plpgsql volatile security definer set search_path = '' as $function$
declare actor uuid := auth.uid(); actual_count integer;
begin
  if actor is null then raise exception 'Authentication is required.' using errcode = '42501'; end if;
  perform 1 from public.expedition_projects p
    where p.id = requested_project_id and p.user_id = actor for update;
  if not found then raise exception 'Project not found.' using errcode = '42501'; end if;
  select count(*) into actual_count from public.expedition_project_days where project_id = requested_project_id;
  if coalesce(array_length(requested_day_ids, 1), 0) <> actual_count
    or (select count(distinct item) from unnest(requested_day_ids) item) <> actual_count
    or exists (
      select 1 from unnest(requested_day_ids) item
      where not exists (select 1 from public.expedition_project_days d where d.project_id = requested_project_id and d.id = item)
    ) then raise exception 'Day order must contain every project day exactly once.' using errcode = '22023';
  end if;
  set constraints expedition_project_days_number_unique deferred;
  update public.expedition_project_days d set day_number = requested.ordinality::integer
  from unnest(requested_day_ids) with ordinality requested(id, ordinality)
  where d.id = requested.id and d.project_id = requested_project_id;
  return true;
end;
$function$;

revoke all on function public.set_expedition_updated_at(),
  public.create_expedition_project(text, text, date, date),
  public.remove_expedition_project_mountain(uuid, bigint),
  public.add_expedition_project_day(uuid, text, text),
  public.delete_expedition_project_day(uuid),
  public.reorder_expedition_project_days(uuid, uuid[]) from public, anon;
grant execute on function public.create_expedition_project(text, text, date, date),
  public.remove_expedition_project_mountain(uuid, bigint),
  public.add_expedition_project_day(uuid, text, text),
  public.delete_expedition_project_day(uuid),
  public.reorder_expedition_project_days(uuid, uuid[]) to authenticated;
