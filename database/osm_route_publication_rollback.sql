-- Phase 11 exact publication rollback contract.
-- REVIEW ONLY. DO NOT APPLY OR EXECUTE without separate explicit authorization.

begin;

create or replace function public.rollback_osm_route_publication(
  p_publication_idempotency_key text,
  p_expected_mountain_route_id bigint,
  p_expected_target_payload_hash text
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_publication public.osm_route_publication_provenance%rowtype;
  v_deleted bigint;
begin
  select * into strict v_publication
  from public.osm_route_publication_provenance
  where publication_idempotency_key = p_publication_idempotency_key
    and publication_status = 'ACTIVE'
  for update;
  if v_publication.mountain_route_id <> p_expected_mountain_route_id
    or v_publication.target_payload_hash <> p_expected_target_payload_hash
  then raise exception using errcode = '23514', message = 'PHASE11_ROLLBACK_IDENTITY_MISMATCH';
  end if;

  -- Both deletes are in this transaction. Any later FK reference to mountain_routes
  -- makes the second delete fail and restores the provenance delete automatically.
  delete from public.osm_route_publication_provenance
  where id = v_publication.id;
  delete from public.mountain_routes
  where id = v_publication.mountain_route_id;
  get diagnostics v_deleted = row_count;
  if v_deleted <> 1 then
    raise exception using errcode = '23514', message = 'PHASE11_ROLLBACK_ROUTE_NOT_DELETED';
  end if;
  return v_publication.mountain_route_id;
exception
  when no_data_found then
    raise exception using errcode = 'P0002', message = 'PHASE11_ROLLBACK_PUBLICATION_NOT_FOUND';
end;
$function$;

revoke all on function public.rollback_osm_route_publication(text, bigint, text)
  from public, anon, authenticated, service_role;
grant execute on function public.rollback_osm_route_publication(text, bigint, text)
  to service_role;

comment on function public.rollback_osm_route_publication(text, bigint, text) is
  'Exact fail-closed rollback of one Phase 11 pipeline publication; FK references abort the whole transaction.';

commit;
