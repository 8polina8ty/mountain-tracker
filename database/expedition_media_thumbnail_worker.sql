-- Manual staging artifact. Install after the Phase 1 contract and leave scheduling off.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $worker_preflight$
begin
  if current_user <> 'postgres'
    or not has_table_privilege('service_role', 'public.expedition_projects', 'SELECT')
    or not has_table_privilege('service_role', 'public.expedition_project_shares', 'SELECT')
  then raise exception 'Expected existing project and share catalog access for the worker and backfill'; end if;
end;
$worker_preflight$;

create table expedition_media_private.thumbnail_worker_state (
  singleton boolean primary key default true check (singleton),
  lease_token uuid,
  lease_until timestamptz,
  project_after uuid,
  ready_after uuid,
  cleanup_after uuid,
  last_sweep_at timestamptz,
  check ((lease_token is null) = (lease_until is null))
);
insert into expedition_media_private.thumbnail_worker_state default values;
alter table expedition_media_private.thumbnail_worker_state enable row level security;
revoke all on expedition_media_private.thumbnail_worker_state from public, anon, authenticated, service_role;
grant select, update on expedition_media_private.thumbnail_worker_state to service_role;

-- One deployment-wide execution slot. A crashed invocation leaves a bounded lease.
-- Cursor updates commit with their sweeps, including when the HTTP result is lost.
create function public.expedition_thumbnail_worker_acquire()
returns uuid
language plpgsql volatile security invoker set search_path = '' as $function$
declare
  worker expedition_media_private.thumbnail_worker_state%rowtype;
  ready_cursor uuid;
  cleanup_cursor uuid;
begin
  if not expedition_media_private.thumbnail_derivative_bucket_supported() then
    raise exception 'Thumbnail derivative bucket is unavailable or unsupported' using errcode = '55000';
  end if;
  update expedition_media_private.thumbnail_worker_state w
  set lease_token = gen_random_uuid(), lease_until = clock_timestamp() + interval '120 seconds'
  where w.singleton and (w.lease_until is null or w.lease_until <= clock_timestamp())
  returning w.* into worker;
  if not found then return null; end if;
  select r.next_after into ready_cursor from public.expedition_thumbnail_reconcile_ready(worker.ready_after, 16) r;
  select c.next_after into cleanup_cursor from public.expedition_thumbnail_reconcile_cleanup(worker.cleanup_after, 24) c;
  update expedition_media_private.thumbnail_worker_state w
  set ready_after = ready_cursor, cleanup_after = cleanup_cursor, last_sweep_at = clock_timestamp()
  where w.singleton;
  return worker.lease_token;
end;
$function$;

create function public.expedition_thumbnail_worker_claim(p_token uuid, p_supported_version integer)
returns table (
  media_id uuid, project_id uuid, attempt_id uuid, processing_version smallint, lease_until timestamptz,
  source_path text, source_mime text, source_size bigint, source_object_id uuid, source_version text, derivative_key text
)
language plpgsql volatile security invoker set search_path = '' as $function$
declare
  cursor_id uuid;
  next_project uuid;
  scanned integer := 0;
begin
  if p_supported_version is null or p_supported_version not in (1, 2) then
    raise exception 'Unsupported thumbnail worker version' using errcode = '22023';
  end if;
  select w.project_after into cursor_id from expedition_media_private.thumbnail_worker_state w
  where w.singleton and w.lease_token = p_token and w.lease_until > clock_timestamp()
  for update;
  if not found then return; end if;
  -- Bound the scan even if there are many projects without photos. Advance
  -- past saturated projects and resume after the last examined project.
  for next_project in
    select p.id from public.expedition_projects p
    where p.id >= coalesce(cursor_id, '00000000-0000-0000-0000-000000000000'::uuid)
      and p.id is distinct from cursor_id
    order by p.id limit 16
  loop
    scanned := scanned + 1;
    update expedition_media_private.thumbnail_worker_state w set project_after = next_project where w.singleton;
    return query select c.* from public.expedition_thumbnail_claim(1, 90, p_supported_version, next_project) c;
    if found then return; end if;
  end loop;
  if scanned < 16 then
    update expedition_media_private.thumbnail_worker_state w set project_after = null where w.singleton;
  end if;
end;
$function$;

create function public.expedition_thumbnail_worker_may_remove(p_attempt_id uuid, p_lease_token uuid)
returns boolean
language sql volatile security invoker set search_path = '' as $function$
  select expedition_media_private.thumbnail_derivative_bucket_supported() and exists (
    select from expedition_media_private.thumbnail_cleanup c
    where c.attempt_id = p_attempt_id and c.lease_token = p_lease_token
      and c.state = 'processing' and c.lease_until > clock_timestamp()
      and expedition_media_private.thumbnail_cleanup_storage_state(c.object_key) = 'current'
  );
$function$;

create function public.expedition_thumbnail_worker_release(p_token uuid)
returns boolean
language plpgsql volatile security invoker set search_path = '' as $function$
begin
  update expedition_media_private.thumbnail_worker_state w set lease_token = null, lease_until = null
  where w.singleton and w.lease_token = p_token and w.lease_until > clock_timestamp();
  return found;
end;
$function$;

-- Fetch only on demand. Reporting uses aggregate counts and timestamps.
create function public.expedition_thumbnail_worker_metrics()
returns jsonb
language sql stable security invoker set search_path = '' as $function$
  select jsonb_build_object(
    'bucket_supported', expedition_media_private.thumbnail_derivative_bucket_supported(),
    'last_sweep_at', (select w.last_sweep_at from expedition_media_private.thumbnail_worker_state w),
    'generation', (select jsonb_build_object(
      'pending', count(*) filter (where t.state = 'pending'),
      'failed', count(*) filter (where t.state = 'failed'),
      'expired', count(*) filter (where t.state = 'processing' and t.lease_until <= statement_timestamp()),
      'oldest_due_at', min(t.available_at) filter (where t.state = 'pending' and t.available_at <= statement_timestamp())
    ) from expedition_media_private.thumbnails t),
    'cleanup', (select jsonb_build_object(
      'pending', count(*) filter (where c.state = 'pending'),
      'failed', count(*) filter (where c.state = 'failed'),
      'expired', count(*) filter (where c.state = 'processing' and c.lease_until <= statement_timestamp()),
      'oldest_due_at', min(c.available_at) filter (where c.state = 'pending' and c.available_at <= statement_timestamp())
    ) from expedition_media_private.thumbnail_cleanup c)
  );
$function$;

-- The staging CLI pages canonical rows in two passes. Bound the selection
-- before filtering so even a sparse published cohort has a fixed scan budget.
create function public.expedition_thumbnail_backfill_page(p_after uuid, p_published boolean, p_apply boolean)
returns jsonb
language plpgsql volatile security invoker set search_path = '' as $function$
declare
  candidate record;
  next_after uuid;
  scanned integer := 0;
  photos integer := 0;
  ready integer := 0;
  pending integer := 0;
  failed integer := 0;
  unqueued integer := 0;
  enqueued integer := 0;
  missing integer := 0;
  invalid integer := 0;
  unavailable integer := 0;
  stale integer := 0;
  source_status text;
begin
  if p_published is null or p_apply is null then
    raise exception 'Specify a published pass and an apply mode' using errcode = '22023';
  end if;
  for candidate in
    with page as materialized (
      select m.id, m.project_id, m.media_type from public.expedition_project_journal_media m
      where m.id >= coalesce(p_after, '00000000-0000-0000-0000-000000000000'::uuid)
        and m.id is distinct from p_after
      order by m.id limit 64
    )
    select p.*, t.state, exists (select from public.expedition_project_shares s
      where s.project_id = p.project_id and s.is_enabled) as published
    from page p left join expedition_media_private.thumbnails t on t.media_id = p.id
    order by p.id
  loop
    scanned := scanned + 1;
    next_after := candidate.id;
    if candidate.media_type <> 'photo' or candidate.published <> p_published then continue; end if;
    photos := photos + 1;
    select s.status into source_status from expedition_media_private.inspect_thumbnail_source(candidate.id) s;
    missing := missing + case when source_status is null or source_status = 'source_missing' then 1 else 0 end;
    invalid := invalid + case when source_status = 'invalid_source' then 1 else 0 end;
    unavailable := unavailable + case when source_status = 'source_unavailable' then 1 else 0 end;
    case
      when candidate.state = 'ready' then
        if exists (select from public.expedition_thumbnail_lookup(candidate.project_id, candidate.id))
        then ready := ready + 1; else stale := stale + 1; end if;
      when candidate.state = 'failed' then failed := failed + 1;
      when candidate.state in ('pending', 'processing') then pending := pending + 1;
      else
        unqueued := unqueued + 1;
        if p_apply and source_status = 'verified' then
          if public.expedition_thumbnail_enqueue(candidate.project_id, candidate.id) then
            enqueued := enqueued + 1;
          end if;
        end if;
    end case;
  end loop;
  return jsonb_build_object('next_after', case when scanned = 64 then next_after end,
    'scanned', scanned, 'photos', photos, 'ready', ready, 'pending', pending, 'failed', failed,
    'unqueued', unqueued, 'enqueued', enqueued, 'missing', missing, 'invalid', invalid,
    'unavailable', unavailable, 'stale', stale);
end;
$function$;

revoke all on function public.expedition_thumbnail_worker_acquire(),
  public.expedition_thumbnail_worker_claim(uuid, integer), public.expedition_thumbnail_worker_may_remove(uuid, uuid),
  public.expedition_thumbnail_worker_release(uuid), public.expedition_thumbnail_worker_metrics(),
  public.expedition_thumbnail_backfill_page(uuid, boolean, boolean)
from public, anon, authenticated, service_role;
grant execute on function public.expedition_thumbnail_worker_acquire(),
  public.expedition_thumbnail_worker_claim(uuid, integer), public.expedition_thumbnail_worker_may_remove(uuid, uuid),
  public.expedition_thumbnail_worker_release(uuid), public.expedition_thumbnail_worker_metrics(),
  public.expedition_thumbnail_backfill_page(uuid, boolean, boolean)
to service_role;

notify pgrst, 'reload schema';
commit;
