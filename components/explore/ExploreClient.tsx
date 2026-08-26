"use client";

import { ArrowUpRight, MapPin, Mountain, Route, Search, SlidersHorizontal, Sun } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { PageHero, StatusPill } from "@/components/ui-v2";

type ExploreClientProps = {
  search: ReturnType<typeof import("@/Lib/projects/discovery").parsePublicExpeditionSearch>;
  result: { cards: Awaited<ReturnType<typeof import("@/Lib/projects/discovery").searchPublicExpeditions>>["cards"]; next: Awaited<ReturnType<typeof import("@/Lib/projects/discovery").searchPublicExpeditions>>["next"] };
  query: string;
};

export default function ExploreClient({ search, result, query }: ExploreClientProps) {
  const t = useTranslations("Explore");
  const format = useFormatter();

  return (
    <main className="min-h-[calc(100dvh-64px)] bg-[var(--color-bg)] px-4 py-8 lg:px-6 lg:py-12">
      <div className="mx-auto max-w-7xl space-y-10">
        <form method="get" className="space-y-5">
          <PageHero
            eyebrow={t("eyebrow")}
            title={t("title")}
            subtitle={t("description")}
            size="large"
            image="https://images.pexels.com/photos/33161529/pexels-photo-33161529.jpeg?auto=compress&cs=tinysrgb&w=1920&h=1080&fit=crop"
          >
            <div className="flex flex-wrap gap-3">
              <label className="flex flex-1 items-center gap-3 rounded-[var(--radius-control)] border border-white/20 bg-white/10 px-4 backdrop-blur-lg sm:max-w-md" htmlFor="explore-search">
                <span className="sr-only">{t("search")}</span>
                <Search aria-hidden="true" size={18} className="shrink-0 text-white/70" strokeWidth={2} />
                <input
                  id="explore-search"
                  name="q"
                  type="search"
                  maxLength={80}
                  defaultValue={search.q}
                  className="h-12 min-w-0 flex-1 bg-transparent text-[14px] text-white outline-none placeholder:text-white/50"
                  placeholder={t("placeholder")}
                />
              </label>
              <button type="submit" className="ui-pressable flex h-12 items-center gap-2 rounded-[var(--radius-control)] border border-white/20 bg-white/10 px-5 text-[14px] font-semibold text-white backdrop-blur-lg hover:bg-white/20">
                <Search aria-hidden="true" size={16} strokeWidth={2} />
                {t("search")}
              </button>
            </div>
          </PageHero>

          <fieldset className="grid gap-3 rounded-[var(--radius-card)] border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-xs)] sm:grid-cols-2 lg:grid-cols-6">
            <legend className="sr-only">{t("filters")}</legend>
            <FilterField label={t("year")} name="year" value={search.year} min={1900} max={2200} />
            <FilterField label={t("minDistance")} name="minDistance" value={search.minDistanceKm} min={0} max={10000} />
            <FilterField label={`${t("distance")} ≤`} name="maxDistance" value={search.maxDistanceKm} min={0} max={10000} />
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-semibold text-[var(--color-text-muted)]">{t("status")}</span>
              <select name="status" defaultValue={search.status ?? ""} className="ui-field min-h-11 w-full px-3">
                <option value="">{t("all")}</option>
                <option value="completed">{t("completed")}</option>
                <option value="archived">{t("archived")}</option>
              </select>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-semibold text-[var(--color-text-muted)]">{t("sort")}</span>
              <select name="sort" defaultValue={search.sort} className="ui-field min-h-11 w-full px-3">
                <option value="recent">{t("recent")}</option>
                <option value="distance">{t("distance")}</option>
                <option value="elevation">{t("elevation")}</option>
                <option value="duration">{t("duration")}</option>
              </select>
            </label>
            <label className="ui-pressable flex min-h-11 items-center gap-2 self-end rounded-[var(--radius-pill)] border border-[var(--color-border)] px-4 text-[13px] font-semibold text-[var(--color-text-secondary)]">
              <input type="checkbox" name="evidence" value="1" defaultChecked={search.evidence} />
              {t("gpsEvidence")}
            </label>
            <div className="flex flex-wrap items-center gap-2 sm:col-span-2 lg:col-span-6">
              <button type="submit" className="ui-pressable inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-pine)] px-5 text-[14px] font-semibold text-white hover:bg-[var(--color-pine-hover)]">
                <SlidersHorizontal aria-hidden="true" size={16} strokeWidth={2} />
                {t("apply")}
              </button>
              <Link href="/explore" className="ui-pressable inline-flex min-h-11 items-center px-4 text-[14px] font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text)]">
                {t("clear")}
              </Link>
            </div>
          </fieldset>
        </form>

        {/* Expedition Grid */}
        <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
          {result.cards.length === 0 ? (
            <div className="col-span-full py-16 text-center">
              <Mountain aria-hidden className="mx-auto text-[var(--color-pine)]" size={48} strokeWidth={1.5} />
              <p className="mt-4 font-bold text-[var(--color-text)]">
                {search.q ? (t("noResults") ?? "No results") : (t("none") ?? "No expeditions yet")}
              </p>
            </div>
          ) : (
            result.cards.map((card) => (
              <article
                key={card.slug}
                className="ui-pressable group overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border-soft)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)] hover:border-[var(--color-border-strong)] hover:shadow-[var(--shadow-card)]"
              >
                {/* Image */}
                <div className="relative h-44 overflow-hidden">
                  <div className="flex aspect-[16/7] items-center justify-center bg-[var(--color-surface-muted)]" role="img" aria-label={t("placeholderImage", { name: card.name })}>
                    <Mountain aria-hidden className="text-[var(--color-pine)]" size={38} strokeWidth={1.5} />
                  </div>
                  <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
                  <div className="absolute bottom-3 left-4">
                    <StatusPill
                      tone={card.status === "completed" ? "success" : "neutral"}
                      size="small"
                    >
                      {t(card.status) ?? card.status}
                    </StatusPill>
                  </div>
                </div>

                {/* Content */}
                <div className="p-5">
                  <h3 className="text-[18px] font-bold tracking-tight">
                    <Link href={`/expeditions/${card.slug}`} className="hover:underline">
                      {card.name}
                    </Link>
                  </h3>
                  <div className="mt-2 flex items-center gap-2 text-[14px] text-[var(--color-text-muted)]">
                    <MapPin size={14} strokeWidth={2} />
                    <span>{card.mountainNames.join(" · ") || (t("mountainsUnavailable") ?? "Mountains unavailable")}</span>
                  </div>

                  {/* Metrics */}
                  <div className="mt-4 flex items-center gap-5 border-t border-[var(--color-border-soft)] pt-4 text-[13px]">
                    <span className="technical flex items-center gap-1.5 font-semibold tabular-nums text-[var(--color-text-secondary)]">
                      <Sun size={14} strokeWidth={2} />
                      {card.dayCount}d
                    </span>
                    <span className="technical flex items-center gap-1.5 font-semibold tabular-nums text-[var(--color-text-secondary)]">
                      <Route size={14} strokeWidth={2} />
                      {format.number(card.totalDistanceM / 1000, { maximumFractionDigits: 1 })} km
                    </span>
                    <span className="technical flex items-center gap-1.5 font-semibold tabular-nums text-[var(--color-text-secondary)]">
                      <ArrowUpRight size={14} strokeWidth={2} />
                      {format.number(card.totalElevationGainM)} m
                    </span>
                  </div>
                </div>
              </article>
            ))
          )}
        </div>

        {result.next && (
          <nav aria-label={t("pagination") ?? "Pagination"} className="text-center">
            <Link
              href={`/explore?${new URLSearchParams([...new URLSearchParams(query).entries(), ["cursor", String(result.next.value)], ["after", result.next.slug]]).toString()}`}
              className="ui-pressable inline-flex min-h-11 items-center rounded-[var(--radius-control)] border px-5 font-bold"
            >
              {t("next") ?? "Next"}
            </Link>
          </nav>
        )}
      </div>
    </main>
  );
}

function FilterField({ label, name, value, min, max }: { label: string; name: "year" | "minDistance" | "maxDistance"; value: number | null; min: number; max: number }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-semibold text-[var(--color-text-muted)]">{label}</span>
      <input name={name} type="number" min={min} max={max} defaultValue={value ?? ""} className="ui-field min-h-11 w-full px-3" />
    </label>
  );
}
