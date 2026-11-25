import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizeSocialPost } from "../Lib/socialFeed/normalize.ts";
import { parseDiscoverySearch, listPhase4Posts } from "../Lib/socialFeed/phase4.ts";
import { uploadSocialMedia } from "../Lib/socialFeed/media.ts";

const read = path => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const sql = await read("database/social_feed_phase4.sql");
const body = name => {
  const match = sql.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?as \\$\\$([\\s\\S]*?)\\$\\$;`));
  assert.ok(match, `Missing function ${name}`);
  return match[1];
};
const follow = body("follow_social_user");
assert.match(sql, /actor uuid := auth\.uid\(\)/);
for (const expected of ["actor is null", "actor=requested_user_id", "public.profiles", "is_blocked_either", "pg_advisory_xact_lock", "on conflict do nothing", "if inserted=1", "'{}'::jsonb"]) assert.ok(follow.includes(expected), expected);
assert.doesNotMatch(follow, /insert into public\.friendships/);
assert.doesNotMatch(body("unfollow_social_user"), /friendships|social_notifications/);
assert.match(sql, /primary key \(follower_user_id, followed_user_id\)/);
assert.match(sql, /revoke all on public.social_follows from public, anon, authenticated/);
assert.match(sql, /before insert on public.user_blocks/);
assert.match(body("social_follow_block_cleanup"), /pg_advisory_xact_lock[\s\S]*delete from public.social_follows/);
for (const name of ["list_social_followers", "list_social_following"]) {
  const fn = body(name);
  assert.match(fn, /auth.uid\(\) is not null/);
  assert.match(fn, /is_blocked_either\(auth.uid\(\),requested_user_id\)/);
  assert.match(fn, /order by f.created_at desc,p.id desc/);
  assert.match(fn, /limit least\(greatest\(coalesce\(result_limit,20\),1\),50\)/);
}
const visibility = body("can_view_social_post");
assert.match(visibility, /deleted_at is null/);
assert.match(visibility, /visibility='friends' and public.are_friends/);
assert.doesNotMatch(visibility, /social_follows/);
assert.doesNotMatch(visibility, /viewer is null/);
assert.match(body("get_public_social_blog"), /visibility='public' and p.published_at is not null and public.can_view_social_post/);
const feed = body("list_social_feed_phase4");
assert.match(feed, /public.can_view_social_post\(auth.uid\(\),p\)/);
assert.match(feed, /when 'following'.*social_follows/);
assert.match(feed, /when 'discover'.*visibility='public'.*source_available/);
assert.match(feed, /\(p.created_at,p.id\)<\(cursor_created_at,cursor_post_id\)/);
assert.match(feed, /left\(btrim\(search_text\),80\)/);
assert.doesNotMatch(feed, /execute |ilike/);
const save = body("save_social_blog");
assert.match(save, /author_id=actor and post_type='blog' and deleted_at is null for update/);
assert.match(save, /'blog','private'/);
assert.match(save, /is_social_expedition_available/);
const saveStripped = save.replace(/--.*$/gm, "");
assert.match(saveStripped, /social_blog_cover_is_valid/);
assert.match(saveStripped, /not public\.social_blog_cover_is_valid/);
assert.match(saveStripped, /Valid uploaded cover required/);
const coverHelper = body("social_blog_cover_is_valid");
const coverStripped = coverHelper.replace(/--.*$/gm, "");
assert.match(coverStripped, /m\.position\s*=\s*0/);
assert.match(coverStripped, /storage\.objects/);
assert.match(coverStripped, /metadata->>'mimetype'/);
assert.match(coverStripped, /metadata->>'size'/);
assert.doesNotMatch(body("social_phase4_post_json"), /storage_path|signed|gps_activities|image_url/);
assert.match(body("social_phase4_post_json"), /s.is_enabled and public.is_social_expedition_available/);
assert.match(body("register_social_post_media"), /author_id=actor.*for update/);
assert.match(body("register_social_post_media"), /storage.objects.*metadata->>'size'/);
assert.match(sql, /where source_key is not null\s+do update/);
assert.ok(sql.trimEnd().endsWith("commit;"));
assert.match(sql, /begin;/);
assert.match(sql, /create policy social_post_media_delete_owned[\s\S]*?published_at is not null[\s\S]*?m\.position\s*=\s*0/);
assert.doesNotMatch(sql, /grant truncate/i);
assert.match(sql, /revoke all on function public\.social_blog_cover_is_valid\(uuid\) from public,\s*anon,\s*authenticated/);
assert.match(sql, /revoke all on function public\.can_view_social_post\(uuid,public\.social_posts\) from public,\s*anon,\s*authenticated/);
assert.match(sql, /social_posts_post_type_check check \(post_type in \('note','photo','ascent','achievement','expedition','blog'\)\)/);
assert.match(sql, /social-post-media.*public=false/);

const id = "11111111-1111-4111-8111-111111111111";
const row = { post_id: id, author_id: id, username: "alpine", body: "a".repeat(20000), title: "Article", post_type: "blog", visibility: "public", published_at: "2026-09-01T00:00:00Z", created_at: "2026-09-01T00:00:00Z", media: [] };
assert.equal(normalizeSocialPost(row)?.body.length, 20000);
assert.equal(normalizeSocialPost({ ...row, body: "a".repeat(20001) }), null);
assert.equal(normalizeSocialPost({ ...row, post_type: "note" }), null);
assert.equal(normalizeSocialPost({ ...row, body: "🏔".repeat(20000) })?.body.length, 40000);
assert.equal(parseDiscoverySearch({ q: "x".repeat(1000), after: "invalid", date: "no", sort: "popularity" }).q.length, 80);
assert.equal(parseDiscoverySearch({ after: "invalid", date: "no" }).cursor, null);
assert.equal(parseDiscoverySearch({ sort: "popularity" }).sort, "newest");
let args;
const page = await listPhase4Posts({ rpc: async (name, input) => { assert.equal(name, "list_social_feed_phase4"); args = input; return { data: Array.from({ length: 21 }, () => row), error: null }; } }, "following");
assert.equal(args.result_limit, 21);
assert.equal(page.posts.length, 20);
assert.equal(page.nextCursor.postId, id);
await assert.rejects(() => listPhase4Posts({ rpc: async () => ({ error: new Error("denied") }) }, "blog"));

// Upload registration failures compensate by deleting the private uploaded object.
const removed = [];
const storage = { upload: async () => ({ error: null }), remove: async paths => { removed.push(...paths); return { error: null }; } };
const client = { storage: { from: bucket => { assert.equal(bucket, "social-post-media"); return storage; } }, rpc: async () => ({ error: new Error("registration denied") }) };
await assert.rejects(() => uploadSocialMedia(client, id, id, new File(["photo"], "test.png", { type: "image/png" }), 0));
assert.equal(removed.length, 1);
await assert.rejects(() => uploadSocialMedia(client, id, id, new File(["html"], "test.html", { type: "text/html" }), 0));
assert.equal(removed.length, 1);

const mediaRoute = await read("app/api/social/posts/[postId]/media/[mediaId]/route.ts");
assert.ok(mediaRoute.indexOf('rpc("get_social_post_phase4"') < mediaRoute.indexOf("const admin ="));
assert.match(mediaRoute, /visibilityError \|\| !post/);
assert.match(mediaRoute, /eq\("id", mediaId\).eq\("post_id", postId\)/);
assert.match(mediaRoute, /private, no-store/);
assert.doesNotMatch(mediaRoute, /createSignedUrl|getPublicUrl/);
const article = await read("app/[locale]/community/blog/[postId]/page.tsx");
assert.doesNotMatch(article, /use client|dangerouslySetInnerHTML/);
assert.match(article, /getPublicBlog/);
assert.match(article, /images: \[\]/);
assert.match(article, /notFound\(\)/);
for (const domain of ["Follow", "Blog", "Discover", "Notifications"]) {
  const en = JSON.parse(await read("messages/en/social.json")).Social[domain];
  for (const locale of ["de", "en", "ru", "fr", "it", "es"]) {
    const actual = JSON.parse(await read(`messages/${locale}/social.json`)).Social[domain];
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(en).sort());
    for (const value of Object.values(actual)) assert.ok(typeof value === "string" && value.length);
  }
}
console.log("Social Phase 4 static contracts, normalization, pagination and upload failure tests passed. Database authorization/runtime tests require manual staging execution.");
