"use client";

import { ArrowUpRight, Mountain, Search, TrendingUp, Trophy, Footprints, Award } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";

import { createClient } from "@/Lib/supabase/client";
import { Link } from "@/i18n/navigation";
import { Avatar, Eyebrow, MetricRow } from "@/components/ui-v2";

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
  const [sortMode, setSortMode] = useState<SortMode>("ascents");

  useEffect(() => {
    let cancelled = false;

    async function loadRanking() {
      setLoading(true);
      setErrorMessage("");

      const supabase = createClient();

      const { data, error } = await supabase.rpc("get_user_ranking");

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
        username: String(row.username ?? t("Status.unknownUser")),
        avatar_url:
          typeof row.avatar_url === "string" ? row.avatar_url : null,
        ascents_count: Number(row.ascents_count ?? 0),
        total_height: Number(row.total_height ?? 0),
        highest_mountain_height: Number(row.highest_mountain_height ?? 0),
        highest_mountain_name:
          typeof row.highest_mountain_name === "string"
            ? row.highest_mountain_name
            : null,
        achievements_count: Number(row.achievements_count ?? 0),
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
    const search = searchInput.trim().toLocaleLowerCase("ru-RU");

    const result = ranking.filter((user) =>
      user.username.toLocaleLowerCase("ru-RU").includes(search),
    );

    result.sort((first, second) => {
      switch (sortMode) {
        case "total-height":
          return second.total_height - first.total_height;
        case "highest-mountain":
          return second.highest_mountain_height - first.highest_mountain_height;
        case "achievements":
          return second.achievements_count - first.achievements_count;
        default:
          return (
            second.ascents_count - first.ascents_count ||
            second.total_height - first.total_height
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
        stats.totalAchievements += user.achievements_count;
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
      <main className="flex min-h-[calc(100dvh-64px)] items-center justify-center bg-[var(--color-bg)] px-4">
        <div className="border-l-2 border-[var(--color-pine)] bg-[var(--color-surface)] px-5 py-4 text-sm font-medium text-[var(--color-text-secondary)] shadow-[var(--shadow-control)]" role="status">
          {t("Status.loading")}
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-[calc(100dvh-64px)] bg-[var(--color-bg)] px-4 py-8 lg:px-6 lg:py-12">
      <div className="mx-auto max-w-5xl space-y-10">
        {/* Compact Header */}
        <header className="space-y-6">
          <div>
            <Eyebrow>{t("Header.eyebrow")}</Eyebrow>
            <h1 className="mt-2 text-[28px] font-bold tracking-tight sm:text-[36px] lg:text-[40px]">{t("Header.title")}</h1>
            <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-[var(--color-text-muted)]">{t("Header.subtitle")}</p>
          </div>

          {/* Community Stats inline */}
          <MetricRow
            metrics={[
              { label: t("CommunityStats.users"), value: format.number(communityStats.totalUsers), icon: Search },
              { label: t("CommunityStats.ascents"), value: format.number(communityStats.totalAscents), icon: Mountain },
              { label: t("CommunityStats.totalElevation"), value: `${format.number(communityStats.totalHeight)} m`, icon: TrendingUp },
              { label: t("CommunityStats.achievements"), value: format.number(communityStats.totalAchievements), icon: Trophy },
            ]}
          />
        </header>

        {/* Search & Filters Bar */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-1 items-center gap-3 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 shadow-[var(--shadow-xs)] min-w-[240px]">
            <Search size={18} className="text-[var(--color-text-muted)]" strokeWidth={2} aria-hidden="true" />
            <input
              type="search"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder={t("Search.placeholder")}
              className="h-12 flex-1 bg-transparent text-[14px] outline-none placeholder:text-[var(--color-text-muted)]"
              aria-label={t("Search.label")}
            />
          </div>
          <div className="flex items-center gap-3">
            <select
              value={sortMode}
              onChange={(event) => setSortMode(event.target.value as SortMode)}
              className="ui-field px-4 text-[14px] min-w-[220px]"
              aria-label={t("Sorting.label")}
            >
              <option value="ascents">{t("Sorting.ascents")}</option>
              <option value="total-height">{t("Sorting.totalHeight")}</option>
              <option value="highest-mountain">{t("Sorting.highestMountain")}</option>
              <option value="achievements">{t("Sorting.achievements")}</option>
            </select>
            <p className="flex items-center px-3 text-[13px] text-[var(--color-text-muted)]">
              <span className="technical font-semibold">
                {t("Search.shown", { shown: displayedRanking.length, total: ranking.length })}
              </span>
            </p>
          </div>
        </div>

        {errorMessage && (
          <div className="rounded-[var(--radius-card)] border-l-4 border-[var(--color-danger)] bg-[var(--color-danger-soft)] p-5 text-[var(--color-danger)]" role="alert">
            {errorMessage}
          </div>
        )}

        {/* Ranking List */}
        <section aria-labelledby="ranking-list-heading">
          <h2 id="ranking-list-heading" className="sr-only">{t("Table.title")}</h2>

          {displayedRanking.length === 0 ? (
            <div className="rounded-[var(--radius-card)] border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] p-12 text-center">
              <h3 className="text-[18px] font-bold text-[var(--color-text)]">
                {searchInput.trim() ? t("Status.noResultsTitle") : t("Status.emptyTitle")}
              </h3>
              <p className="mx-auto mt-2 max-w-md text-[14px] leading-relaxed text-[var(--color-text-muted)]">
                {searchInput.trim() ? t("Status.noResultsDescription") : t("Status.emptyDescription")}
              </p>
            </div>
          ) : (
            <div className="rounded-[var(--radius-card)] border border-[var(--color-border-soft)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)] overflow-hidden">
              {/* Desktop Table */}
              <div className="hidden lg:grid" style={{ gridTemplateColumns: "64px 200px 100px 140px 200px 100px 56px" }}>
                {/* Header Row - static, normal flow */}
                <div className="bg-[var(--color-surface)] border-b border-[var(--color-border-soft)] px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)] technical">
                  <span>{t("Table.rank")}</span>
                </div>
                <div className="bg-[var(--color-surface)] border-b border-[var(--color-border-soft)] px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)] technical">
                  <div className="flex items-center gap-2">
                    <Footprints size={14} strokeWidth={2} className="text-[var(--color-pine)]" aria-hidden="true" />
                    <span>{t("Table.ascents")}</span>
                  </div>
                </div>
                <div className="bg-[var(--color-surface)] border-b border-[var(--color-border-soft)] px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)] technical">
                  <div className="flex items-center gap-2">
                    <TrendingUp size={14} strokeWidth={2} className="text-[var(--color-pine)]" aria-hidden="true" />
                    <span>{t("Table.totalElevation")}</span>
                  </div>
                </div>
                <div className="bg-[var(--color-surface)] border-b border-[var(--color-border-soft)] px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)] technical">
                  <div className="flex items-center gap-2">
                    <Mountain size={14} strokeWidth={2} className="text-[var(--color-pine)]" aria-hidden="true" />
                    <span>{t("Table.highestPoint")}</span>
                  </div>
                </div>
                <div className="bg-[var(--color-surface)] border-b border-[var(--color-border-soft)] px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)] technical">
                  <div className="flex items-center gap-2">
                    <Award size={14} strokeWidth={2} className="text-[var(--color-ochre)]" aria-hidden="true" />
                    <span>{t("Table.achievements")}</span>
                  </div>
                </div>
                <div className="bg-[var(--color-surface)] border-b border-[var(--color-border-soft)] px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)] technical">
                  <span className="sr-only">{t("Table.profile")}</span>
                </div>
              </div>

              {/* Body Rows */}
              <ol className="divide-y divide-[var(--color-border-soft)]" role="list">
                {displayedRanking.map((user, index) => (
                  <li key={user.user_id}>
                    {/* Desktop Row */}
                    <article className="hidden lg:grid items-center gap-4 p-4 transition-colors hover:bg-[var(--color-surface-muted)]" style={{ gridTemplateColumns: "64px 200px 100px 140px 200px 100px 56px" }}>
                      {/* Rank */}
                      <div className="text-center">
                        <p className="technical text-[10px] font-bold uppercase tracking-[0.05em] text-[var(--color-text-muted)]">
                          {index + 1 <= 3 ? t("Table.topRank") : t("Table.rank")}
                        </p>
                        <p className={`mt-0.5 technical text-2xl font-bold tabular-nums ${index === 0 ? "text-[var(--color-ochre)]" : index === 1 ? "text-[var(--color-granite)]" : index === 2 ? "text-[var(--color-stone)]" : "text-[var(--color-text)]"}`}>
                          {String(index + 1).padStart(2, "0")}
                        </p>
                      </div>

                      {/* Participant */}
                      <div className="flex min-w-0 items-center gap-3 pr-4">
                        <Avatar
                          initials={user.username.charAt(0).toUpperCase()}
                          size="md"
                          src={user.avatar_url ?? undefined}
                        />
                        <h3 className="truncate font-semibold text-[var(--color-text)]">{user.username}</h3>
                      </div>

                      {/* Ascents */}
                      <div className="technical font-semibold tabular-nums text-[var(--color-pine)]">
                        {format.number(user.ascents_count)}
                      </div>

                      {/* Total Elevation */}
                      <div className="technical font-semibold tabular-nums text-[var(--color-text)]">
                        {format.number(user.total_height)} m
                      </div>

                      {/* Highest Summit */}
                      <div className="min-w-0 pr-4">
                        <p className="truncate text-sm font-semibold text-[var(--color-text)]">
                          {user.highest_mountain_name ?? t("Table.noData")}
                        </p>
                        {user.highest_mountain_name && (
                          <p className="mt-0.5 technical text-xs tabular-nums text-[var(--color-text-muted)]">
                            {format.number(user.highest_mountain_height)} m
                          </p>
                        )}
                      </div>

                      {/* Achievements */}
                      <div className="technical font-semibold tabular-nums text-[var(--color-text)]">
                        {format.number(user.achievements_count)}
                      </div>

                      {/* Profile Action */}
                      <Link
                        href={`/users/${user.user_id}`}
                        aria-label={t("Table.openUserProfile", { username: user.username })}
                        className="ui-pressable group inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-control)] border border-transparent text-[var(--color-text-muted)] hover:border-[var(--color-border)] hover:bg-[var(--color-surface)] hover:text-[var(--color-pine)]"
                      >
                        <ArrowUpRight size={18} className="transition-transform duration-[var(--duration-fast)] ease-[var(--ease-standard)] group-hover:translate-x-0.5 group-hover:-translate-y-0.5" strokeWidth={2} aria-hidden="true" />
                      </Link>
                    </article>

                    {/* Mobile Card */}
                    <article className="lg:hidden p-4 border-b last:border-0 transition-colors hover:bg-[var(--color-surface-muted)]">
                      <div className="flex items-start gap-3">
                        {/* Rank + Avatar + Name */}
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          <div className="flex items-center justify-center w-12 h-12 shrink-0">
                            <div className={`grid h-full w-full place-items-center rounded-full text-[18px] font-bold ${index === 0 ? "bg-gradient-to-br from-[var(--color-ochre)] to-[var(--color-ochre-deep)] text-white" : index === 1 ? "bg-[var(--color-granite)] text-white" : index === 2 ? "bg-[var(--color-stone)] text-white" : "bg-[var(--color-surface-muted)] text-[var(--color-text)] border border-[var(--color-border)]"}`}>
                              {index + 1}
                            </div>
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <Avatar
                                initials={user.username.charAt(0).toUpperCase()}
                                size="md"
                                src={user.avatar_url ?? undefined}
                              />
                              <h3 className="truncate font-semibold text-[var(--color-text)]">{user.username}</h3>
                            </div>
                          </div>
                        </div>

                        {/* Profile Link */}
                        <Link
                          href={`/users/${user.user_id}`}
                          aria-label={t("Table.openUserProfile", { username: user.username })}
                          className="ui-pressable group inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-control)] border border-transparent text-[var(--color-text-muted)] hover:border-[var(--color-border)] hover:bg-[var(--color-surface)] hover:text-[var(--color-pine)]"
                        >
                          <ArrowUpRight size={18} className="transition-transform duration-[var(--duration-fast)] ease-[var(--ease-standard)] group-hover:translate-x-0.5 group-hover:-translate-y-0.5" strokeWidth={2} aria-hidden="true" />
                        </Link>
                      </div>

                      {/* Metrics Grid */}
                      <div className="mt-4 grid grid-cols-2 gap-3 text-center sm:grid-cols-4">
                        <div className="rounded-[var(--radius-control)] bg-[var(--color-surface-muted)] p-3">
                          <Footprints size={16} strokeWidth={2} className="mx-auto text-[var(--color-pine)]" aria-hidden="true" />
                          <p className="mt-1.5 technical text-lg font-bold tabular-nums text-[var(--color-pine)]">{format.number(user.ascents_count)}</p>
                          <p className="text-[11px] font-medium uppercase tracking-[0.05em] text-[var(--color-text-muted)]">{t("Table.ascents")}</p>
                        </div>
                        <div className="rounded-[var(--radius-control)] bg-[var(--color-surface-muted)] p-3">
                          <TrendingUp size={16} strokeWidth={2} className="mx-auto text-[var(--color-pine)]" aria-hidden="true" />
                          <p className="mt-1.5 technical text-lg font-bold tabular-nums text-[var(--color-text)]">{format.number(user.total_height)} m</p>
                          <p className="text-[11px] font-medium uppercase tracking-[0.05em] text-[var(--color-text-muted)]">{t("Table.totalElevation")}</p>
                        </div>
                        <div className="rounded-[var(--radius-control)] bg-[var(--color-surface-muted)] p-3">
                          <Mountain size={16} strokeWidth={2} className="mx-auto text-[var(--color-pine)]" aria-hidden="true" />
                          <p className="mt-1.5 text-sm font-semibold text-[var(--color-text)] truncate">{user.highest_mountain_name ?? t("Table.noData")}</p>
                          {user.highest_mountain_name && (
                            <p className="technical text-xs tabular-nums text-[var(--color-text-muted)]">{format.number(user.highest_mountain_height)} m</p>
                          )}
                          <p className="text-[11px] font-medium uppercase tracking-[0.05em] text-[var(--color-text-muted)]">{t("Table.highestPoint")}</p>
                        </div>
                        <div className="rounded-[var(--radius-control)] bg-[var(--color-surface-muted)] p-3">
                          <Award size={16} strokeWidth={2} className="mx-auto text-[var(--color-ochre)]" aria-hidden="true" />
                          <p className="mt-1.5 technical text-lg font-bold tabular-nums text-[var(--color-text)]">{format.number(user.achievements_count)}</p>
                          <p className="text-[11px] font-medium uppercase tracking-[0.05em] text-[var(--color-text-muted)]">{t("Table.achievements")}</p>
                        </div>
                      </div>
                    </article>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}