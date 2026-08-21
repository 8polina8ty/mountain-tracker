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
assert.deepEqual(normalizeSocialInboxSummary({ totalUnreadMessages: 2, totalUnreadProjectNotifications: 3, unreadConversations: { c: 2 } }), { totalUnreadMessages: 2, totalUnreadProjectNotifications: 3, unreadConversations: { c: 2 } });
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
console.log("Social Phase B/C/D/E contract validation passed.");
