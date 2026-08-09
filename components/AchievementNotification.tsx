"use client";

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
    <div className="fixed right-4 top-24 z-[100] w-[calc(100%-2rem)] max-w-sm animate-[achievement-in_0.35s_ease-out]">
      <div className="relative overflow-hidden rounded-2xl border border-yellow-200 bg-white p-5 shadow-2xl">
        <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-yellow-400 via-amber-500 to-yellow-400" />

        <button
          type="button"
          onClick={onClose}
          className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full text-lg text-gray-400 transition hover:bg-gray-100 hover:text-gray-700"
          aria-label="Закрыть уведомление"
        >
          ×
        </button>

        <div className="flex items-start gap-4 pr-7">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-yellow-100 text-3xl">
            {notification.icon}
          </div>

          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-yellow-700">
              Новое достижение
            </p>

            <h2 className="mt-1 text-lg font-bold text-gray-900">
              {notification.title}
            </h2>

            <p className="mt-1 text-sm leading-5 text-gray-500">
              {notification.description}
            </p>
          </div>
        </div>

        <div className="mt-4 h-1 overflow-hidden rounded-full bg-yellow-100">
          <div className="h-full w-full origin-left animate-[achievement-timer_5s_linear_forwards] bg-yellow-500" />
        </div>
      </div>
    </div>
  );
}