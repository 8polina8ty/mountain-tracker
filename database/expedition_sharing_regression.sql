-- MANUAL STAGING REGRESSION ONLY. See expedition_sharing_hardening_review.md.
-- All fixture writes, including activity triggers, are rolled back.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
-- Replace this unset default with your disposable staging expedition UUID.
set local mountain_tracker.sharing_test_project = '';

do $regression$
declare
  target uuid := nullif(current_setting('mountain_tracker.sharing_test_project'), '')::uuid;
  owner_uuid uuid;
  fixture_name text;
  actor uuid;
  should_enable boolean;
  original_links public.expedition_project_day_tracks[];
  result jsonb;
  slug text := replace(gen_random_uuid()::text, '-', '');
begin
  select p.user_id, p.name into owner_uuid, fixture_name
  from public.expedition_projects p where p.id = target and p.status = 'completed';
  if owner_uuid is null
    or exists (select 1 from public.expedition_project_shares where project_id = target)
    or not exists (select 1 from public.expedition_project_members where project_id = target and role = 'editor')
    or not exists (select 1 from public.expedition_project_members where project_id = target and role = 'viewer')
  then
    raise exception 'Use the dedicated completed staging fixture with no share and both member roles';
  end if;

  select array_agg(dt order by (ga.processing_status = 'ready') asc nulls first)
  into original_links
  from public.expedition_project_day_tracks dt
  join public.gps_activities ga on ga.id = dt.gps_activity_id and ga.user_id = dt.user_id
  where dt.project_id = target;
  if coalesce(cardinality(original_links), 0) <> 21
    or (select count(*) from unnest(original_links) l join public.gps_activities ga
        on ga.id = l.gps_activity_id and ga.user_id = l.user_id where ga.processing_status = 'ready') <> 1
  then
    raise exception 'Fixture needs 20 non-ready links and one ready link';
  end if;
  delete from public.expedition_project_day_tracks where project_id = target;
  insert into public.expedition_project_day_tracks
  select l.* from unnest(original_links[1:20]) l;

  perform set_config('request.jwt.claim.sub', owner_uuid::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', owner_uuid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  if public.can_enable_expedition_sharing(target) is distinct from false
    or public.set_expedition_sharing(target, false) is distinct from '{"enabled":false}'::jsonb
  then raise exception 'Non-ready evidence or owner absent-share behavior failed'; end if;
  begin
    perform public.set_expedition_sharing(target, true, slug);
    raise exception 'Enable accepted non-ready evidence';
  exception when insufficient_privilege then null;
  end;
  execute 'set local role none';

  insert into public.expedition_project_day_tracks
  select l.* from unnest(original_links[21:21]) l;
  execute 'set local role authenticated';
  if public.can_enable_expedition_sharing(target) is distinct from true then
    raise exception 'Ready evidence after 20 non-ready links was not recognized';
  end if;
  result := public.set_expedition_sharing(target, true, slug);
  if result is distinct from jsonb_build_object('enabled', true, 'slug', slug) then
    raise exception 'Eligible owner could not enable sharing';
  end if;
  execute 'set local role none';

  if has_function_privilege('anon', 'public.set_expedition_sharing(uuid,boolean,text)', 'execute')
    or has_function_privilege('authenticated', 'public.resolve_public_expedition_share(text)', 'execute')
    or has_function_privilege('anon', 'public.get_public_expedition_report(text)', 'execute')
    or not has_function_privilege('service_role', 'public.resolve_public_expedition_share(text)', 'execute')
  then raise exception 'Unexpected sharing or resolver grants'; end if;

  execute 'set local role service_role';
  if not exists (select 1 from public.resolve_public_expedition_share(slug) r where r.project_id = target)
    or public.get_public_expedition_report(slug)->>'name' is distinct from fixture_name
  then raise exception 'Eligible public slug did not resolve'; end if;
  execute 'set local role anon';
  if not exists (select 1 from public.search_public_expeditions(search_text => fixture_name) c where c.public_slug = slug)
  then raise exception 'Eligible share missing from anonymous discovery'; end if;
  execute 'set local role none';

  for actor in
    select m.user_id from public.expedition_project_members m where m.project_id = target
  loop
    perform set_config('request.jwt.claim.sub', actor::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', actor, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    if public.can_enable_expedition_sharing(target) is distinct from false then
      raise exception 'Non-owner can enable sharing';
    end if;
    foreach should_enable in array array[true, false] loop
      begin
        perform public.set_expedition_sharing(target, should_enable, slug);
        raise exception 'Non-owner changed sharing';
      exception when insufficient_privilege then null;
      end;
    end loop;
    update public.expedition_project_shares set is_enabled = false where project_id = target;
    if found then raise exception 'Non-owner reached share through table RLS'; end if;
    execute 'set local role none';
  end loop;

  perform set_config('request.jwt.claim.sub', owner_uuid::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', owner_uuid, 'role', 'authenticated')::text, true);
  delete from public.expedition_project_day_tracks where project_id = target;
  execute 'set local role authenticated';
  if public.set_expedition_sharing(target, false) is distinct from '{"enabled":false}'::jsonb
    or public.set_expedition_sharing(target, false) is distinct from '{"enabled":false}'::jsonb
  then raise exception 'Owner revocation without evidence or retry failed'; end if;
  execute 'set local role none';

  insert into public.expedition_project_day_tracks select l.* from unnest(original_links) l;
  if not exists (select 1 from public.expedition_project_shares s
    where s.project_id = target and s.public_slug = slug and not s.is_enabled)
  then raise exception 'Revocation did not persist after evidence restoration'; end if;
  execute 'set local role service_role';
  if exists (select 1 from public.resolve_public_expedition_share(slug))
    or public.get_public_expedition_report(slug) is not null
  then raise exception 'Revoked slug still opens the report or media resolver'; end if;
  execute 'set local role anon';
  if exists (select 1 from public.search_public_expeditions(search_text => fixture_name) c where c.public_slug = slug)
  then raise exception 'Revoked share is discoverable'; end if;
  execute 'set local role none';

  execute 'set local role authenticated';
  result := public.set_expedition_sharing(target, true, replace(gen_random_uuid()::text, '-', ''));
  if result is distinct from jsonb_build_object('enabled', true, 'slug', slug) then
    raise exception 'Explicit re-enable did not preserve the existing slug';
  end if;
  execute 'set local role none';
  update public.expedition_projects set status = 'active' where id = target;
  execute 'set local role authenticated';
  if public.can_enable_expedition_sharing(target) is distinct from false
    or public.set_expedition_sharing(target, false) is distinct from '{"enabled":false}'::jsonb
  then raise exception 'Owner could not revoke after status changed'; end if;
  execute 'set local role none';
  if not exists (select 1 from public.expedition_project_shares where project_id = target and not is_enabled)
  then raise exception 'Status change revocation did not persist'; end if;
end;
$regression$;
rollback;
