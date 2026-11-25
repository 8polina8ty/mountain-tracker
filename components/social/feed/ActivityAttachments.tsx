"use client";
import { Link } from "@/i18n/navigation";
import { Trophy } from "lucide-react";
import { useTranslations } from "next-intl";
import { ACHIEVEMENT_DEFINITIONS_BY_ID } from "@/Lib/achievements";

export function AscentAttachment({ ascent }: { ascent: { mountainName: string | null; height: number; climbedAt: string | null; countryCode: string | null; mountainId: number } | null }) {
  const t = useTranslations("Social.Feed");
  if (!ascent) return <div className="rounded-xl border p-3 text-sm text-[var(--color-text-muted)]">{t("sourceUnavailable")}</div>;
  return (
    <div className="overflow-hidden rounded-xl border bg-[var(--color-surface)]">
      <div className="h-32 bg-[var(--color-surface-muted)]" />
      <div className="p-3">
        <p className="font-bold">{ascent.mountainName}</p>
        <p className="text-sm text-[var(--color-text-muted)]">{ascent.height} m {ascent.climbedAt ? new Date(ascent.climbedAt).toLocaleDateString() : ""} {ascent.countryCode ?? ""}</p>
        <Link href={`/mountain/${ascent.mountainId}`} className="ui-pressable mt-2 inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-semibold">{t("viewMountain")}</Link>
      </div>
    </div>
  );
}
export function AchievementAttachment({ achievement }: { achievement: { icon: string; achievementId: string; unlockedAt: string | null } | null }) {
  const t = useTranslations("Achievements");
  const tf = useTranslations("Social.Feed");
  if (!achievement || !ACHIEVEMENT_DEFINITIONS_BY_ID.has(achievement.achievementId as never)) return <div className="rounded-xl border p-3 text-sm">{tf("sourceUnavailable")}</div>;
  const def = ACHIEVEMENT_DEFINITIONS_BY_ID.get(achievement.achievementId as never);
  if (!def) return <div className="rounded-xl border p-3 text-sm">{tf("sourceUnavailable")}</div>;
  return (
    <div className="flex items-center gap-3 rounded-xl border bg-[var(--color-surface)] p-3">
      <span className="text-2xl">{def.icon}</span>
      <div>
        <p className="font-bold">{t(`Definitions.${def.id}.title`, { target: 1 } as never)}</p>
        <p className="text-xs text-[var(--color-text-muted)]">{tf("achievementUnlocked")} {achievement.unlockedAt ? new Date(achievement.unlockedAt).toLocaleDateString() : ""}</p>
      </div>
      <Trophy size={18} className="ml-auto" />
    </div>
  );
}
export function ExpeditionAttachment({ expedition }: { expedition: { title: string | null; slug: string | null; available: boolean } | null }) {
  const t = useTranslations("Social.Feed");
  if (!expedition || !expedition.available || !expedition.slug) return <div className="rounded-xl border p-3 text-sm">{t("sourceUnavailable")}</div>;
  return (
    <div className="rounded-xl border bg-[var(--color-surface)] p-3">
      <p className="text-xs font-bold uppercase text-[var(--color-forest)]">{t("completedExpedition")}</p>
      <p className="font-bold">{expedition.title ?? t("viewExpedition")}</p>
      <Link href={`/expeditions/${expedition.slug}`} className="ui-pressable mt-2 inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-semibold">{t("viewExpedition")}</Link>
    </div>
  );
}
