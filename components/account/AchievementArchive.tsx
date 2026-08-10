"use client";

import { useMemo, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";

import type {
  AchievementCategory,
  AchievementId,
  AchievementMetric,
  AchievementRarity,
} from "@/Lib/achievementRegistry";

export type AchievementArchiveItem = {
  id: AchievementId;
  translationKey: string;
  category: AchievementCategory;
  metric: AchievementMetric;
  rarity: AchievementRarity;
  points: number;
  icon: string;
  target: number;
  chainId: string | null;
  tier: number | null;
  chainLength: number;
  registryIndex: number;
  current: number | null;
  progress: number | null;
  reached: boolean | null;
  unlockedAt: string | null;
};

type AchievementArchiveProps = {
  items: AchievementArchiveItem[];
  snapshotAvailable: boolean;
  persistedAvailable: boolean;
};

type StatusFilter = "all" | "unlocked" | "inProgress";
type SortMode = "recommended" | "closest" | "rarity" | "unlockedDate";

const categories: Array<"all" | AchievementCategory> = [
  "all",
  "summits",
  "altitude",
  "geography",
  "gps",
  "participation",
  "photography",
  "planning",
];

const rarityOrder: Record<AchievementRarity, number> = {
  common: 0,
  uncommon: 1,
  rare: 2,
  epic: 3,
  legendary: 4,
};

const chainTranslationKeys: Record<string, string> = {
  "summit-explorer": "summits",
  "summit-elevation-total": "summitElevation",
  "highest-summit": "height",
  "altitude-zones": "zoneDiversity",
  countries: "countries",
  "gps-tracks": "gpsTracks",
  "gps-distance": "gpsDistance",
  "gps-elevation-gain": "gpsGain",
  "gps-linked-summits": "gpsLinked",
  "active-months": "activeMonths",
  "active-years": "activeYears",
  "summits-in-year": "yearSummits",
  "calendar-diversity": "calendarDiversity",
  "ascent-photos": "photos",
  favorites: "favorites",
};

function descriptionTarget(item: AchievementArchiveItem): number {
  return item.metric === "gpsDistanceM" ? item.target / 1000 : item.target;
}

export default function AchievementArchive({
  items,
  snapshotAvailable,
  persistedAvailable,
}: AchievementArchiveProps) {
  const t = useTranslations("Achievements");
  const [category, setCategory] = useState<"all" | AchievementCategory>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [sort, setSort] = useState<SortMode>("recommended");

  const visibleItems = useMemo(() => {
    const filtered = items.filter((item) => {
      if (category !== "all" && item.category !== category) return false;
      if (status === "unlocked" && !item.unlockedAt) return false;
      if (status === "inProgress" && (item.unlockedAt || item.progress === null)) {
        return false;
      }
      return true;
    });

    return filtered.sort((first, second) => {
      if (sort === "closest") {
        if (Boolean(first.unlockedAt) !== Boolean(second.unlockedAt)) {
          return first.unlockedAt ? 1 : -1;
        }
        return (second.progress ?? -1) - (first.progress ?? -1);
      }
      if (sort === "rarity") {
        return rarityOrder[second.rarity] - rarityOrder[first.rarity];
      }
      if (sort === "unlockedDate") {
        return (second.unlockedAt ? Date.parse(second.unlockedAt) : 0) -
          (first.unlockedAt ? Date.parse(first.unlockedAt) : 0);
      }
      return first.registryIndex - second.registryIndex;
    });
  }, [category, items, sort, status]);

  return (
    <section aria-labelledby="archive-records-title" className="py-8 sm:py-10">
      <h2 id="archive-records-title" className="sr-only">
        {t("Archive.recordsTitle")}
      </h2>

      {!snapshotAvailable && (
        <div className="mb-6 border-l-2 border-[var(--color-granite)] bg-[var(--color-surface)] px-4 py-3 text-sm text-[var(--color-text-secondary)]" role="status">
          {t("Archive.snapshotUnavailable")}
        </div>
      )}
      {!persistedAvailable && (
        <div className="mb-6 border-l-2 border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-4 py-3 text-sm text-[var(--color-danger)]" role="alert">
          {t("Archive.persistedUnavailable")}
        </div>
      )}

      <div className="space-y-4 border-y border-[var(--color-border-strong)] py-4">
        <fieldset>
          <legend className="mb-2 [font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
            {t("Archive.filters.category")}
          </legend>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {categories.map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={category === value}
                onClick={() => setCategory(value)}
                className={`ui-pressable min-h-11 shrink-0 rounded-[var(--radius-control)] border px-3 text-sm font-semibold ${category === value ? "border-[var(--color-forest)] bg-[var(--color-forest-soft)] text-[var(--color-forest)]" : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-raised)]"}`}
              >
                {value === "all" ? t("Archive.filters.all") : t(`Categories.${value}`)}
              </button>
            ))}
          </div>
        </fieldset>

        <div className="flex flex-wrap items-end justify-between gap-4">
          <fieldset>
            <legend className="mb-2 [font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
              {t("Archive.filters.status")}
            </legend>
            <div className="flex gap-2">
              {(["all", "unlocked", "inProgress"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={status === value}
                  onClick={() => setStatus(value)}
                  className={`ui-pressable min-h-11 rounded-[var(--radius-control)] border px-3 text-sm font-semibold ${status === value ? "border-[var(--color-forest)] bg-[var(--color-forest-soft)] text-[var(--color-forest)]" : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-raised)]"}`}
                >
                  {t(`Archive.filters.${value}`)}
                </button>
              ))}
            </div>
          </fieldset>

          <label className="grid gap-2 text-sm font-semibold text-[var(--color-text-secondary)]">
            <span className="[font-family:var(--font-technical)] text-[var(--font-size-label)] uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
              {t("Archive.sorting.label")}
            </span>
            <select
              value={sort}
              onChange={(event) => setSort(event.target.value as SortMode)}
              className="min-h-11 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[var(--color-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-forest)]"
            >
              {(["recommended", "closest", "rarity", "unlockedDate"] as const).map((value) => (
                <option key={value} value={value}>{t(`Archive.sorting.${value}`)}</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <p className="mt-5 [font-family:var(--font-technical)] text-xs tabular-nums text-[var(--color-text-muted)]">
        {t("Archive.visibleCount", { count: visibleItems.length })}
      </p>

      {visibleItems.length === 0 ? (
        <p className="mt-6 border-y border-[var(--color-border)] py-10 text-center text-[var(--color-text-muted)]">
          {t("Archive.empty")}
        </p>
      ) : (
        <div className="mt-4 grid gap-px border-y border-[var(--color-border)] bg-[var(--color-border-soft)] lg:grid-cols-2">
          {visibleItems.map((item) => (
            <AchievementArchiveRecord key={item.id} item={item} />
          ))}
        </div>
      )}
    </section>
  );
}

function AchievementArchiveRecord({ item }: { item: AchievementArchiveItem }) {
  const t = useTranslations("Achievements");
  const format = useFormatter();
  const title = t(`Definitions.${item.translationKey}.title`, {
    target: descriptionTarget(item),
  });
  const persisted = Boolean(item.unlockedAt);
  const reachedPending = !persisted && item.reached === true;
  const progressPercent = Math.round((item.progress ?? 0) * 100);
  const chainKey = item.chainId ? chainTranslationKeys[item.chainId] : null;

  return (
    <article className={`flex flex-col bg-[var(--color-surface)] p-5 sm:p-6 ${persisted ? "border-l-2 border-l-[var(--color-success)]" : "border-l-2 border-l-transparent"}`}>
      <div className="flex items-start justify-between gap-4">
        <p className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.08em] text-[var(--color-forest)]">
          {t(`Categories.${item.category}`)}
        </p>
        <span aria-hidden="true" className="text-lg text-[var(--color-text-muted)]">{item.icon}</span>
      </div>

      <h3 className="mt-3 text-xl font-bold text-[var(--color-text)]">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-[var(--color-text-muted)]">
        {t(`Definitions.${item.translationKey}.description`, {
          target: descriptionTarget(item),
        })}
      </p>

      <div className="mt-5">
        {item.progress === null || item.current === null ? (
          <p className="text-sm text-[var(--color-text-muted)]">{t("Archive.progressUnavailable")}</p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="font-semibold tabular-nums text-[var(--color-text-secondary)]">
                {formatMetric(item, format)}
              </span>
              <span className="tabular-nums text-[var(--color-text-muted)]">{format.number(progressPercent)}%</span>
            </div>
            <div
              className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--color-surface-muted)]"
              role="progressbar"
              aria-label={t("Accessibility.progress", { title })}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progressPercent}
            >
              <div className={`h-full rounded-full ${persisted ? "bg-[var(--color-success)]" : "bg-[var(--color-granite)]"}`} style={{ width: `${progressPercent}%` }} />
            </div>
          </>
        )}
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-x-2 gap-y-1 [font-family:var(--font-technical)] text-xs">
        <span className="font-bold text-[var(--color-text-secondary)]">{t(`Rarity.${item.rarity}`)}</span>
        <span aria-hidden="true" className="text-[var(--color-text-subtle)]">·</span>
        <span className="tabular-nums text-[var(--color-text-muted)]">{t("Archive.points", { points: format.number(item.points) })}</span>
      </div>

      {item.unlockedAt ? (
        <p className="mt-3 text-sm font-semibold text-[var(--color-success)]">
          {t("Archive.unlockedOn", { date: format.dateTime(new Date(item.unlockedAt), { year: "numeric", month: "long", day: "numeric" }) })}
        </p>
      ) : reachedPending ? (
        <p className="mt-3 text-sm font-semibold text-[var(--color-text-secondary)]">{t("Archive.reachedPending")}</p>
      ) : (
        <p className="mt-3 text-sm text-[var(--color-text-muted)]">{t("Archive.notUnlocked")}</p>
      )}

      {chainKey && item.tier && item.chainLength > 1 && (
        <div className="mt-auto pt-5" aria-label={t("Archive.chainAccessible", { current: item.tier, total: item.chainLength })}>
          <div className="flex items-center justify-between gap-3 text-xs text-[var(--color-text-muted)]">
            <span>{t(`Chains.${chainKey}`)}</span>
            <span className="tabular-nums">{t("Archive.tier", { current: item.tier, total: item.chainLength })}</span>
          </div>
          <div className="mt-2 flex gap-1" aria-hidden="true">
            {Array.from({ length: item.chainLength }, (_, index) => (
              <span key={index} className={`h-1 flex-1 ${index < item.tier! ? "bg-[var(--color-granite)]" : "bg-[var(--color-border)]"}`} />
            ))}
          </div>
        </div>
      )}
    </article>
  );
}

function formatMetric(
  item: AchievementArchiveItem,
  format: ReturnType<typeof useFormatter>,
): string {
  if (item.current === null) return "";
  const isDistance = item.metric === "gpsDistanceM";
  const usesMeters = item.metric === "summitElevationTotalM" ||
    item.metric === "maximumSummitElevationM" ||
    item.metric === "gpsElevationGainM";
  const current = isDistance ? item.current / 1000 : item.current;
  const target = isDistance ? item.target / 1000 : item.target;
  const suffix = isDistance ? " km" : usesMeters ? " m" : "";
  return `${format.number(current, { maximumFractionDigits: isDistance ? 1 : 0 })} / ${format.number(target, { maximumFractionDigits: isDistance ? 1 : 0 })}${suffix}`;
}
