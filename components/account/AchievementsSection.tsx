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
    <section className="border-b border-[var(--color-border-strong)] py-10 sm:py-12" aria-labelledby="achievements-title">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.1em] text-[var(--color-forest)]">
            03 / Этапы пути
          </p>

          <h2 id="achievements-title" className="mt-2 text-3xl font-bold text-[var(--color-text)]">
            Экспедиционные рубежи
          </h2>
        </div>

        <p className="[font-family:var(--font-technical)] text-sm font-bold tabular-nums text-[var(--color-text-secondary)]">
          {unlockedAchievementsCount} / {achievements.length}
        </p>
      </div>

      <div className="grid gap-px border-y border-[var(--color-border)] bg-[var(--color-border-soft)] md:grid-cols-2">
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
