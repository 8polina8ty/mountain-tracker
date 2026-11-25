// Finite in-memory PostgreSQL regression. No env loading, sockets or production access.
// Engine installation/run instructions are in database/auth_country_progress_review.md.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "../node_modules/.cache/auth-country-test/node_modules/@electric-sql/pglite/dist/index.js";

const db = new PGlite();
const ids = [1, 2, 3, 4, 5].map((n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`);
let assertions = 0;
async function actor(id, callback, role = "authenticated") {
  await db.exec(`begin; set local role ${role};`);
  try {
    await db.query("select set_config('request.jwt.claim.sub', $1, true)", [id ?? ""]);
    const result = await callback();
    await db.exec("commit");
    return result;
  } catch (error) { await db.exec("rollback"); throw error; }
}
async function rpc(name, args = []) {
  return (await db.query(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) as value`, args)).rows[0].value;
}
async function rejects(callback, message) {
  await assert.rejects(callback, message); assertions++;
}
function equal(actual, expected) { assert.deepEqual(actual, expected); assertions++; }

try {
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema storage;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public, auth, storage to anon, authenticated;
    create table auth.users (id uuid primary key, raw_user_meta_data jsonb default '{}');
    create table public.profiles (
      id uuid primary key references auth.users(id) on delete cascade, username text unique,
      display_name text, avatar_url text, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
    create index profiles_username_prefix_lower_idx on public.profiles(lower(username));
    create function public.handle_new_user() returns trigger language plpgsql security definer as $$ begin
      insert into public.profiles(id,username,display_name) values(new.id,new.raw_user_meta_data->>'username',new.raw_user_meta_data->>'username'); return new; end $$;
    create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();
    create table public.mountains(id bigint primary key,name text,name_de text,height double precision,country_code text);
    create table public.ascents(id bigint generated always as identity primary key,user_id uuid,mountain_id bigint references public.mountains(id));
    create table public.user_achievements(user_id uuid,achievement_id text);
    create table public.social_posts(id bigint generated always as identity,author_id uuid,body text);
    create table storage.objects(id bigint generated always as identity,owner_id text,name text);
    alter table public.profiles enable row level security;
    alter table public.ascents enable row level security;
    alter table public.social_posts enable row level security;
    alter table storage.objects enable row level security;
    create policy profiles_read on public.profiles for select to anon,authenticated using(true);
    create policy profiles_insert on public.profiles for insert to authenticated with check(id=auth.uid());
    create policy profiles_update on public.profiles for update to authenticated using(id=auth.uid()) with check(id=auth.uid());
    create policy own_ascents on public.ascents for all to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());
    create policy own_posts on public.social_posts for all to authenticated using(author_id=auth.uid()) with check(author_id=auth.uid());
    create policy own_storage on storage.objects for all to authenticated using(owner_id=auth.uid()::text) with check(owner_id=auth.uid()::text);
    grant select,insert,update,delete,truncate on public.profiles to anon,authenticated;
    grant select,insert,update,delete on public.ascents,public.social_posts,storage.objects to authenticated;
    grant usage on all sequences in schema public,storage to authenticated;
    create function public.fixture_create_post() returns void language sql security definer as $$
      insert into public.social_posts(author_id,body) values(auth.uid(),'fixture') $$;
    create function public.get_user_ranking() returns table(user_id uuid,username text,avatar_url text,ascents_count bigint,
      total_height double precision,highest_mountain_height double precision,highest_mountain_name text,achievements_count bigint)
    language sql security definer set search_path='public' as $$
      select p.id,p.username,p.avatar_url,
        (select count(distinct a.mountain_id) from public.ascents a where a.user_id=p.id),
        coalesce((select sum(m.height) from public.ascents a join public.mountains m on m.id=a.mountain_id where a.user_id=p.id),0),
        coalesce((select max(m.height) from public.ascents a join public.mountains m on m.id=a.mountain_id where a.user_id=p.id),0),
        (select m.name from public.ascents a join public.mountains m on m.id=a.mountain_id where a.user_id=p.id order by m.height desc,m.id limit 1),
        (select count(distinct a.achievement_id) from public.user_achievements a where a.user_id=p.id)
      from public.profiles p order by 4 desc,5 desc,6 desc,8 desc,2 asc $$;
  `);
  await db.query("insert into auth.users(id,raw_user_meta_data) values($1,'{\"username\":\"Alex\"}'),($2,'{\"username\":\"alex\"}')", [ids[0], ids[1]]);
  const rankingBefore = (await db.query("select pg_get_functiondef('public.get_user_ranking()'::regprocedure) as definition")).rows[0].definition;
  const artifact = await readFile(new URL("../database/auth_country_progress.sql", import.meta.url), "utf8");
  await db.exec(artifact);
  equal((await db.query("select pg_get_functiondef('public.get_user_ranking()'::regprocedure) as definition")).rows[0].definition, rankingBefore);
  equal((await db.query("select username,country_code,onboarding_required from public.profiles order by id")).rows,
    [{ username: "Alex", country_code: null, onboarding_required: false }, { username: "alex", country_code: null, onboarding_required: false }]);
  equal((await db.query("select has_table_privilege('anon','public.profiles','TRUNCATE') a, has_table_privilege('authenticated','public.profiles','TRUNCATE') b")).rows[0], { a: false, b: false });
  equal(await actor(ids[0], () => rpc("auth_country_can_write")), true);
  await actor(ids[0], () => db.query("update public.profiles set avatar_url='legacy-avatar',updated_at=now() where id=$1", [ids[0]]));
  equal((await db.query("select avatar_url from public.profiles where id=$1", [ids[0]])).rows[0].avatar_url, "legacy-avatar");
  await actor(ids[0], () => rpc("update_my_residence_country", ["DE"]));
  await actor(ids[1], () => rpc("update_my_residence_country", ["CH"]));
  equal(await actor(ids[0], () => rpc("is_profile_username_available", ["Alex"])), false); // multiple legacy case matches fail closed
  await db.query("insert into auth.users(id,raw_user_meta_data) values($1,'{\"username\":\"Alex\",\"country_code\":\"XX\"}'),($2,'{}'),($3,'{}')", [ids[2], ids[3], ids[4]]);
  equal((await db.query("select username,display_name,country_code,onboarding_required from public.profiles where id=$1", [ids[2]])).rows[0],
    { username: null, display_name: null, country_code: null, onboarding_required: true });
  await rejects(() => actor(ids[2], () => rpc("complete_user_profile", ["ALEX", "DE"])), /username_unavailable/);
  await rejects(() => actor(ids[2], () => rpc("complete_user_profile", ["valid_name", "XK"])), /country_invalid/);
  await rejects(() => actor(ids[2], () => rpc("complete_user_profile", ["invalid name", "DE"])), /username_invalid/);
  await rejects(() => actor(ids[2], () => db.query("update public.profiles set onboarding_required=false where id=$1", [ids[2]])), /profile_protected/);
  await rejects(() => actor(ids[2], () => db.query("update public.profiles set country_code='DE' where id=$1", [ids[2]])), /profile_protected/);
  await rejects(() => actor(ids[2], () => rpc("update_my_residence_country", ["DE"])), /profile_incomplete/);
  await rejects(() => actor(ids[2], () => rpc("fixture_create_post")), /profile_incomplete/);
  await rejects(() => actor(ids[2], () => db.query("insert into storage.objects(owner_id,name) values($1,'test')", [ids[2]])), /row-level security/);
  equal((await actor(ids[2], () => db.query("update public.profiles set avatar_url='spoof' where id=$1 returning id", [ids[0]]))).rows.length, 0);
  await rejects(() => actor(null, () => rpc("complete_user_profile", ["Anon", "DE"]), "anon"), /permission denied/);
  await rejects(() => actor(null, () => rpc("update_my_residence_country", ["DE"]), "anon"), /permission denied/);
  await rejects(() => actor(null, () => rpc("get_my_country_mountain_progress"), "anon"), /permission denied/);
  await rejects(() => actor(ids[2], () => rpc("complete_user_profile", [ids[0], "Name", "DE"])), /does not exist/);
  await db.query("update public.profiles set display_name='Meaningful name',avatar_url='avatar' where id=$1", [ids[2]]);
  await actor(ids[2], () => rpc("complete_user_profile", ["  Alpine  ", "DE"]));
  await actor(ids[2], () => rpc("complete_user_profile", ["Alpine", "DE"]));
  equal((await db.query("select id,username,display_name,avatar_url,country_code,onboarding_required from public.profiles where id=$1", [ids[2]])).rows[0],
    { id: ids[2], username: "Alpine", display_name: "Meaningful name", avatar_url: "avatar", country_code: "DE", onboarding_required: false });
  await rejects(() => actor(ids[2], () => rpc("complete_user_profile", ["Other", "CH"])), /profile_already_completed/);
  await rejects(() => actor(ids[3], () => rpc("complete_user_profile", ["alpine", "FR"])), /username_unavailable/);
  await actor(ids[3], () => rpc("complete_user_profile", ["French", "FR"]));
  await actor(ids[4], () => rpc("complete_user_profile", ["Empty", "AD"]));
  await actor(ids[2], () => rpc("fixture_create_post"));
  await actor(ids[2], () => db.query("insert into storage.objects(owner_id,name) values($1,'avatar')", [ids[2]]));
  await db.exec("insert into public.mountains values(1,'Germany Peak','Deutscher Gipfel',1000,'DE'),(2,'France Peak',null,2000,'FR'),(3,'Swiss Peak',null,3000,'CH'),(4,'Border extension',null,1000,'XK'),(5,'Unknown',null,1000,'ZZ'),(6,'Missing',null,1000,null)");
  await db.query("insert into public.ascents(user_id,mountain_id) values($1,1),($1,1),($1,2),($1,4),($1,5),($1,6),($2,2)", [ids[2], ids[3]]);
  const progress = await actor(ids[2], () => rpc("get_my_country_mountain_progress"));
  equal(progress, { countryCode: "DE", totalMountains: 1, climbedMountains: 1, remainingMountains: 0, progressPercent: 100 });
  const ranking = await actor(ids[2], () => rpc("get_my_country_ranking"));
  equal(ranking.items.some((r) => r.user_id === ids[3]), false);
  const rankedSelf = ranking.items.find((r) => r.user_id === ids[2]);
  const globalSelf = (await db.query("select * from public.get_user_ranking() where user_id=$1", [ids[2]])).rows[0];
  equal(rankedSelf.total_height, globalSelf.total_height);
  equal(rankedSelf.total_height, 7000); // includes France + repeated ascent; exact global SUM semantics
  equal(rankedSelf.ascents_count, Number(globalSelf.ascents_count));
  const beforeHistory = (await db.query("select count(*)::int n from public.ascents where user_id=$1", [ids[2]])).rows[0].n;
  await actor(ids[2], () => rpc("update_my_residence_country", ["CH"]));
  equal((await actor(ids[0], () => rpc("get_my_country_ranking"))).items.some((r) => r.user_id === ids[2]), false);
  equal((await actor(ids[1], () => rpc("get_my_country_ranking"))).items.some((r) => r.user_id === ids[2]), true);
  equal((await db.query("select count(*)::int n from public.ascents where user_id=$1", [ids[2]])).rows[0].n, beforeHistory);
  equal(await actor(ids[2], () => rpc("get_my_country_mountain_progress")), { countryCode: "CH", totalMountains: 1, climbedMountains: 0, remainingMountains: 1, progressPercent: 0 });
  equal(await actor(ids[4], () => rpc("get_my_country_mountain_progress")), { countryCode: "AD", totalMountains: 0, climbedMountains: 0, remainingMountains: 0, progressPercent: null });
  await db.exec("insert into public.mountains select n,'Peak '||n,null,n,'CH' from generate_series(10,74) n");
  const first = await actor(ids[2], () => rpc("list_my_country_mountains"));
  equal(first.items.length, 20);
  const second = await actor(ids[2], () => rpc("list_my_country_mountains", ["", null, null, "all", first.nextCursor, 20]));
  equal(second.items.some((m) => first.items.some((p) => p.id === m.id)), false);
  equal((await actor(ids[2], () => rpc("list_my_country_mountains", ["", null, null, "all", null, 500]))).items.length, 50);
  equal((await actor(ids[2], () => rpc("list_my_country_mountains", ["", null, null, "climbed"]))).items, []);
  equal((await actor(ids[2], () => rpc("list_my_country_mountains", ["%"]))).items, []); // literal, not wildcard
  await rejects(() => actor(ids[2], () => rpc("list_my_country_mountains", ["x".repeat(101)])), /filters_invalid/);
  await rejects(() => actor(ids[2], () => rpc("list_my_country_mountains", ["", 100, 50])), /filters_invalid/);
  await rejects(() => actor(ids[2], () => rpc("is_residence_country", ["XK"]).then((v) => { if (!v) throw new Error("unsupported"); })), /unsupported/);
  // A second deployment is additive/idempotent, without changing completion or country.
  await db.exec(artifact);
  equal((await db.query("select country_code,onboarding_required from public.profiles where id=$1", [ids[2]])).rows[0], { country_code: "CH", onboarding_required: false });
  console.log(`In-memory PostgreSQL auth/country regression passed (${assertions} assertions). No production database or OAuth was exercised. Multi-connection concurrency still requires manual staging verification.`);
} finally { await db.close(); }
