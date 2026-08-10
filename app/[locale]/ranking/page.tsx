"use client";

import Image from "next/image";
import { ArrowUpRight, Search } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";

import { createClient } from "@/Lib/supabase/client";
import { Link } from "@/i18n/navigation";

type RankingUser = {
  user_id: string;
  username: string;
  avatar_url: string | null;
  ascents_count: number;
  total_height: number;
  highest_mountain_height: number;
  highest_mountain_name: string | null;
  achievements_count: number;
};

type SortMode =
  | "ascents"
  | "total-height"
  | "highest-mountain"
  | "achievements";

export default function RankingPage() {
  const t = useTranslations("Ranking");
  const format = useFormatter();
  const [ranking, setRanking] = useState<RankingUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [sortMode, setSortMode] =
    useState<SortMode>("ascents");

  useEffect(() => {
    let cancelled = false;

    async function loadRanking() {
      setLoading(true);
      setErrorMessage("");

      const supabase = createClient();

      const { data, error } = await supabase.rpc(
        "get_user_ranking",
      );

      if (cancelled) {
        return;
      }

      if (error) {
        console.error(error);
        setErrorMessage(error.message);
        setLoading(false);
        return;
      }

      const loadedRanking: RankingUser[] = (
  (data ?? []) as Record<string, unknown>[]
).map((row) => ({
        user_id: String(row.user_id),
        username: String(
          row.username ?? t("Status.unknownUser"),
        ),
        avatar_url:
          typeof row.avatar_url === "string"
            ? row.avatar_url
            : null,
        ascents_count: Number(
          row.ascents_count ?? 0,
        ),
        total_height: Number(
          row.total_height ?? 0,
        ),
        highest_mountain_height: Number(
          row.highest_mountain_height ?? 0,
        ),
        highest_mountain_name:
          typeof row.highest_mountain_name === "string"
            ? row.highest_mountain_name
            : null,
        achievements_count: Number(
          row.achievements_count ?? 0,
        ),
      }));

      setRanking(loadedRanking);
      setLoading(false);
    }

    void loadRanking();

    return () => {
      cancelled = true;
    };
  }, [t]);

  const displayedRanking = useMemo(() => {
    const search = searchInput
      .trim()
      .toLocaleLowerCase("ru-RU");

    const result = ranking.filter((user) =>
      user.username
        .toLocaleLowerCase("ru-RU")
        .includes(search),
    );

    result.sort((first, second) => {
      switch (sortMode) {
        case "total-height":
          return (
            second.total_height -
            first.total_height
          );

        case "highest-mountain":
          return (
            second.highest_mountain_height -
            first.highest_mountain_height
          );

        case "achievements":
          return (
            second.achievements_count -
            first.achievements_count
          );

        default:
          return (
            second.ascents_count -
              first.ascents_count ||
            second.total_height -
              first.total_height
          );
      }
    });

    return result;
  }, [ranking, searchInput, sortMode]);

  const communityStats = useMemo(() => {
    return ranking.reduce(
      (stats, user) => {
        stats.totalUsers += 1;
        stats.totalAscents += user.ascents_count;
        stats.totalHeight += user.total_height;
        stats.totalAchievements +=
          user.achievements_count;

        return stats;
      },
      {
        totalUsers: 0,
        totalAscents: 0,
        totalHeight: 0,
        totalAchievements: 0,
      },
    );
  }, [ranking]);

  if (loading) {
    return (
      <main className="flex min-h-[calc(100dvh-58px)] items-center justify-center bg-[var(--color-bg)] px-4 lg:min-h-[calc(100dvh-66px)]">
        <div
          className="border-l-2 border-[var(--color-forest)] bg-[var(--color-surface)] px-5 py-4 text-sm font-medium text-[var(--color-text-secondary)] shadow-[var(--shadow-control)]"
          role="status"
        >
          {t("Status.loading")}
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-[calc(100dvh-58px)] bg-[var(--color-bg)] px-4 py-8 lg:min-h-[calc(100dvh-66px)] lg:px-6 lg:py-10">
      <div className="mx-auto max-w-7xl">
        <header className="border-b border-[var(--color-border-strong)] pb-8">
          <p className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.1em] text-[var(--color-forest)]">
            {t("Header.eyebrow")}
          </p>

          <h1 className="mt-3 text-4xl font-bold leading-tight text-[var(--color-text)] sm:text-5xl">
            {t("Header.title")}
          </h1>

          <p className="mt-3 max-w-2xl text-[var(--color-text-secondary)]">
            {t("Header.subtitle")}
          </p>
        </header>

        <section className="py-6" aria-labelledby="community-summary-title">
          <h2 id="community-summary-title" className="sr-only">
            {t("CommunityStats.heading")}
          </h2>
          <dl className="grid grid-cols-2 border-y border-[var(--color-border)] lg:grid-cols-4">
          <CommunityMetric
            label={t("CommunityStats.users")}
            value={format.number(communityStats.totalUsers)}
          />

          <CommunityMetric
            label={t("CommunityStats.ascents")}
            value={format.number(communityStats.totalAscents)}
          />

          <CommunityMetric
            label={t("CommunityStats.totalElevation")}
            value={`${format.number(communityStats.totalHeight)} ${t("Units.meter")}`}
          />

          <CommunityMetric
            label={t("CommunityStats.achievements")}
            value={format.number(communityStats.totalAchievements)}
          />
          </dl>
        </section>

        <section className="grid gap-3 border-b border-[var(--color-border-strong)] pb-6 md:grid-cols-[minmax(240px,1fr)_260px_auto] md:items-center" aria-label={t("Search.filtersLabel")}>
          <label className="relative">
            <span className="sr-only">{t("Search.label")}</span>
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]"
            />
            <input
              type="search"
              value={searchInput}
              onChange={(event) =>
                setSearchInput(event.target.value)
              }
              placeholder={t("Search.placeholder")}
              className="ui-field min-h-11 w-full rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] py-2 pl-10 pr-3 text-[var(--color-text)] outline-none"
            />
          </label>

          <label>
            <span className="sr-only">{t("Sorting.label")}</span>
            <select
              value={sortMode}
              onChange={(event) =>
                setSortMode(
                  event.target.value as SortMode,
                )
              }
              className="ui-field min-h-11 w-full rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2 text-[var(--color-text)]"
            >
              <option value="ascents">{t("Sorting.ascents")}</option>
              <option value="total-height">{t("Sorting.totalHeight")}</option>
              <option value="highest-mountain">{t("Sorting.highestMountain")}</option>
              <option value="achievements">{t("Sorting.achievements")}</option>
            </select>
          </label>

          <p className="[font-family:var(--font-technical)] text-xs tabular-nums text-[var(--color-text-muted)] md:text-right" role="status">
            {t("Search.shown", {
              shown: displayedRanking.length,
              total: ranking.length,
            })}
          </p>
        </section>

        {errorMessage && (
          <div
            className="mt-6 border-l-4 border-[var(--color-danger)] bg-[var(--color-danger-soft)] p-4 text-[var(--color-danger)]"
            role="alert"
          >
            {errorMessage}
          </div>
        )}

        <section className="pt-8" aria-labelledby="ranking-registry-title">
          <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.075em] text-[var(--color-text-muted)]">
                {t("Table.eyebrow")}
              </p>
              <h2 id="ranking-registry-title" className="mt-1 text-3xl font-bold text-[var(--color-text)]">
                {t("Table.title")}
              </h2>
            </div>
            <p className="max-w-md text-sm text-[var(--color-text-muted)]">
              {t("Table.sortingHint")}
            </p>
          </div>

          {displayedRanking.length === 0 ? (
            <div className="border-y border-[var(--color-border-strong)] py-12 text-center">
              <h3 className="text-xl font-bold text-[var(--color-text)]">
                {searchInput.trim()
                  ? t("Status.noResultsTitle")
                  : t("Status.emptyTitle")}
              </h3>
              <p className="mx-auto mt-2 max-w-md text-sm text-[var(--color-text-muted)]">
                {searchInput.trim()
                  ? t("Status.noResultsDescription")
                  : t("Status.emptyDescription")}
              </p>
            </div>
          ) : (
            <div className="border-t border-[var(--color-border-strong)]">
              <div className="hidden grid-cols-[72px_minmax(190px,1.2fr)_110px_150px_minmax(180px,1fr)_110px_52px] items-center border-b border-[var(--color-border)] px-3 py-3 lg:grid">
                <RegistryLabel>{t("Table.position")}</RegistryLabel>
                <RegistryLabel>{t("Table.participant")}</RegistryLabel>
                <RegistryLabel>{t("Table.ascents")}</RegistryLabel>
                <RegistryLabel>{t("Table.totalElevation")}</RegistryLabel>
                <RegistryLabel>{t("Table.highestPoint")}</RegistryLabel>
                <RegistryLabel>{t("Table.achievements")}</RegistryLabel>
                <span className="sr-only">{t("Table.profile")}</span>
              </div>
              <ol>
                {displayedRanking.map((user, index) => (
                  <RankingRow
                    key={user.user_id}
                    user={user}
                    position={index + 1}
                  />
                ))}
              </ol>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

type CommunityMetricProps = {
  label: string;
  value: string;
};

function CommunityMetric({
  label,
  value,
}: CommunityMetricProps) {
  return (
    <div className="min-w-0 border-b border-[var(--color-border-soft)] px-4 py-4 odd:border-r lg:border-b-0 lg:border-r lg:first:pl-0 lg:last:border-r-0 lg:last:pr-0">
      <dt className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.05em] text-[var(--color-text-muted)]">
        {label}
      </dt>

      <dd className="mt-2 break-words [font-family:var(--font-technical)] text-xl font-bold tabular-nums text-[var(--color-text)] sm:text-2xl">
        {value}
      </dd>
    </div>
  );
}

type RankingRowProps = {
  user: RankingUser;
  position: number;
};

function RankingRow({
  user,
  position,
}: RankingRowProps) {
  const t = useTranslations("Ranking");
  const format = useFormatter();
  const topRank = position <= 3;
  const formattedPosition = String(position).padStart(2, "0");

  return (
    <li>
      <article
        aria-label={t("Table.rowLabel", {
          position,
          username: user.username,
        })}
        className={[
          "border-b border-[var(--color-border)] transition-colors duration-[var(--duration-fast)] hover:bg-[var(--color-surface-raised)]",
          topRank
            ? "border-l-2 border-l-[var(--color-border-strong)] bg-[var(--color-surface)]"
            : "bg-transparent",
        ].join(" ")}
      >
        <div className="p-4 lg:hidden">
          <div className="flex items-start gap-3">
            <RankMarker position={formattedPosition} topRank={topRank} />
            <Avatar user={user} size="mobile" />
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-lg font-bold text-[var(--color-text)]">
                {user.username}
              </h3>
              <p className="mt-1 [font-family:var(--font-technical)] text-sm font-bold tabular-nums text-[var(--color-forest)]">
                {t("Counts.ascents", { count: user.ascents_count })}
              </p>
            </div>
          </div>

          <dl className="mt-4 grid grid-cols-2 gap-px border-y border-[var(--color-border-soft)] bg-[var(--color-border-soft)]">
            <RankingValue label={t("Table.totalElevation")} value={`${format.number(user.total_height)} ${t("Units.meter")}`} />
            <RankingValue label={t("Achievements.label")} value={t("Achievements.milestones", { count: format.number(user.achievements_count), total: format.number(111) })} />
            <RankingValue
              label={t("Table.highestPoint")}
              value={user.highest_mountain_name ?? t("Table.noData")}
              detail={user.highest_mountain_name ? `${format.number(user.highest_mountain_height)} ${t("Units.meter")}` : undefined}
              wide
            />
          </dl>

          <Link
            href={`/users/${user.user_id}`}
            className="ui-pressable group mt-3 inline-flex min-h-11 w-full items-center justify-between rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 text-sm font-semibold text-[var(--color-text)] hover:border-[var(--color-forest)] hover:text-[var(--color-forest)]"
          >
            {t("Table.openProfile")}
            <ArrowUpRight aria-hidden="true" className="h-4 w-4 transition-transform duration-[var(--duration-fast)] ease-[var(--ease-standard)] group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
          </Link>
        </div>

        <div className="hidden grid-cols-[72px_minmax(190px,1.2fr)_110px_150px_minmax(180px,1fr)_110px_52px] items-center px-3 py-4 lg:grid">
          <RankMarker position={formattedPosition} topRank={topRank} />
          <div className="flex min-w-0 items-center gap-3 pr-4">
            <Avatar user={user} size="desktop" />
            <h3 className="truncate font-bold text-[var(--color-text)]">
              {user.username}
            </h3>
          </div>
          <DesktopMetric value={format.number(user.ascents_count)} emphasize />
          <DesktopMetric value={`${format.number(user.total_height)} ${t("Units.meter")}`} />
          <div className="min-w-0 pr-4">
            <p className="truncate text-sm font-semibold text-[var(--color-text)]">
              {user.highest_mountain_name ?? t("Table.noData")}
            </p>
            {user.highest_mountain_name && (
              <p className="mt-0.5 [font-family:var(--font-technical)] text-xs tabular-nums text-[var(--color-text-muted)]">
                {format.number(user.highest_mountain_height)} {t("Units.meter")}
              </p>
            )}
          </div>
          <DesktopMetric value={t("Achievements.milestones", { count: format.number(user.achievements_count), total: format.number(111) })} />
          <Link
            href={`/users/${user.user_id}`}
            aria-label={t("Table.openUserProfile", {
              username: user.username,
            })}
            className="ui-pressable group inline-flex h-11 w-11 items-center justify-center rounded-[var(--radius-control)] border border-transparent text-[var(--color-text-muted)] hover:border-[var(--color-border)] hover:bg-[var(--color-surface)] hover:text-[var(--color-forest)]"
          >
            <ArrowUpRight aria-hidden="true" className="h-4 w-4 transition-transform duration-[var(--duration-fast)] ease-[var(--ease-standard)] group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
          </Link>
        </div>
      </article>
    </li>
  );
}

type RankingValueProps = {
  label: string;
  value: string;
  detail?: string;
  wide?: boolean;
};

function RankingValue({
  label,
  value,
  detail,
  wide = false,
}: RankingValueProps) {
  return (
    <div className={`min-w-0 bg-[var(--color-surface)] p-3 ${wide ? "col-span-2" : ""}`}>
      <dt className="[font-family:var(--font-technical)] text-[10px] font-bold uppercase tracking-[0.05em] text-[var(--color-text-muted)]">
        {label}
      </dt>

      <dd className="mt-1 truncate font-semibold text-[var(--color-text)]">
        {value}
        {detail && (
          <span className="ml-2 [font-family:var(--font-technical)] text-xs font-normal tabular-nums text-[var(--color-text-muted)]">
            {detail}
          </span>
        )}
      </dd>
    </div>
  );
}

function RegistryLabel({ children }: { children: string }) {
  return (
    <span className="[font-family:var(--font-technical)] text-[10px] font-bold uppercase tracking-[0.05em] text-[var(--color-text-muted)]">
      {children}
    </span>
  );
}

function RankMarker({
  position,
  topRank,
}: {
  position: string;
  topRank: boolean;
}) {
  const t = useTranslations("Ranking.Table");

  return (
    <div className="w-12 shrink-0 lg:w-auto">
      <p className="[font-family:var(--font-technical)] text-[10px] font-bold uppercase tracking-[0.05em] text-[var(--color-text-muted)]">
        {topRank ? t("topRank") : t("rank")}
      </p>
      <p className="mt-0.5 [font-family:var(--font-technical)] text-2xl font-bold tabular-nums text-[var(--color-text)]">
        {position}
      </p>
    </div>
  );
}

function Avatar({
  user,
  size,
}: {
  user: RankingUser;
  size: "mobile" | "desktop";
}) {
  const sizeClass = size === "mobile" ? "h-12 w-12" : "h-11 w-11";

  return (
    <div className={`relative flex ${sizeClass} shrink-0 items-center justify-center overflow-hidden rounded-full border border-[var(--color-border)] bg-[var(--color-surface-muted)] font-bold text-[var(--color-forest)]`}>
      {user.avatar_url ? (
        <Image
          src={user.avatar_url}
          alt=""
          fill
          sizes={size === "mobile" ? "48px" : "44px"}
          className="object-cover"
        />
      ) : (
        <span aria-hidden="true">{user.username.charAt(0).toUpperCase()}</span>
      )}
    </div>
  );
}

function DesktopMetric({
  value,
  emphasize = false,
}: {
  value: string;
  emphasize?: boolean;
}) {
  return (
    <p className={`pr-3 [font-family:var(--font-technical)] text-sm font-bold tabular-nums ${emphasize ? "text-[var(--color-forest)]" : "text-[var(--color-text)]"}`}>
      {value}
    </p>
  );
}
