"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { Link } from "@/i18n/navigation";
import { createClient } from "@/Lib/supabase/client";
import { CONVERSATION_PAGE_SIZE, normalizeConversationSummary, type ConversationSummary } from "@/Lib/socialMessaging";
import { useSocialInbox } from "@/components/messages/SocialInboxProvider";
import { Avatar, EmptyState, PrimaryButton } from "@/components/ui-v2";
import { MessageSquare } from "lucide-react";

export default function ConversationList({
  conversations,
  currentUserId,
  activeConversationId,
}: {
  conversations: ConversationSummary[];
  currentUserId: string;
  activeConversationId?: string;
}) {
  const t = useTranslations("Social.Messages");
  const format = useFormatter();
  const { unreadConversations, revision } = useSocialInbox();
  const [items, setItems] = useState(conversations);
  const mountedRef = useRef(false);

  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }

    let active = true;

    const timer = setTimeout(() => {
      void createClient()
        .rpc("list_conversations", {
          result_limit: CONVERSATION_PAGE_SIZE,
          cursor_updated_at: null,
          cursor_conversation_id: null,
        })
        .then(({ data, error }) => {
          if (!active || error) {
            return;
          }

          const next = ((data ?? []) as unknown[])
            .map(normalizeConversationSummary)
            .filter((row): row is ConversationSummary => row !== null);

          setItems(next);
        });
    }, 150);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [revision]);

  if (items.length === 0) {
    return (
      <EmptyState
        icon={MessageSquare}
        title={t("emptyInboxTitle") ?? "No conversations yet"}
        description={t("emptyInbox") ?? "Start a conversation with a friend to see it here."}
        action={
          <Link href="/friends">
            <PrimaryButton icon={MessageSquare}>{t("openFriends") ?? "Find friends"}</PrimaryButton>
          </Link>
        }
      />
    );
  }

  return (
    <nav aria-label={t("conversationList")}>
      <ul className="divide-y divide-[var(--color-border-soft)]">
        {items.map((conversation) => {
          const active = conversation.conversationId === activeConversationId;
          const unreadCount = unreadConversations[conversation.conversationId] ?? 0;
          const unread =
            unreadCount > 0 ||
            (conversation.lastMessageId !== null &&
              conversation.lastMessageBody !== null &&
              conversation.lastMessageSenderId !== currentUserId &&
              (conversation.lastReadMessageId === null || conversation.lastMessageId > conversation.lastReadMessageId));

          return (
            <li key={conversation.conversationId}>
              <Link
                href={`/messages/${conversation.conversationId}`}
                aria-current={active ? "page" : undefined}
                className={`ui-pressable flex min-h-20 gap-4 px-4 py-3 ${active ? "bg-[var(--color-surface-muted)]" : "hover:bg-[var(--color-surface-raised)]"}`}
              >
                <Avatar
                  initials={conversation.counterpartUsername.slice(0, 1).toUpperCase()}
                  size="lg"
                  src={conversation.counterpartAvatarUrl ?? undefined}
                />

                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className={`truncate ${unread ? "font-bold" : "font-semibold"}`}>
                      {conversation.counterpartUsername}
                    </span>
                    {conversation.lastMessageCreatedAt && (
                      <time className="shrink-0 technical text-[10px] tabular-nums text-[var(--color-text-muted)]">
                        {format.dateTime(new Date(conversation.lastMessageCreatedAt), {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </time>
                    )}
                  </div>

                  {conversation.counterpartDisplayName &&
                    conversation.counterpartDisplayName !== conversation.counterpartUsername && (
                      <span className="block truncate text-[12px] text-[var(--color-text-muted)]">
                        {conversation.counterpartDisplayName}
                      </span>
                    )}

                  <div className="mt-1 flex items-center gap-2">
                    <span
                      className={`min-w-0 flex-1 truncate text-sm ${
                        unread ? "font-semibold text-[var(--color-text)]" : "text-[var(--color-text-muted)]"
                      }`}
                    >
                      {conversation.lastMessageId === null
                        ? t("emptyPreview")
                        : conversation.lastMessageBody === null
                        ? t("deleted")
                        : conversation.lastMessageBody}
                    </span>

                    {unread && (
                      <span
                        aria-label={t("unreadMessages", { count: Math.max(1, unreadCount) })}
                        className="inline-flex min-w-5 shrink-0 items-center justify-center rounded-full bg-[var(--color-pine)] px-1.5 py-0.5 text-xs font-bold text-white"
                      >
                        {unreadCount > 0 ? formatUnreadCount(unreadCount) : <span aria-hidden="true">•</span>}
                      </span>
                    )}
                  </div>

                  {conversation.messagingAvailability !== "available" && (
                    <span className="mt-1 block text-xs text-[var(--color-warning)]">
                      {t(conversation.messagingAvailability)}
                    </span>
                  )}
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function formatUnreadCount(count: number) {
  return count > 99 ? "99+" : String(count);
}