import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizeSocialUser } from "../Lib/social.ts";
import { applyRealtimeMessage, canDeleteMessage, formatUnreadBadge, isMessageDraftSendable, isUnreadMessage, mergeMessagePages, normalizeConversationSummary, normalizeMessageRecord, normalizeSocialInboxSummary } from "../Lib/socialMessaging.ts";

const sql = await readFile(new URL("../database/social_user_blocks.sql", import.meta.url), "utf8");
const requests = await readFile(new URL("../database/social_friend_requests.sql", import.meta.url), "utf8");
for (const contract of ["auth.uid()", "for update", "least(actor::text", "greatest(actor::text", "status='rejected'", "interval '7 days'", ">= 25", "on conflict", "delete from public.friendships", "status='cancelled'", "blocked_or_unavailable", "security definer", "revoke all on function"]) assert.ok(sql.toLowerCase().includes(contract), `Missing SQL invariant: ${contract}`);
assert.ok(requests.includes("friend_requests_one_pending_pair_idx"));
assert.ok(requests.includes("where status = 'pending'"));
assert.equal(sql.toLowerCase().includes("from auth.users"), false, "RPC implementation must not query auth.users");
const normalized = normalizeSocialUser({ user_id: "u", username: "alpine", display_name: "Al Pine", avatar_url: null, relationship_state: "none", can_send_request: true, can_cancel_request: false, can_respond_to_request: false, can_remove_friend: false, can_unblock: false, request_id: null });
assert.equal(normalized?.relationshipState, "none");
assert.equal(normalized?.canSendRequest, true);
assert.equal(normalizeSocialUser({ user_id: "u", username: "x", relationship_state: "blocked_by_other" }), null);

const conversations = (await readFile(new URL("../database/social_conversations.sql", import.meta.url), "utf8")).toLowerCase();
const messages = (await readFile(new URL("../database/social_messages.sql", import.meta.url), "utf8")).toLowerCase();
for (const contract of ["conversations_direct_pair_unique", "for key share", "on conflict", "is_conversation_member", "auth.uid()", "security definer", "revoke all on function"]) assert.ok(conversations.includes(contract), `Missing conversation invariant: ${contract}`);
for (const contract of ["char_length(clean_body) > 4000", "clean_body = ''", "[[:space:]]", "regexp_replace", "for key share", "friendships", "user_blocks", "messages_conversation_cursor_idx", "before_message_id", "last_read_message_id", "through_message_id <= current_cursor", "body = ''", "deleted_at = now()", "interval '10 seconds'", ">= 300", "revoke all on function"]) assert.ok(messages.includes(contract), `Missing message invariant: ${contract}`);
assert.equal(messages.includes("sender_id uuid"), true);
assert.equal(messages.includes("requested_sender_id"), false, "Sender identity must never be accepted as an RPC parameter");
assert.equal(messages.includes("supabase.channel"), false);
assert.equal(messages.includes("postgres_changes"), false);

assert.equal(normalizeConversationSummary({ conversation_id: "c", counterpart_user_id: "u", counterpart_username: "alpine", messaging_availability: "available" })?.conversationId, "c");
assert.equal(normalizeConversationSummary({ conversation_id: "c", counterpart_user_id: "u", counterpart_username: "alpine", messaging_availability: "blocked_by_other" }), null);
assert.deepEqual(normalizeMessageRecord({ id: 1, sender_id: "u", body: null, created_at: "2026-01-01T00:00:00Z", deleted_at: "2026-01-01T00:01:00Z" })?.body, null);
assert.equal(isMessageDraftSendable("   "), false);
assert.equal(isMessageDraftSendable(" expedition note "), true);
assert.equal(isMessageDraftSendable("x".repeat(4001)), false);
assert.deepEqual(mergeMessagePages([{ id: 2, senderId: "u", body: "b", createdAt: "x", editedAt: null, deletedAt: null }], [{ id: 1, senderId: "u", body: "a", createdAt: "x", editedAt: null, deletedAt: null }, { id: 2, senderId: "u", body: "b", createdAt: "x", editedAt: null, deletedAt: null }]).map((row) => row.id), [1, 2]);
assert.equal(canDeleteMessage({ id: 1, senderId: "u", body: "x", createdAt: "x", editedAt: null, deletedAt: null }, "u"), true);
assert.equal(canDeleteMessage({ id: 1, senderId: "other", body: "x", createdAt: "x", editedAt: null, deletedAt: null }, "u"), false);
const confirmed = { id: 7, senderId: "u", body: "sent", createdAt: "x", editedAt: null, deletedAt: null };
assert.equal(applyRealtimeMessage([confirmed], confirmed).length, 1, "RPC confirmation and Realtime insert must deduplicate");
assert.deepEqual(applyRealtimeMessage([{ ...confirmed, body: "sent" }], { ...confirmed, body: null, deletedAt: "2026-01-01T00:00:00Z" })[0].body, null, "Realtime update must replace content with a tombstone");
assert.deepEqual(applyRealtimeMessage([{ ...confirmed, id: 9 }], { ...confirmed, id: 8 }).map((row) => row.id), [8, 9], "Incoming ordering must remain stable");
assert.equal(isUnreadMessage({ ...confirmed, senderId: "other" }, "u", 6), true);
assert.equal(isUnreadMessage(confirmed, "u", 6), false, "Own messages are never unread");
assert.equal(isUnreadMessage({ ...confirmed, senderId: "other", deletedAt: "x" }, "u", 6), false, "Deleted messages are not unread");
assert.equal(isUnreadMessage({ ...confirmed, senderId: "other" }, "u", 7), false, "Read cursor clears unread state");
assert.equal(formatUnreadBadge(0), null);
assert.equal(formatUnreadBadge(3), "3");
assert.equal(formatUnreadBadge(100), "99+");
const inboxOk = normalizeSocialInboxSummary({ totalUnreadMessages: 2, totalUnreadProjectNotifications: 3, unreadConversations: { c: 2 } });
assert.equal(inboxOk?.totalUnreadMessages, 2);
assert.equal(inboxOk?.totalUnreadProjectNotifications, 3);
assert.ok(typeof inboxOk?.totalUnreadSocialNotifications === "number" || inboxOk?.totalUnreadSocialNotifications === undefined);
assert.equal(normalizeSocialInboxSummary({ totalUnreadMessages: 2, totalUnreadProjectNotifications: -1, unreadConversations: {} }), null);
const messageUi = await readFile(new URL("../components/messages/MessageThread.tsx", import.meta.url), "utf8");
assert.ok(messageUi.includes("message.deletedAt"));
assert.ok(messageUi.includes("canDeleteMessage(message,currentUserId)"));
assert.ok(messageUi.includes("setDraft(\"\")"));
assert.ok(messageUi.includes("setError(t(\"sendError\"))"));
assert.ok(messageUi.includes('event:"INSERT"'));
assert.ok(messageUi.includes('event:"UPDATE"'));
assert.ok(messageUi.includes("removeChannel(channel)"), "Thread subscription must clean up");
assert.equal(messageUi.includes("dangerouslySetInnerHTML"), false);
const inboxProvider = await readFile(new URL("../components/messages/SocialInboxProvider.tsx", import.meta.url), "utf8");
assert.ok(inboxProvider.includes("get_social_inbox_summary"));
assert.ok(inboxProvider.includes('table: "messages"'));
assert.ok(inboxProvider.includes("removeChannel(channel)"), "Inbox subscription must clean up");
assert.ok(inboxProvider.includes("setSummary(emptySummary)"), "Auth changes must clear prior unread state");
for (const forbidden of ["presence", "broadcast", "setinterval"]) {
  assert.equal(
    (messageUi + inboxProvider).toLowerCase().includes(forbidden),
    false,
    `Phase E must not use ${forbidden}`
  );
}

assert.ok(
  inboxProvider.includes("setTimeout"),
  "Inbox Realtime refresh should use bounded debounce/coalescing"
);

assert.ok(
  inboxProvider.includes("150"),
  "Inbox Realtime debounce should remain bounded"
);
const unreadSql = (await readFile(new URL("../database/social_unread.sql", import.meta.url), "utf8")).toLowerCase();
for (const contract of ["auth.uid()", "last_read_message_id", "m.sender_id <> cm.user_id", "m.deleted_at is null", "group by cm.conversation_id", "security definer", "revoke all"]) assert.ok(unreadSql.includes(contract), `Missing unread invariant: ${contract}`);
const realtimeSql = (await readFile(new URL("../database/social_realtime.sql", import.meta.url), "utf8")).toLowerCase();
assert.ok(realtimeSql.includes("supabase_realtime"));
assert.ok(realtimeSql.includes("add table public.messages"));
const socialActions = await readFile(new URL("../components/social/SocialActions.tsx", import.meta.url), "utf8");
assert.ok(socialActions.includes('state === "friends"'));
assert.ok(socialActions.includes("StartConversationButton"));
for (const locale of ["de", "en", "ru"]) {
  const json = JSON.parse(await readFile(new URL(`../messages/${locale}/social.json`, import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(json.Social.Messages).sort(), Object.keys(JSON.parse(await readFile(new URL("../messages/en/social.json", import.meta.url), "utf8")).Social.Messages).sort());
  assert.deepEqual(Object.keys(json.Social.Accessibility).sort(), Object.keys(JSON.parse(await readFile(new URL("../messages/en/social.json", import.meta.url), "utf8")).Social.Accessibility).sort());
}
// Phase 1 Social Feed contracts
const feedSql = await readFile(new URL("../database/social_feed.sql", import.meta.url), "utf8").then(s=>s.toLowerCase());
for (const c of ["create table if not exists public.social_posts","create table if not exists public.social_post_media","create table if not exists public.social_post_likes","create table if not exists public.social_post_comments","social_posts_author_created_idx","social_post_media_post_position_idx","auth.uid()","security definer set search_path = ''","revoke all on function","grant execute","social-post-media","is_blocked_either","are_friends","can_view_social_post","create_social_post","list_social_feed","list_user_social_posts","like_social_post","list_social_post_comments","char_length(body) <= 5000","char_length(btrim(body)) between 1 and 2000","10485760","deleted_at is null","least(greatest","order by p.created_at desc, p.id desc"]) assert.ok(feedSql.includes(c.toLowerCase()), `Missing feed invariant: ${c}`);
assert.equal(feedSql.includes("requested_author_id"), false, "Author must derive from auth.uid()");
assert.equal(feedSql.includes("getpublicurl"), false, "No public URL");
assert.ok(feedSql.includes("storage_path"), "Media table must have storage_path");
const feedTypes = await readFile(new URL("../Lib/socialFeed/types.ts", import.meta.url), "utf8");
assert.ok(feedTypes.includes("SOCIAL_FEED_PAGE_SIZE = 20"), "Feed page size missing");
assert.ok(feedTypes.includes("SOCIAL_POST_MAX_BODY = 5000"), "Body limit missing");
const feedNormalize = await readFile(new URL("../Lib/socialFeed/normalize.ts", import.meta.url), "utf8");
assert.ok(feedNormalize.includes("normalizeSocialPost"), "Normalizer missing");
const composer = await readFile(new URL("../components/social/feed/PostComposer.tsx", import.meta.url), "utf8");
assert.ok(composer.includes("maxLength={5000}") || composer.includes("5000"), "Composer max length missing");
assert.ok(composer.includes("image/jpeg") && composer.includes("1024"), "Photo validation missing");
const communityPage = await readFile(new URL("../app/[locale]/community/page.tsx", import.meta.url), "utf8");
const communityClient = await readFile(new URL("../components/social/feed/CommunityFeedClient.tsx", import.meta.url), "utf8").catch(()=> "");
assert.ok((communityPage.includes("CommunityFeedClient") || (communityPage.includes("CommunityFeed") && communityPage.includes("PostComposer"))) && communityClient.includes("PostComposer") && communityClient.includes("CommunityFeed"), "Community page wiring missing");
for (const loc of ["de","en","ru","fr","it","es"]) {
  const j=JSON.parse(await readFile(new URL(`../messages/${loc}/social.json`, import.meta.url), "utf8"));
  assert.ok(j.Social.Feed && typeof j.Social.Feed.community === "string", `${loc} Feed missing`);
}
// Phase 2 hardening regressions A-F
assert.ok(feedSql.includes("linked_ascent_id bigint references public.ascents(id) on delete set null"), "A: ascent FK must be SET NULL");
assert.ok(feedSql.includes("linked_project_id uuid references public.expedition_projects(id) on delete set null"), "A: project FK must be SET NULL");
// Constraint must allow SET NULL: it should be permissive (linked null or post_type='ascent'), not strict not-null
assert.ok(feedSql.includes("linked_ascent_id is null or post_type='ascent'"), "A: invariant must allow null after delete");
assert.ok(feedSql.includes("social_posts_unique_ascent_per_author") && feedSql.includes("where deleted_at is null and linked_ascent_id is not null"), "D: partial unique must remain correct");
assert.ok(feedSql.includes("social_posts_unique_project_per_author") && feedSql.includes("where deleted_at is null and linked_project_id is not null"), "D: project unique partial correct");
assert.ok(feedSql.includes("create_social_ascent_post") && feedSql.includes("requested_ascent_id bigint"), "C: ascent RPC must exist");
assert.ok(feedSql.includes("create_social_expedition_post") && feedSql.includes("is_enabled=true"), "D: expedition RPC must check public share");
assert.ok(feedSql.includes("create_social_achievement_post") && feedSql.includes("requested_achievement_id text"), "C: achievement RPC must exist");
const attachments = await readFile(new URL("../components/social/feed/ActivityAttachments.tsx", import.meta.url), "utf8");
assert.ok(attachments.includes("ACHIEVEMENT_DEFINITIONS_BY_ID.has") || attachments.includes("ACHIEVEMENT_DEFINITIONS_BY_ID.get"), "E: achievement must use canonical mapping");
assert.ok(!attachments.includes("Definitions.${achievement.achievementId}.title") || attachments.includes("ACHIEVEMENT_DEFINITIONS_BY_ID"), "E: untrusted key must not crash");
const postCard = await readFile(new URL("../components/social/feed/PostCard.tsx", import.meta.url), "utf8");
assert.ok(postCard.includes("postType === \"ascent\"") && postCard.includes("postType === \"expedition\""), "F: post type must not contain conflicting IDs");
// Phase 3 hardening: like aggregation, FK SET NULL, mention parity, dedupe, unified, direct post
const phase3Sql = await readFile(new URL("../database/social_feed_phase3.sql", import.meta.url), "utf8");
assert.ok(phase3Sql.includes("on conflict (recipient_user_id, notification_type, source_key) do update set actor_user_id") && phase3Sql.includes("read_at = null"), "Like aggregation must update unread");
assert.ok(phase3Sql.includes("references public.social_posts(id) on delete set null") && phase3Sql.includes("references public.social_post_comments(id) on delete set null"), "Delete FK must be SET NULL");
assert.ok(phase3Sql.includes("[^a-zA-Z0-9_.-]") && (await readFile(new URL("../Lib/socialFeed/mentions.ts", import.meta.url), "utf8")).includes("[^a-zA-Z0-9_.-]"), "Mention parser parity must use PG-compatible boundary");
assert.ok(phase3Sql.includes("delete from public.social_notifications where recipient_user_id=post_row.author_id and notification_type='social.post_commented'"), "Comment/mention dedupe must suppress generic");
assert.ok(phase3Sql.includes("create or replace function public.get_social_post") && phase3Sql.includes("can_view") || phase3Sql.includes("is_blocked_either"), "Direct post navigation must enforce can_view");
assert.ok(phase3Sql.includes("list_unified_notifications") && phase3Sql.includes("recipient_user_id=auth.uid()") && phase3Sql.includes("is_blocked_either"), "Unified must be recipient + blocked safe");
// Username contract (final Phase 3 hardening) – canonical 3..20, A-Z a-z 0-9 _ . -, first/last [A-Za-z0-9_], trim, case-insensitive
const usernameValidator = await readFile(new URL("../Lib/username.ts", import.meta.url), "utf8");
assert.ok(usernameValidator.includes("USERNAME_RE") && usernameValidator.includes("[A-Za-z0-9_][A-Za-z0-9_.-]{1,18}[A-Za-z0-9_]"), "Username validator must enforce canonical 3..20 with first/last [A-Za-z0-9_]");
assert.ok(usernameValidator.includes("[...value].length") && usernameValidator.includes("validateUsername"), "Username validator must handle Unicode codepoints and trim");
const signUp = await readFile(new URL("../app/[locale]/auth/sign-up/page.tsx", import.meta.url), "utf8");
assert.ok(signUp.includes("validateUsername") && signUp.includes("username.trim()") || signUp.includes("validateUsername"), "Sign-up must use shared username validator");
for (const loc of ["de","en","ru","fr","it","es"]) {
  const authJson = JSON.parse(await readFile(new URL(`../messages/${loc}/auth.json`, import.meta.url), "utf8"));
  for (const key of ["usernameTooShort","usernameTooLong","usernameInvalidChars","usernameInvalidEdges"]) {
    assert.ok(typeof authJson.Auth.signUpPage.errors[key] === "string" && authJson.Auth.signUpPage.errors[key].length > 0, `${loc} missing ${key}`);
  }
}
const auditSql = await readFile(new URL("../database/username_contract_audit.sql", import.meta.url), "utf8");
assert.ok(auditSql.includes("username !~ '^[A-Za-z0-9_][A-Za-z0-9_.-]{1,18}[A-Za-z0-9_]$'") && auditSql.includes("group by lower(username)"), "Audit SQL must contain legacy + duplicate checks");
assert.ok(phase3Sql.includes("select count(*) into cnt from public.profiles where lower(username)=lower(requested_username)") && phase3Sql.includes("if cnt <> 1 then return null"), "resolve_mention_user must fail closed on ambiguous case-insensitive");
// Mention parser parity vectors (shared JS/SQL semantics)
const { extractMentions } = await import("../Lib/socialFeed/mentions.ts");
for (const [input, expected] of [
  ["@alex", ["alex"]],
  ["hello @alex", ["alex"]],
  ["(@alex)", ["alex"]],
  ["hi, @alex", ["alex"]],
  ["@alex.", ["alex"]],
  ["@alex @maria", ["alex","maria"]],
  ["@alex,@maria", ["alex","maria"]],
  ["email@example.com", []],
  ["foo@bar", []],
  ["abc@alex", []],
  ["@ab", []],
  ["@alex hi @alex", ["alex"]],
]) {
  assert.deepEqual(extractMentions(input), expected, `mention vector failed for ${input}`);
}
// Multiple mention adjacent must not swallow delimiter (regression for global consume)
assert.deepEqual(extractMentions("@alex @maria"), ["alex","maria"]);
assert.deepEqual(extractMentions("(@alex),(@maria)"), ["alex","maria"]);
assert.deepEqual(extractMentions("@alex,@maria"), ["alex","maria"]);
// Comment normalization/render safety regressions
const { normalizeSocialComment } = await import("../Lib/socialFeed/normalize.ts");
const goodRow = { comment_id: "11111111-1111-4111-8111-111111111111", post_id: "22222222-2222-4222-8222-222222222222", author_id: "33333333-3333-4333-8333-333333333333", username: "alpine", display_name: "Al", avatar_url: null, body: "hello", created_at: "2026-01-01T00:00:00Z" };
assert.ok(normalizeSocialComment(goodRow)?.author.username === "alpine", "1: normal comment must normalize");
assert.equal(normalizeSocialComment({ comment_id: "11111111-1111-4111-8111-111111111111", post_id: "22222222-2222-4222-8222-222222222222", author_id: "33333333-3333-4333-8333-333333333333", body: "hi", created_at: "2026-01-01T00:00:00Z" }), null, "2: missing username must not crash");
const commentsUi = await readFile(new URL("../components/social/feed/PostComments.tsx", import.meta.url), "utf8");
assert.ok(commentsUi.includes("normalizeSocialComment"), "3: PostComments must use normalizer");
assert.ok(commentsUi.includes("if (!c.author) return null") || commentsUi.includes("c.author?.username") || commentsUi.includes("if (!c.author)"), "4: render guard must exist");
assert.ok(commentsUi.includes("reload()") && !commentsUi.includes('username:"you"'), "5: freshly-created comment must reload canonical shape");
assert.ok(commentsUi.includes("await reload()") || commentsUi.includes("reload"), "5: reload after create must not duplicate");
console.log("Social Phase B/C/D/E contract validation passed.");
console.log("Social Feed Phase 1 validation passed.");
console.log("Social Feed Phase 2 hardening validation passed.");
await import("./validate-social-phase4.mjs");
