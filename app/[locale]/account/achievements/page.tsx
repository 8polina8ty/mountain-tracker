import { getFormatter, getTranslations } from "next-intl/server";

import AccountNavigation from "@/components/account/AccountNavigation";
import AchievementArchive, {
  type AchievementArchiveItem,
} from "@/components/account/AchievementArchive";
import {
  ACHIEVEMENT_REGISTRY,
  evaluateAchievements,
  getAchievementChain,
  getAchievementPoints,
  isAchievementId,
} from "@/Lib/achievementRegistry";
import { getAchievementSnapshot } from "@/Lib/achievementSnapshot";
import { createClient } from "@/Lib/supabase/server";
import type { Locale } from "@/i18n/locales";
import { redirect } from "@/i18n/navigation";

type AchievementArchivePageProps = {
  params: Promise<{ locale: Locale }>;
};

export default async function AchievementArchivePage({
  params,
}: AchievementArchivePageProps) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Achievements.Archive" });
  const format = await getFormatter({ locale });
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();

  if (userError || !user) {
    return redirect({ href: "/auth/login", locale });
  }

  const [snapshotResult, persistedResult] = await Promise.allSettled([
    getAchievementSnapshot(supabase),
    supabase
      .from("user_achievements")
      .select("achievement_id, unlocked_at")
      .eq("user_id", user.id),
  ]);

  const snapshot = snapshotResult.status === "fulfilled"
    ? snapshotResult.value
    : null;
  const evaluationById = new Map(
    snapshot
      ? evaluateAchievements(snapshot).evaluations.map((evaluation) => [
          evaluation.achievementId,
          evaluation,
        ])
      : [],
  );

  const persistedRows = persistedResult.status === "fulfilled" &&
    !persistedResult.value.error
    ? persistedResult.value.data ?? []
    : [];
  const persistedAvailable = persistedResult.status === "fulfilled" &&
    !persistedResult.value.error;
  const unlockedAtById = new Map(
    persistedRows.flatMap((row) =>
      isAchievementId(row.achievement_id) &&
      typeof row.unlocked_at === "string" &&
      Number.isFinite(Date.parse(row.unlocked_at))
        ? [[row.achievement_id, row.unlocked_at] as const]
        : [],
    ),
  );

  const items: AchievementArchiveItem[] = ACHIEVEMENT_REGISTRY.map(
    (definition, registryIndex) => {
      const evaluation = evaluationById.get(definition.id);
      return {
        id: definition.id,
        translationKey: definition.translationKey,
        category: definition.category,
        metric: definition.metric,
        rarity: definition.rarity,
        points: definition.points,
        icon: definition.icon,
        target: definition.target,
        chainId: definition.chainId ?? null,
        tier: definition.tier ?? null,
        chainLength: definition.chainId
          ? getAchievementChain(definition.chainId).length
          : 1,
        registryIndex,
        current: evaluation?.current ?? null,
        progress: evaluation?.progress ?? null,
        reached: evaluation?.unlocked ?? null,
        unlockedAt: unlockedAtById.get(definition.id) ?? null,
      };
    },
  );

  const unlockedIds = [...unlockedAtById.keys()];
  const unlockedCount = unlockedIds.length;
  const points = unlockedIds.reduce(
    (total, id) => total + getAchievementPoints(id),
    0,
  );
  const completion = Math.round(
    (unlockedCount / ACHIEVEMENT_REGISTRY.length) * 100,
  );

  return (
    <main className="min-h-[calc(100dvh-58px)] bg-[var(--color-bg)] px-4 py-6 lg:min-h-[calc(100dvh-66px)] lg:px-6 lg:py-8">
      <div className="mx-auto max-w-7xl">
        <AccountNavigation />
        <header className="border-b border-[var(--color-border-strong)] py-10 sm:py-12">
          <p className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.1em] text-[var(--color-forest)]">
            {t("eyebrow")}
          </p>
          <div className="mt-3 grid gap-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
            <div className="max-w-3xl">
              <h1 className="text-4xl font-bold tracking-tight text-[var(--color-text)] sm:text-5xl">{t("title")}</h1>
              <p className="mt-4 max-w-2xl text-base leading-7 text-[var(--color-text-muted)]">{t("subtitle")}</p>
            </div>
            <dl className="grid grid-cols-3 gap-x-6 border-l border-[var(--color-border)] pl-5 [font-family:var(--font-technical)] sm:gap-x-8">
              <div>
                <dt className="text-xs text-[var(--color-text-muted)]">{t("summary.unlocked")}</dt>
                <dd className="mt-1 text-lg font-bold tabular-nums text-[var(--color-text)]">{persistedAvailable ? `${format.number(unlockedCount)} / ${format.number(ACHIEVEMENT_REGISTRY.length)}` : "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-[var(--color-text-muted)]">{t("summary.points")}</dt>
                <dd className="mt-1 text-lg font-bold tabular-nums text-[var(--color-text)]">{persistedAvailable ? format.number(points) : "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-[var(--color-text-muted)]">{t("summary.completion")}</dt>
                <dd className="mt-1 text-lg font-bold tabular-nums text-[var(--color-text)]">{persistedAvailable ? `${format.number(completion)}%` : "—"}</dd>
              </div>
            </dl>
          </div>
        </header>

        <AchievementArchive
          items={items}
          snapshotAvailable={Boolean(snapshot)}
          persistedAvailable={persistedAvailable}
        />
      </div>
    </main>
  );
}
