-- MANUAL STAGING ONLY. Run after Phase 4; never run against production.
-- Set the three UUIDs below to dedicated, existing test accounts with profiles.
-- This script changes data inside a transaction and always rolls it back.
begin;
set local statement_timeout='30s';
set local lock_timeout='5s';
select set_config('phase4.test_a','REPLACE_WITH_ACCOUNT_A_UUID',true);
select set_config('phase4.test_b','REPLACE_WITH_ACCOUNT_B_UUID',true);
select set_config('phase4.test_c','REPLACE_WITH_ACCOUNT_C_UUID',true);

do $$
declare
  a uuid:=current_setting('phase4.test_a')::uuid;
  b uuid:=current_setting('phase4.test_b')::uuid;
  c uuid:=current_setting('phase4.test_c')::uuid;
  draft uuid; private_id uuid; friends_id uuid; public_id uuid; media_id uuid:=gen_random_uuid();
  item jsonb; total integer; rejected boolean; before_count integer;
begin
  if a=b or a=c or b=c then raise exception 'Three distinct test users required'; end if;
  if (select count(*) from public.profiles where id in(a,b,c))<>3 then raise exception 'Test profiles missing'; end if;
  if public.are_friends(a,b) or public.is_blocked_either(a,b) then raise exception 'A/B must initially be unrelated'; end if;
  if exists(select 1 from public.social_follows where follower_user_id=a and followed_user_id=b)
     or exists(select 1 from public.social_notifications where recipient_user_id=b and actor_user_id=a and notification_type='social.user_followed') then
    raise exception 'Use fresh test accounts A/B for notification deduplication';
  end if;
  if has_table_privilege('authenticated','public.social_follows','INSERT') or has_table_privilege('authenticated','public.social_follows','UPDATE') or has_table_privilege('authenticated','public.social_follows','DELETE') then raise exception 'Direct follow writes granted'; end if;
  if has_function_privilege('anon','public.follow_social_user(uuid)','EXECUTE') then raise exception 'Anonymous follow granted'; end if;
  if has_function_privilege('anon','public.social_blog_cover_is_valid(uuid)','EXECUTE') or has_function_privilege('authenticated','public.social_blog_cover_is_valid(uuid)','EXECUTE') then raise exception 'Cover helper should not be directly callable'; end if;
  if has_function_privilege('anon','public.can_view_social_post(uuid,public.social_posts)','EXECUTE') or has_function_privilege('authenticated','public.can_view_social_post(uuid,public.social_posts)','EXECUTE') then raise exception 'can_view helper should not be directly callable'; end if;
  if not exists(select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='social_post_media_delete_owned' and pg_get_policydef(oid) like '%published_at%' and pg_get_policydef(oid) like '%position=0%') then raise exception 'Published cover Storage delete policy missing'; end if;
  if has_function_privilege('authenticated','public.remove_social_post_media(uuid,uuid)','EXECUTE') is distinct from true then raise exception 'remove_social_post_media grant missing'; end if;

  perform set_config('request.jwt.claim.sub',a::text,true);
  rejected:=false;
  begin perform public.follow_social_user(a); exception when sqlstate '22023' then rejected:=true; end;
  if not rejected then raise exception 'Self-follow allowed'; end if;
  perform public.follow_social_user(b);
  perform public.follow_social_user(b);
  select count(*) into total from public.social_follows where follower_user_id=a and followed_user_id=b;
  if total<>1 or public.are_friends(a,b) then raise exception 'Follow duplicate or friendship side effect'; end if;
  perform public.unfollow_social_user(b);
  perform public.unfollow_social_user(b);
  perform public.follow_social_user(b);
  select count(*) into total from public.social_notifications where recipient_user_id=b and actor_user_id=a and notification_type='social.user_followed';
  if total<>1 then raise exception 'Follow notification duplicated'; end if;
  if exists(select 1 from public.social_notifications where recipient_user_id=b and actor_user_id=a and notification_type='social.user_followed' and metadata<>'{}'::jsonb) then raise exception 'Follow metadata leaked content'; end if;

  perform set_config('request.jwt.claim.sub',b::text,true);
  private_id:=public.create_social_post('phase4 private fixture','private','note');
  friends_id:=public.create_social_post('phase4 friends fixture','friends','note');
  public_id:=public.create_social_post('phase4 public fixture','public','note');
  draft:=public.save_social_blog(null,'Phase 4 fixture','Public article body',null,null,false);
  if public.get_public_social_blog(draft) is not null then raise exception 'Draft was public'; end if;
  if exists(select 1 from public.list_social_feed_phase4('discover') p where (p->>'post_id')::uuid=draft) then raise exception 'Draft discovered'; end if;
  rejected:=false;
  begin perform public.save_social_blog(draft,'Phase 4 fixture','Body',null,null,true); exception when sqlstate '22023' then rejected:=true; end;
  if not rejected then raise exception 'Published without a cover'; end if;
  -- DB-only media row without a Storage object must not satisfy cover validation.
  -- Real Storage fixtures are not created in this rollback-only test; positive publication
  -- is verified manually via the application (upload cover -> register -> publish -> anon read).
  insert into public.social_post_media(id,post_id,author_id,storage_path,mime_type,size_bytes,position)
  values(media_id,draft,b,b::text||'/'||draft::text||'/'||media_id::text||'.png','image/png',1,0);
  rejected:=false;
  begin perform public.save_social_blog(draft,'Phase 4 fixture','Public article body',null,null,true); exception when sqlstate '22023' then rejected:=true; end;
  if not rejected then raise exception 'Published without a valid Storage object'; end if;
  if public.get_public_social_blog(draft) is not null then raise exception 'Draft became public without cover object'; end if;
  if exists(select 1 from public.list_social_feed_phase4('discover') p where (p->>'post_id')::uuid=draft) then raise exception 'Draft discovered without cover'; end if;
  if (select visibility from public.social_posts where id=draft) <> 'private' then raise exception 'Draft visibility changed without cover'; end if;
  if (select published_at from public.social_posts where id=draft) is not null then raise exception 'Draft published_at set without cover'; end if;
  if public.get_social_post_phase4(draft) is null then raise exception 'Owner lost private draft after failed publish'; end if;

  perform set_config('request.jwt.claim.sub',a::text,true);
  if public.get_social_post_phase4(private_id) is not null or public.get_social_post_phase4(friends_id) is not null then raise exception 'Following granted restricted post access'; end if;
  if exists(select 1 from public.list_social_feed_phase4('following') p where (p->>'post_id')::uuid in(private_id,friends_id)) then raise exception 'Following feed leaked restricted posts'; end if;
  if not exists(select 1 from public.list_social_feed_phase4('following') p where (p->>'post_id')::uuid=public_id) then raise exception 'Following feed missing public post'; end if;
  rejected:=false;
  begin perform public.save_social_blog(draft,'Hijacked','Hijacked',null,null,true); exception when sqlstate '42501' then rejected:=true; end;
  if not rejected then raise exception 'Non-owner edited blog'; end if;
  rejected:=false;
  begin perform public.delete_social_post(draft); exception when sqlstate '22023' then rejected:=true; end;
  if not rejected then raise exception 'Non-owner deleted blog'; end if;
  -- Also exercises the Phase 3 partial-index conflict repair on a public post.
  perform public.like_social_post(public_id);
  perform public.unlike_social_post(public_id);
  perform public.like_social_post(public_id);

  perform public.block_user(b);
  if exists(select 1 from public.social_follows where (follower_user_id=a and followed_user_id=b) or (follower_user_id=b and followed_user_id=a)) then raise exception 'Block retained follows'; end if;
  if public.get_social_follow_summary(b) is not null then raise exception 'Blocked follow summary exposed'; end if;
  if exists(select 1 from public.list_social_followers(b)) then raise exception 'Blocked followers exposed'; end if;
  if exists(select 1 from public.discover_social_authors() p where p.user_id=b) then raise exception 'Blocked author discovered'; end if;
  if public.get_public_social_blog(draft) is not null then raise exception 'Blocked blog exposed'; end if;
  rejected:=false;
  begin perform public.follow_social_user(b); exception when sqlstate '42501' then rejected:=true; end;
  if not rejected then raise exception 'Blocker can follow'; end if;
  perform set_config('request.jwt.claim.sub',b::text,true);
  rejected:=false;
  begin perform public.follow_social_user(a); exception when sqlstate '42501' then rejected:=true; end;
  if not rejected then raise exception 'Blocked user can follow'; end if;

  perform set_config('request.jwt.claim.sub','',true);
  if public.get_social_post_phase4(private_id) is not null or public.get_social_post_phase4(friends_id) is not null then raise exception 'Anonymous restricted access'; end if;
  if public.get_public_social_blog(draft) is not null then raise exception 'Anonymous saw private draft'; end if;
  if public.get_social_post_phase4(draft) is not null then raise exception 'Anonymous saw private draft via get_social_post_phase4'; end if;
  if exists(select 1 from public.list_social_feed_phase4('discover') p where (p->>'post_id')::uuid=draft) then raise exception 'Anonymous discovered private draft'; end if;
  -- Private draft must not leak storage paths; public visibility is verified manually after real Storage upload.
  if public.get_public_social_blog(private_id) is not null or public.get_public_social_blog(gen_random_uuid()) is not null then raise exception 'Guessed ID bypass'; end if;
  rejected:=false;
  begin perform public.follow_social_user(b); exception when sqlstate '42501' then rejected:=true; end;
  if not rejected then raise exception 'Anonymous followed'; end if;

  perform set_config('request.jwt.claim.sub',b::text,true);
  perform public.delete_social_post(draft);
  if public.get_public_social_blog(draft) is not null then raise exception 'Deleted blog exposed'; end if;
  if exists(select 1 from public.list_social_feed_phase4('discover') p where (p->>'post_id')::uuid=draft) then raise exception 'Deleted article discovered'; end if;
  raise notice 'Phase 4 database regressions passed; all fixtures will roll back';
end $$;
rollback;
