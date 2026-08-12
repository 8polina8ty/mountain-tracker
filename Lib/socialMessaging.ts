export const CONVERSATION_PAGE_SIZE = 30;
export const MESSAGE_PAGE_SIZE = 50;
export const MESSAGE_MAX_CHARACTERS = 4000;

export type MessagingAvailability =
  | "available"
  | "friendship_required"
  | "unavailable";

export type ConversationSummary = {
  conversationId: string;
  counterpartUserId: string;
  counterpartUsername: string;
  counterpartDisplayName: string | null;
  counterpartAvatarUrl: string | null;
  lastMessageId: number | null;
  lastMessageBody: string | null;
  lastMessageSenderId: string | null;
  lastMessageCreatedAt: string | null;
  lastReadMessageId: number | null;
  messagingAvailability: MessagingAvailability;
};

export type MessageRecord = {
  id: number;
  conversationId?: string;
  senderId: string;
  body: string | null;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
};

export type SocialInboxSummary = {
  totalUnreadMessages: number;
  unreadConversations: Record<string, number>;
};

function nullableString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function nullableSafeInteger(value: unknown) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

export function normalizeConversationSummary(value: unknown): ConversationSummary | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const availability = row.messaging_availability;
  if (
    typeof row.conversation_id !== "string" ||
    typeof row.counterpart_user_id !== "string" ||
    typeof row.counterpart_username !== "string" ||
    !["available", "friendship_required", "unavailable"].includes(String(availability))
  ) return null;
  return {
    conversationId: row.conversation_id,
    counterpartUserId: row.counterpart_user_id,
    counterpartUsername: row.counterpart_username,
    counterpartDisplayName: nullableString(row.counterpart_display_name),
    counterpartAvatarUrl: nullableString(row.counterpart_avatar_url),
    lastMessageId: nullableSafeInteger(row.last_message_id),
    lastMessageBody: nullableString(row.last_message_body),
    lastMessageSenderId: nullableString(row.last_message_sender_id),
    lastMessageCreatedAt: nullableString(row.last_message_created_at),
    lastReadMessageId: nullableSafeInteger(row.last_read_message_id),
    messagingAvailability: availability as MessagingAvailability,
  };
}

export function normalizeMessageRecord(value: unknown): MessageRecord | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const id = nullableSafeInteger(row.id);
  if (id === null || typeof row.sender_id !== "string" || typeof row.created_at !== "string") return null;
  return {
    id,
    conversationId: nullableString(row.conversation_id) ?? undefined,
    senderId: row.sender_id,
    body: nullableString(row.body),
    createdAt: row.created_at,
    editedAt: nullableString(row.edited_at),
    deletedAt: nullableString(row.deleted_at),
  };
}

export function isMessageDraftSendable(body: string) {
  const trimmed = body.trim();
  return trimmed.length > 0 && [...trimmed].length <= MESSAGE_MAX_CHARACTERS;
}

export function mergeMessagePages(current: MessageRecord[], older: MessageRecord[]) {
  const byId = new Map<number, MessageRecord>();
  for (const message of [...current, ...older]) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

export function normalizeSocialInboxSummary(value: unknown): SocialInboxSummary | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const total = Number(row.totalUnreadMessages);
  if (!Number.isSafeInteger(total) || total < 0 || !row.unreadConversations || typeof row.unreadConversations !== "object" || Array.isArray(row.unreadConversations)) return null;
  const unreadConversations: Record<string, number> = {};
  for (const [conversationId, countValue] of Object.entries(row.unreadConversations as Record<string, unknown>)) {
    const count = Number(countValue);
    if (!Number.isSafeInteger(count) || count < 1) return null;
    unreadConversations[conversationId] = count;
  }
  return { totalUnreadMessages: total, unreadConversations };
}

export function applyRealtimeMessage(current: MessageRecord[], message: MessageRecord) {
  return mergeMessagePages(current, [message]);
}

export function isUnreadMessage(message: MessageRecord, currentUserId: string, lastReadMessageId: number | null) {
  return message.senderId !== currentUserId && message.deletedAt === null && (lastReadMessageId === null || message.id > lastReadMessageId);
}

export function formatUnreadBadge(count: number) {
  if (count < 1) return null;
  return count > 99 ? "99+" : String(count);
}

export function canDeleteMessage(message: MessageRecord, currentUserId: string) {
  return message.senderId === currentUserId && message.deletedAt === null;
}
