import "server-only";

import { createClient } from "@/Lib/supabase/server";
import {
  CONVERSATION_PAGE_SIZE,
  MESSAGE_PAGE_SIZE,
  normalizeConversationSummary,
  normalizeMessageRecord,
  normalizeSocialInboxSummary,
  type ConversationSummary,
  type MessageRecord,
  type SocialInboxSummary,
} from "@/Lib/socialMessaging";

export async function getOrCreateDirectConversation(requestedUserId: string) {
  const { data, error } = await (await createClient()).rpc(
    "get_or_create_direct_conversation",
    { requested_user_id: requestedUserId },
  );
  if (error || typeof data !== "string") throw new Error("Messaging unavailable.");
  return data;
}

export async function getSocialInboxSummary(): Promise<SocialInboxSummary> {
  const { data, error } = await (await createClient()).rpc("get_social_inbox_summary");
  const summary = normalizeSocialInboxSummary(data);
  if (error || !summary) throw new Error("Inbox summary unavailable.");
  return summary;
}

export async function listConversations(options: {
  limit?: number;
  cursorUpdatedAt?: string | null;
  cursorConversationId?: string | null;
} = {}): Promise<ConversationSummary[]> {
  const { data, error } = await (await createClient()).rpc("list_conversations", {
    result_limit: options.limit ?? CONVERSATION_PAGE_SIZE,
    cursor_updated_at: options.cursorUpdatedAt ?? null,
    cursor_conversation_id: options.cursorConversationId ?? null,
  });
  if (error) throw new Error("Conversations unavailable.");
  return ((data ?? []) as unknown[])
    .map(normalizeConversationSummary)
    .filter((row): row is ConversationSummary => row !== null);
}

export async function listMessages(options: {
  conversationId: string;
  limit?: number;
  beforeMessageId?: number | null;
}): Promise<MessageRecord[]> {
  const { data, error } = await (await createClient()).rpc("list_messages", {
    requested_conversation_id: options.conversationId,
    result_limit: options.limit ?? MESSAGE_PAGE_SIZE,
    before_message_id: options.beforeMessageId ?? null,
  });
  if (error) throw new Error("Messages unavailable.");
  return ((data ?? []) as unknown[])
    .map(normalizeMessageRecord)
    .filter((row): row is MessageRecord => row !== null);
}

export async function sendMessage(conversationId: string, body: string): Promise<MessageRecord> {
  const { data, error } = await (await createClient()).rpc("send_message", {
    requested_conversation_id: conversationId,
    message_body: body,
  });
  const raw = Array.isArray(data) ? data[0] : data;
  const message = normalizeMessageRecord(raw);
  if (error || !message) throw new Error("Message unavailable.");
  return message;
}

export async function markConversationRead(conversationId: string, throughMessageId: number) {
  const { data, error } = await (await createClient()).rpc("mark_conversation_read", {
    requested_conversation_id: conversationId,
    through_message_id: throughMessageId,
  });
  if (error || typeof data !== "boolean") throw new Error("Read state unavailable.");
  return data;
}

export async function deleteMessage(messageId: number) {
  const { data, error } = await (await createClient()).rpc("delete_message", {
    requested_message_id: messageId,
  });
  if (error || data !== true) throw new Error("Message unavailable.");
}
