import AchievementCard from "@/components/AchievementCard";
import type { AchievementView } from "@/Lib/achievements";
import { formatDate } from "@/Lib/utils";

type AchievementsSectionProps = {
  achievements: AchievementView[];
  unlockedAchievementsCount: number;
};

export default function AchievementsSection({
  achievements,
  unlockedAchievementsCount,
}: AchievementsSectionProps) {
  return (
    <section className="rounded-3xl border border-gray-200 bg-white p-6 shadow-sm">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-green-600">
            Достижения
          </p>

          <h2 className="mt-1 text-2xl font-bold text-gray-900">
            Награды альпиниста
          </h2>
        </div>

        <p className="rounded-full bg-green-50 px-4 py-2 text-sm font-semibold text-green-700">
          {unlockedAchievementsCount} / {achievements.length}
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {achievements.map((achievement) => (
          <AchievementCard
            key={achievement.id}
            achievement={achievement}
            formatDate={formatDate}
          />
        ))}
      </div>
    </section>
  );
}