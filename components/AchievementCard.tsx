"use client";

import { ACHIEVEMENT_MESSAGE_KEYS, type AchievementView } from "@/Lib/achievements";
import { useFormatter, useTranslations } from "next-intl";

type AchievementCardProps = {
  achievement: AchievementView;
};

export default function AchievementCard({
  achievement,
}: AchievementCardProps) {
  const t = useTranslations("Achievements");
  const format = useFormatter();
  const definitionKey = ACHIEVEMENT_MESSAGE_KEYS[achievement.id];
  const title = t(`Definitions.${definitionKey}.title`);
  const progressLabel = achievement.id === "above-clouds"
    ? t(achievement.unlocked ? "Progress.completed" : "Progress.aboveClouds")
    : achievement.id === "zugspitze"
      ? t(achievement.unlocked ? "Progress.completed" : "Progress.zugspitze")
      : achievement.id === "ten-thousand-height"
        ? t("Progress.height", { progress: format.number(achievement.progress), target: format.number(achievement.target) })
        : t("Progress.count", { progress: achievement.progress, target: achievement.target });
  const achievementProgress =
    achievement.target > 0
      ? Math.min(
          (achievement.progress / achievement.target) * 100,
          100,
        )
      : 0;

  return (
    <article
      className={`flex min-h-48 flex-col justify-between bg-[var(--color-surface)] p-5 sm:p-6 ${
        achievement.unlocked
          ? ""
          : "text-[var(--color-text-muted)]"
      }`}
    >
      <div>
        <div className="flex items-start justify-between gap-3">
          <div
            className={`flex h-10 w-10 items-center justify-center rounded-[var(--radius-sm)] border text-lg ${
              achievement.unlocked
                ? "border-[var(--color-success-border)] bg-[var(--color-success-soft)]"
                : "border-[var(--color-border)] bg-[var(--color-surface-muted)] grayscale"
            }`}
            aria-hidden="true"
          >
            {achievement.icon}
          </div>

          <span
            className={`[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.075em] ${
              achievement.unlocked
                ? "text-[var(--color-success)]"
                : "text-[var(--color-text-muted)]"
            }`}
          >
            {achievement.unlocked ? t("Status.unlocked") : t("Status.inProgress")}
          </span>
        </div>

        <h3 className="mt-4 text-xl font-bold text-[var(--color-text)]">
          {title}
        </h3>

        <p className="mt-2 text-sm leading-6 text-[var(--color-text-muted)]">
          {t(`Definitions.${definitionKey}.description`)}
        </p>

        {achievement.unlockedAt && (
          <p className="mt-3 [font-family:var(--font-technical)] text-xs text-[var(--color-success)]">
            {t("Card.received", { date: format.dateTime(new Date(achievement.unlockedAt), { year: "numeric", month: "long", day: "numeric" }) })}
          </p>
        )}
      </div>

      <div className="mt-5">
        <div className="flex items-center justify-between gap-3 text-xs font-semibold">
          <span className="text-[var(--color-text-muted)]">
            {progressLabel}
          </span>

          <span
            className={
              achievement.unlocked
                ? "text-[var(--color-success)]"
                : "text-[var(--color-text-muted)]"
            }
          >
            {Math.round(achievementProgress)}%
          </span>
        </div>

        <div
          className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--color-surface-muted)]"
          role="progressbar"
          aria-label={t("Accessibility.progress", { title })}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(achievementProgress)}
        >
          <div
            className={`ui-progress-fill h-full rounded-full ${
              achievement.unlocked
                ? "bg-[var(--color-success)]"
                : "bg-[var(--color-granite)]"
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
