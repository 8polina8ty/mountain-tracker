import AchievementCard from "@/components/AchievementCard";
import type { AchievementView } from "@/Lib/achievements";
import {
  ACHIEVEMENT_REGISTRY,
  getAchievementPoints,
  isAchievementId,
} from "@/Lib/achievementRegistry";
import { Link } from "@/i18n/navigation";
import { useTranslations } from "next-intl";

type AchievementsSectionProps = {
  achievements: AchievementView[];
};

export default function AchievementsSection({
  achievements,
}: AchievementsSectionProps) {
  const t = useTranslations("Achievements.Section");
  const persistedAchievements = achievements
    .filter((achievement) => achievement.unlockedAt)
    .sort((first, second) =>
      Date.parse(second.unlockedAt ?? "") - Date.parse(first.unlockedAt ?? ""),
    );
  const persistedCount = persistedAchievements.length;
  const points = persistedAchievements.reduce(
    (total, achievement) =>
      total + (isAchievementId(achievement.id) ? getAchievementPoints(achievement.id) : 0),
    0,
  );
  const completion = Math.round(
    (persistedCount / ACHIEVEMENT_REGISTRY.length) * 100,
  );
  const nearby = achievements
    .filter(
      (achievement) =>
        !achievement.unlockedAt &&
        achievement.id !== "above-clouds" &&
        achievement.id !== "zugspitze",
    )
    .sort(
      (first, second) =>
        second.progress / second.target - first.progress / first.target,
    )
    .slice(0, 3);
  const preview = [...persistedAchievements.slice(0, 3), ...nearby].slice(0, 6);

  return (
    <section className="border-b border-[var(--color-border-strong)] py-10 sm:py-12" aria-labelledby="achievements-title">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.1em] text-[var(--color-forest)]">
            {t("eyebrow")}
          </p>

          <h2 id="achievements-title" className="mt-2 text-3xl font-bold text-[var(--color-text)]">
            {t("title")}
          </h2>
        </div>

        <Link href="/account/achievements" className="ui-pressable inline-flex min-h-11 items-center text-sm font-semibold text-[var(--color-forest)] hover:underline">
          {t("viewAll")}
        </Link>
      </div>

      <dl className="mb-6 grid grid-cols-3 gap-px border-y border-[var(--color-border)] bg-[var(--color-border-soft)]">
        <SummaryMetric label={t("unlockedLabel")} value={t("count", { unlocked: persistedCount, total: ACHIEVEMENT_REGISTRY.length })} />
        <SummaryMetric label={t("pointsLabel")} value={t("points", { points })} />
        <SummaryMetric label={t("completionLabel")} value={`${completion}%`} />
      </dl>

      {preview.length > 0 && (
        <div className="grid gap-px border-y border-[var(--color-border)] bg-[var(--color-border-soft)] md:grid-cols-2">
          {preview.map((achievement) => (
          <AchievementCard key={achievement.id} achievement={achievement} />
          ))}
        </div>
      )}
    </section>
  );
}

function SummaryMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-[var(--color-surface)] px-4 py-4">
      <dt className="text-xs text-[var(--color-text-muted)]">{label}</dt>
      <dd className="mt-1 [font-family:var(--font-technical)] text-base font-bold tabular-nums text-[var(--color-text)]">{value}</dd>
    </div>
  );
}
