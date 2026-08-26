"use client";

import { useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { Bell, CheckCheck } from "lucide-react";
import { createClient } from "@/Lib/supabase/client";
import { useSocialInbox } from "@/components/messages/SocialInboxProvider";
import { Link } from "@/i18n/navigation";
import {
  listProjectNotifications,
  PROJECT_NOTIFICATION_TRANSLATION_KEYS,
  type ProjectNotificationItem,
  type ProjectNotificationPage,
} from "@/Lib/projects/notifications";
import { EmptyState, PrimaryButton, SecondaryButton, SectionHeading } from "@/components/ui-v2";

export default function ProjectNotifications({ initialPage }: { initialPage: ProjectNotificationPage }) {
  const t = useTranslations("Notifications");
  const format = useFormatter();
  const { refresh } = useSocialInbox();
  const [items, setItems] = useState(initialPage.items);
  const [cursor, setCursor] = useState(initialPage.nextCursor);
  const [busy, setBusy] = useState(false);
  const supabase = createClient();

  const actor = (item: ProjectNotificationItem) => item.actorName ?? item.actorUsername ?? t("someone");
  const values = (item: ProjectNotificationItem) => ({
    actor: actor(item),
    project: String(item.metadata.projectName ?? t("project")),
    role: String(item.metadata.to ?? item.metadata.role ?? ""),
  });

  async function markOne(id: string) {
    const { error } = await supabase.rpc("mark_expedition_project_notification_read", {
      requested_notification_id: id,
    });
    if (!error) {
      setItems((v) => v.map((n) => (n.id === id ? { ...n, readAt: n.readAt ?? new Date().toISOString() } : n)));
      void refresh();
    }
  }

  async function markAll() {
    setBusy(true);
    const { error } = await supabase.rpc("mark_all_expedition_project_notifications_read");
    if (!error) {
      const now = new Date().toISOString();
      setItems((v) => v.map((n) => ({ ...n, readAt: n.readAt ?? now })));
      void refresh();
    }
    setBusy(false);
  }

  async function loadMore() {
    if (!cursor) return;
    setBusy(true);
    try {
      const page = await listProjectNotifications(supabase, cursor);
      setItems((v) => [...v, ...page.items]);
      setCursor(page.nextCursor);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-10" aria-label={t("title")}>
      {/* Header with mark all read */}
      <div className="flex items-center justify-between gap-4">
        <SectionHeading
          eyebrow={t("List.eyebrow") ?? "Activity"}
          title={t("List.title") ?? "Notifications"}
        />
        <PrimaryButton
          size="small"
          icon={CheckCheck}
          disabled={busy || !items.some((i) => !i.readAt)}
          onClick={markAll}
        >
          {t("markAll") ?? "Mark all read"}
        </PrimaryButton>
      </div>

      {/* Notifications List */}
      {items.length === 0 ? (
        <EmptyState
          icon={Bell}
          title={t("emptyTitle") ?? "No notifications"}
          description={t("emptyDescription") ?? "You're all caught up. New project activity will appear here."}
        />
      ) : (
        <ol className="divide-y divide-[var(--color-border-soft)] border-y border-[var(--color-border)]">
          {items.map((item) => {
            const content = (
              <>
                <p className="font-semibold text-[var(--color-text)]">
                  {t(`types.${PROJECT_NOTIFICATION_TRANSLATION_KEYS[item.type]}`, values(item))}
                </p>
                <time className="mt-1 block text-xs text-[var(--color-text-muted)]" dateTime={item.createdAt}>
                  {format.relativeTime(new Date(item.createdAt))}
                </time>
              </>
            );

            const href =
              item.type === "invitation.received"
                ? "/projects"
                : item.canNavigate && item.projectId
                ? `/projects/${item.projectId}`
                : null;

            return (
              <li
                key={item.id}
                className={`relative py-4 pl-5 pr-3 ${item.readAt ? "" : "bg-[var(--color-surface-muted)]"}`}
              >
                <span
                  className={`absolute left-1 top-6 h-2 w-2 rounded-full ${
                    item.readAt ? "bg-transparent" : "bg-[var(--color-pine)]"
                  }`}
                />
                {href ? (
                  <Link href={href} onClick={() => void markOne(item.id)} className="block rounded-[var(--radius-control)] p-2 hover:bg-[var(--color-surface)]">
                    {content}
                  </Link>
                ) : (
                  <button
                    type="button"
                    onClick={() => void markOne(item.id)}
                    className="block w-full rounded-[var(--radius-control)] p-2 text-left hover:bg-[var(--color-surface)]"
                  >
                    {content}
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {/* Load More */}
      {cursor && (
        <div className="text-center">
          <SecondaryButton
            size="default"
            disabled={busy}
            onClick={loadMore}
          >
            {busy ? t("loading") : t("loadMore") ?? "Load more"}
          </SecondaryButton>
        </div>
      )}
    </section>
  );
}