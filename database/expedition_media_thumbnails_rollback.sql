-- Manual staging rollback for the reviewed Phase 1 artifact.
-- Stop all thumbnail work and remove the empty derivative bucket through Storage first.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $rollback_guard$
begin
  if current_user <> 'postgres' then
    raise exception 'Run the thumbnail rollback as postgres';
  end if;
  if exists (select 1 from storage.buckets where id = 'expedition-media-thumbnails') then
    raise exception 'Remove the empty thumbnail bucket through Storage before rolling back SQL';
  end if;
end;
$rollback_guard$;

drop trigger expedition_thumbnail_enqueue_after_insert on public.expedition_project_journal_media;
drop trigger expedition_thumbnail_cancel_before_delete on public.expedition_project_journal_media;

drop function
  public.expedition_thumbnail_lookup(uuid, uuid),
  public.expedition_thumbnail_enqueue(uuid, uuid, boolean),
  public.expedition_thumbnail_claim(integer, integer, integer, uuid),
  public.expedition_thumbnail_reconcile_ready(uuid, integer),
  public.expedition_thumbnail_set_version(integer, integer),
  public.expedition_thumbnail_rollout_version(integer, integer),
  public.expedition_thumbnail_may_upload(uuid, uuid),
  public.expedition_thumbnail_complete(uuid, uuid, uuid, text, uuid, text, integer, integer, integer),
  public.expedition_thumbnail_fail(uuid, uuid, text, boolean),
  public.expedition_thumbnail_claim_cleanup(integer, integer),
  public.expedition_thumbnail_finish_cleanup(uuid, uuid),
  public.expedition_thumbnail_reconcile_cleanup(uuid, integer),
  public.expedition_thumbnail_retry_cleanup(uuid);

drop function
  expedition_media_private.thumbnail_source(uuid),
  expedition_media_private.inspect_thumbnail_source(uuid),
  expedition_media_private.current_storage_object(text, text),
  expedition_media_private.thumbnail_derivative_bucket_supported(),
  expedition_media_private.thumbnail_cleanup_storage_state(text),
  expedition_media_private.reset_thumbnail(uuid, smallint, uuid),
  expedition_media_private.thumbnail_media_lifecycle();

drop table
  expedition_media_private.thumbnails,
  expedition_media_private.thumbnail_cleanup,
  expedition_media_private.thumbnail_settings;
drop schema expedition_media_private;

drop policy expedition_media_thumbnails_server_only on storage.objects;
drop policy expedition_media_thumbnail_bucket_server_only on storage.buckets;

notify pgrst, 'reload schema';
commit;
