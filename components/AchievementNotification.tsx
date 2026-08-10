"use client";

import { X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

const standardEasing = [0.2, 0, 0, 1] as const;

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
  const shouldReduceMotion = useReducedMotion();

  return (
    <AnimatePresence initial={false} mode="wait">
      {notification && (
        <motion.aside
          key={notification.id}
          initial={{
            opacity: 0,
            y: shouldReduceMotion ? 0 : 10,
          }}
          animate={{
            opacity: 1,
            y: 0,
            transition: {
              duration: shouldReduceMotion ? 0 : 0.2,
              ease: standardEasing,
            },
          }}
          exit={{
            opacity: 0,
            y: shouldReduceMotion ? 0 : -4,
            transition: {
              duration: shouldReduceMotion ? 0 : 0.16,
              ease: standardEasing,
            },
          }}
          className="fixed right-4 top-[74px] z-[100] w-[calc(100%-2rem)] max-w-sm lg:top-[82px]"
          role="status"
          aria-live="polite"
        >
          <div className="relative overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border)] border-l-4 border-l-[var(--color-ochre)] bg-[var(--color-surface-raised)] p-5 shadow-[var(--shadow-panel)]">
            <button
              type="button"
              onClick={onClose}
              className="ui-pressable absolute right-2 top-2 flex h-11 w-11 items-center justify-center rounded-[var(--radius-control)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-text)]"
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
              <motion.div
                initial={{ scaleX: 1 }}
                animate={{ scaleX: shouldReduceMotion ? 1 : 0 }}
                transition={{
                  duration: shouldReduceMotion ? 0 : 5,
                  ease: "linear",
                }}
                className="h-full w-full origin-left bg-[var(--color-ochre)]"
                aria-hidden="true"
              />
            </div>
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
