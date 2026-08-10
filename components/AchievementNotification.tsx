"use client";

import { X } from "lucide-react";

export type AchievementNotificationData = {
  id: string;
  title: string;
  description: string;
  icon: string;
};

type AchievementNotificationProps = {
  notification: AchievementNotificationData | null;
  onClose: () => void;
};

export default function AchievementNotification({
  notification,
  onClose,
}: AchievementNotificationProps) {
  if (!notification) {
    return null;
  }

  return (
    <aside className="fixed right-4 top-[74px] z-[100] w-[calc(100%-2rem)] max-w-sm animate-[achievement-in_0.35s_ease-out] lg:top-[82px]" role="status" aria-live="polite">
      <div className="relative overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border)] border-l-4 border-l-[var(--color-ochre)] bg-[var(--color-surface-raised)] p-5 shadow-[var(--shadow-panel)]">
        <button
          type="button"
          onClick={onClose}
          className="absolute right-2 top-2 flex h-11 w-11 items-center justify-center rounded-[var(--radius-control)] text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-text)]"
          aria-label="Закрыть уведомление"
        >
          <X aria-hidden="true" className="h-4 w-4" />
        </button>

        <div className="flex items-start gap-4 pr-7">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border border-[var(--color-warning-border)] bg-[var(--color-warning-soft)] text-lg" aria-hidden="true">
            {notification.icon}
          </div>

          <div>
            <p className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.075em] text-[var(--color-warning)]">
              Новый рубеж
            </p>

            <h2 className="mt-1 text-xl font-bold text-[var(--color-text)]">
              {notification.title}
            </h2>

            <p className="mt-1 text-sm leading-5 text-[var(--color-text-muted)]">
              {notification.description}
            </p>
          </div>
        </div>

        <div className="mt-4 h-1 overflow-hidden rounded-full bg-[var(--color-warning-soft)]">
          <div className="h-full w-full origin-left animate-[achievement-timer_5s_linear_forwards] bg-[var(--color-ochre)]" />
        </div>
      </div>
    </aside>
  );
}
