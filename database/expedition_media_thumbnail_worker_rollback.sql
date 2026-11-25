-- Manual staging rollback. Disable scheduler and worker and let leases drain first.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $worker_rollback$
begin
  if current_user <> 'postgres' then raise exception 'Run the worker rollback as postgres'; end if;
  if exists (select from expedition_media_private.thumbnail_worker_state where lease_until > clock_timestamp()) then
    raise exception 'Wait for the active thumbnail worker lease to drain';
  end if;
end;
$worker_rollback$;

drop function public.expedition_thumbnail_worker_acquire(),
  public.expedition_thumbnail_worker_claim(uuid, integer), public.expedition_thumbnail_worker_may_remove(uuid, uuid),
  public.expedition_thumbnail_worker_release(uuid), public.expedition_thumbnail_worker_metrics(),
  public.expedition_thumbnail_backfill_page(uuid, boolean, boolean);
drop table expedition_media_private.thumbnail_worker_state;

notify pgrst, 'reload schema';
commit;
