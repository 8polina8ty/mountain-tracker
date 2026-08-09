"use client";

import type { AchievementView } from "@/Lib/achievements";

type AchievementCardProps = {
  achievement: AchievementView;
  formatDate: (date: string) => string;
};

export default function AchievementCard({
  achievement,
  formatDate,
}: AchievementCardProps) {
  const achievementProgress =
    achievement.target > 0
      ? Math.min(
          (achievement.progress / achievement.target) * 100,
          100,
        )
      : 0;

  return (
    <article
      className={`flex min-h-[230px] flex-col justify-between rounded-2xl border p-5 transition-all duration-300 ${
        achievement.unlocked
          ? "border-green-200 bg-green-50 shadow-sm hover:-translate-y-1 hover:shadow-lg"
          : "border-gray-200 bg-gray-50 opacity-75"
      }`}
    >
      <div>
        <div className="flex items-start justify-between gap-3">
          <div
            className={`flex h-14 w-14 items-center justify-center rounded-2xl text-2xl ${
              achievement.unlocked
                ? "bg-green-600 text-white"
                : "bg-gray-200 grayscale"
            }`}
          >
            {achievement.icon}
          </div>

          <span
            className={`rounded-full px-3 py-1 text-xs font-bold ${
              achievement.unlocked
                ? "bg-green-100 text-green-700"
                : "bg-gray-200 text-gray-500"
            }`}
          >
            {achievement.unlocked ? "Открыто" : "Заблокировано"}
          </span>
        </div>

        <h3 className="mt-5 text-lg font-bold text-gray-900">
          {achievement.title}
        </h3>

        <p className="mt-2 text-sm leading-6 text-gray-500">
          {achievement.description}
        </p>

        {achievement.unlockedAt && (
          <p className="mt-3 text-xs font-semibold text-green-700">
            Получено: {formatDate(achievement.unlockedAt)}
          </p>
        )}
      </div>

      <div className="mt-5">
        <div className="flex items-center justify-between gap-3 text-xs font-semibold">
          <span className="text-gray-500">
            {achievement.progressLabel}
          </span>

          <span
            className={
              achievement.unlocked
                ? "text-green-700"
                : "text-gray-400"
            }
          >
            {Math.round(achievementProgress)}%
          </span>
        </div>

        <div className="mt-2 h-2 overflow-hidden rounded-full bg-gray-200">
          <div
            className={`h-full rounded-full transition-all duration-700 ${
              achievement.unlocked
                ? "bg-green-600"
                : "bg-gray-400"
            }`}
            style={{
              width: `${achievementProgress}%`,
            }}
          />
        </div>
      </div>
    </article>
  );
}