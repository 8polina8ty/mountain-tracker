"use client";

import {
  ArrowUpRight,
  CalendarDays,
  Map,
  Mountain,
  Route,
  Search,
  Upload,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";

import AccountNavigation from "@/components/account/AccountNavigation";
import AccountPageHeader from "@/components/account/AccountPageHeader";
import AscentMountainThumbnail from "@/components/account/AscentMountainThumbnail";
import AscentPhotoPrivacyToggle from "@/components/account/AscentPhotoPrivacyToggle";
import ChangeAscentPhotoButton from "@/components/account/ChangeAscentPhotoButton";
import { useAccount } from "@/hooks/useAccount";
import { Link } from "@/i18n/navigation";

export default function AscentsPage() {
  const t = useTranslations("Ascents");
  const format = useFormatter();
  const [searchInput, setSearchInput] = useState("");
  const [selectedYear, setSelectedYear] = useState("all");
  const [sortMode, setSortMode] = useState<
    "date-desc" | "date-asc" | "height-desc" | "height-asc" | "name"
  >("date-desc");
  const { user, loading, errorMessage, ascents, getMountainName } =
    useAccount();
  const [customImageUrls, setCustomImageUrls] = useState<
    Record<number, string>
  >({});
  const [photoPrivacy, setPhotoPrivacy] = useState<
    Record<number, boolean>
  >({});

  const displayedAscents = useMemo(() => {
    let result = [...ascents];

    if (searchInput.trim() !== "") {
      const search = searchInput.toLowerCase();
      result = result.filter((ascent) =>
        getMountainName(ascent.mountains).toLowerCase().includes(search),
      );
    }

    if (selectedYear !== "all") {
      result = result.filter((ascent) => {
        const date = new Date(ascent.climbed_at ?? ascent.created_at ?? "");
        return (
          !Number.isNaN(date.getTime()) &&
          date.getFullYear().toString() === selectedYear
        );
      });
    }

    result.sort((a, b) => {
      switch (sortMode) {
        case "date-asc":
          return (
            new Date(a.climbed_at ?? a.created_at ?? "").getTime() -
            new Date(b.climbed_at ?? b.created_at ?? "").getTime()
          );
        case "height-desc":
          return (b.mountains?.height ?? 0) - (a.mountains?.height ?? 0);
        case "height-asc":
          return (a.mountains?.height ?? 0) - (b.mountains?.height ?? 0);
        case "name":
          return getMountainName(a.mountains).localeCompare(
            getMountainName(b.mountains),
          );
        default:
          return (
            new Date(b.climbed_at ?? b.created_at ?? "").getTime() -
            new Date(a.climbed_at ?? a.created_at ?? "").getTime()
          );
      }
    });

    return result;
  }, [ascents, searchInput, selectedYear, sortMode, getMountainName]);

  const years = [
    ...new Set(
      ascents
        .map((ascent) => ascent.climbed_at ?? ascent.created_at)
        .filter(Boolean)
        .map((date) => new Date(date!).getFullYear()),
    ),
  ].sort((a, b) => b - a);

  if (loading) {
    return (
      <main className="flex min-h-[calc(100dvh-58px)] items-center justify-center bg-[var(--color-bg)] px-4 lg:min-h-[calc(100dvh-66px)]">
        <div className="border-l-2 border-[var(--color-forest)] bg-[var(--color-surface)] px-5 py-4 text-sm font-medium text-[var(--color-text-secondary)] shadow-[var(--shadow-control)]" role="status">
          {t("Status.loading")}
        </div>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="flex min-h-[calc(100dvh-58px)] items-center justify-center bg-[var(--color-bg)] px-4 lg:min-h-[calc(100dvh-66px)]">
        <section className="w-full max-w-lg border-y border-[var(--color-border-strong)] py-10 text-center">
          <p className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.1em] text-[var(--color-forest)]">
            {t("Status.loginEyebrow")}
          </p>
          <h1 className="mt-3 text-3xl font-bold text-[var(--color-text)]">
            {t("Status.loginTitle")}
          </h1>
          <p className="mt-3 text-[var(--color-text-muted)]">
            {t("Status.loginDescription")}
          </p>
          <Link href="/auth/login" className="ui-pressable mt-6 inline-flex min-h-11 items-center rounded-[var(--radius-control)] bg-[var(--color-forest)] px-5 py-2 font-semibold text-white hover:bg-[var(--color-forest-hover)]">
            {t("Status.login")}
          </Link>
        </section>
      </main>
    );
  }

  const filtersActive = searchInput.trim() !== "" || selectedYear !== "all";

  return (
    <main className="min-h-[calc(100dvh-58px)] bg-[var(--color-bg)] px-4 py-6 lg:min-h-[calc(100dvh-66px)] lg:px-6 lg:py-8">
      <div className="mx-auto max-w-7xl">
        <AccountNavigation />
        <AccountPageHeader
          eyebrow={t("Header.eyebrow")}
          title={t("Header.title")}
          description={t("Header.description")}
          metric={{ label: t("Header.totalRecords"), value: t("Header.ascentCount", { count: ascents.length }) }}
          actions={
            <>
              <Link href="/account/ascents/map" className="ui-pressable inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 text-sm font-semibold text-[var(--color-text)] hover:border-[var(--color-forest)]">
                <Map aria-hidden="true" className="h-4 w-4" />
                {t("Header.map")}
              </Link>
              <Link href="/account/tracks/import" className="ui-pressable inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-forest)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--color-forest-hover)]">
                <Upload aria-hidden="true" className="h-4 w-4" />
                {t("Header.importGpx")}
              </Link>
            </>
          }
        />

        {errorMessage && (
          <div className="mt-6 border-l-4 border-[var(--color-danger)] bg-[var(--color-danger-soft)] p-4 text-[var(--color-danger)]" role="alert">
            {errorMessage}
          </div>
        )}

        <section className="py-8" aria-labelledby="ascent-filter-title">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.075em] text-[var(--color-text-muted)]">
                {t("List.eyebrow")}
              </p>
              <h2 id="ascent-filter-title" className="mt-1 text-2xl font-bold text-[var(--color-text)]">
                {t("List.title")}
              </h2>
            </div>
            <p className="[font-family:var(--font-technical)] text-sm tabular-nums text-[var(--color-text-muted)]" role="status">
              {t("List.results", { shown: displayedAscents.length, total: ascents.length })}
            </p>
          </div>

          <div className="mt-5 grid gap-3 border-y border-[var(--color-border)] bg-[var(--color-surface)] p-4 md:grid-cols-[minmax(220px,1fr)_220px_180px]">
            <label className="relative">
              <span className="sr-only">{t("Filters.searchLabel")}</span>
              <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-subtle)]" />
              <input
                type="search"
                placeholder={t("Filters.searchPlaceholder")}
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                className="ui-field min-h-11 w-full rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] py-2 pl-10 pr-3 text-[var(--color-text)] outline-none"
              />
            </label>
            <label>
              <span className="sr-only">{t("Sorting.label")}</span>
              <select value={sortMode} onChange={(event) => setSortMode(event.target.value as typeof sortMode)} className="ui-field min-h-11 w-full rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2 text-[var(--color-text)]">
                <option value="date-desc">{t("Sorting.newest")}</option>
                <option value="date-asc">{t("Sorting.oldest")}</option>
                <option value="height-desc">{t("Sorting.highest")}</option>
                <option value="height-asc">{t("Sorting.lowest")}</option>
                <option value="name">{t("Sorting.alphabetical")}</option>
              </select>
            </label>
            <label>
              <span className="sr-only">{t("Filters.yearLabel")}</span>
              <select value={selectedYear} onChange={(event) => setSelectedYear(event.target.value)} className="ui-field min-h-11 w-full rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2 text-[var(--color-text)]">
                <option value="all">{t("Filters.allYears")}</option>
                {years.map((year) => (
                  <option key={year} value={year.toString()}>{year}</option>
                ))}
              </select>
            </label>
          </div>
        </section>

        {displayedAscents.length === 0 ? (
          <section className="border-y border-[var(--color-border-strong)] py-14 text-center">
            <Mountain aria-hidden="true" className="mx-auto h-9 w-9 text-[var(--color-forest)]" />
            <h2 className="mt-4 text-2xl font-bold text-[var(--color-text)]">
              {filtersActive ? t("List.noMatchesTitle") : t("List.emptyTitle")}
            </h2>
            <p className="mx-auto mt-2 max-w-lg text-[var(--color-text-muted)]">
              {filtersActive
                ? t("List.noMatchesDescription")
                : t("List.emptyDescription")}
            </p>
            {!filtersActive && (
              <Link href="/map" className="ui-pressable mt-6 inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-forest)] px-5 py-2 font-semibold text-white hover:bg-[var(--color-forest-hover)]">
                <Map aria-hidden="true" className="h-4 w-4" />
                {t("List.openMap")}
              </Link>
            )}
          </section>
        ) : (
          <section className="border-t border-[var(--color-border-strong)]" aria-label={t("Accessibility.ascentList")}>
            {displayedAscents.map((ascent, index) => {
              const mountainName = getMountainName(ascent.mountains);
              const customImageUrl = customImageUrls[ascent.id] ?? ascent.image_url ?? null;
              const isPhotoPublic = photoPrivacy[ascent.id] ?? ascent.is_photo_public;
              const climbedDate = ascent.climbed_at
                ? format.dateTime(new Date(ascent.climbed_at), {
                    day: "2-digit",
                    month: "long",
                    year: "numeric",
                  })
                : t("List.dateUnavailable");

              return (
                <article key={ascent.id} className="grid gap-5 border-b border-[var(--color-border)] py-5 md:grid-cols-[160px_minmax(0,1fr)] xl:grid-cols-[160px_minmax(0,1fr)_auto] xl:items-center">
                  <AscentMountainThumbnail wikidataId={ascent.mountains?.wikidata ?? null} mountainName={mountainName} customImageUrl={customImageUrl} />

                  <div className="min-w-0">
                    <p className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.075em] text-[var(--color-text-muted)]">
                      {t("List.recordNumber", { number: String(index + 1).padStart(2, "0") })}
                    </p>
                    <h2 className="mt-1 truncate text-2xl font-bold text-[var(--color-text)]">{mountainName}</h2>
                    <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm text-[var(--color-text-muted)]">
                      <div>
                        <dt className="sr-only">{t("List.elevation")}</dt>
                        <dd className="flex items-center gap-2 [font-family:var(--font-technical)] font-bold tabular-nums">
                          <Mountain aria-hidden="true" className="h-4 w-4 text-[var(--color-forest)]" />
                          {ascent.mountains?.height !== null && ascent.mountains?.height !== undefined ? format.number(ascent.mountains.height) : "—"} {t("Units.meter")}
                        </dd>
                      </div>
                      <div>
                        <dt className="sr-only">{t("List.date")}</dt>
                        <dd className="flex items-center gap-2">
                          <CalendarDays aria-hidden="true" className="h-4 w-4" />
                          {climbedDate}
                        </dd>
                      </div>
                      {ascent.mountains?.country_code && (
                        <div>
                          <dt className="sr-only">{t("List.region")}</dt>
                          <dd className="[font-family:var(--font-technical)] uppercase">{ascent.mountains.country_code}</dd>
                        </div>
                      )}
                    </dl>
                  </div>

                  <div className="flex min-w-0 flex-col gap-2 md:col-start-2 xl:col-start-auto xl:w-52">
                    <ChangeAscentPhotoButton
                      ascentId={ascent.id}
                      onPhotoChanged={(imageUrl) => {
                        setCustomImageUrls((currentUrls) => ({ ...currentUrls, [ascent.id]: imageUrl }));
                      }}
                    />
                    <AscentPhotoPrivacyToggle
                      ascentId={ascent.id}
                      initialIsPublic={isPhotoPublic}
                      hasCustomPhoto={Boolean(customImageUrl)}
                      onPrivacyChanged={(nextIsPublic) => {
                        setPhotoPrivacy((currentPrivacy) => ({ ...currentPrivacy, [ascent.id]: nextIsPublic }));
                      }}
                    />
                    {ascent.mountains?.id ? (
                      <Link href={`/mountain/${ascent.mountains.id}`} className="ui-pressable group inline-flex min-h-11 items-center justify-between gap-2 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm font-semibold text-[var(--color-text)] hover:border-[var(--color-forest)] hover:text-[var(--color-forest)]">
                        {t("List.openMountain")}
                        <ArrowUpRight aria-hidden="true" className="h-4 w-4 transition-transform duration-[var(--duration-fast)] ease-[var(--ease-standard)] group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                      </Link>
                    ) : (
                      <span className="inline-flex min-h-11 items-center rounded-[var(--radius-control)] border border-[var(--color-border-soft)] px-3 py-2 text-sm text-[var(--color-text-disabled)]">
                        {t("List.mountainUnavailable")}
                      </span>
                    )}
                  </div>
                </article>
              );
            })}
          </section>
        )}

        <div className="mt-8 flex justify-end">
          <Link href="/account/tracks" className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-[var(--color-forest)] hover:underline">
            <Route aria-hidden="true" className="h-4 w-4" />
            {t("List.openGpsTracks")}
          </Link>
        </div>
      </div>
    </main>
  );
}
