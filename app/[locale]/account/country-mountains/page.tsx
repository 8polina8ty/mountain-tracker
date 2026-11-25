import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { requireCountryUser } from "@/Lib/auth/server";
import { isLocale } from "@/i18n/locales";
import { Link } from "@/i18n/navigation";
import { normalizeCountryMountainPage, normalizeCountryProgress, parseCountryMountainFilters } from "@/Lib/countryProgress";
import { getCountryName } from "@/Lib/countries";
import AccountNavigation from "@/components/account/AccountNavigation";
import BackButton from "@/components/navigation/BackButton";
import CountryProgressCard from "@/components/account/CountryProgressCard";

export default async function CountryMountainsPage({ params, searchParams }: {
  params: Promise<{ locale: string }>; searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const { supabase } = await requireCountryUser(locale, "/account/country-mountains");
  const t = await getTranslations({ locale, namespace: "Country" });
  const format = await getFormatter({ locale });
  const query = await searchParams;
  const filters = parseCountryMountainFilters(query);
  const results = await Promise.allSettled([
    supabase.rpc("get_my_country_mountain_progress"),
    filters ? supabase.rpc("list_my_country_mountains", filters) : Promise.resolve({ data: null, error: true }),
  ]);
  const summaryResult = results[0].status === "fulfilled" ? results[0].value : null;
  const listResult = results[1].status === "fulfilled" ? results[1].value : null;
  const progress = summaryResult && !summaryResult.error ? normalizeCountryProgress(summaryResult.data) : null;
  const candidateList = listResult && !listResult.error ? normalizeCountryMountainPage(listResult.data) : null;
  // A concurrent settings change must not mix two countries in the same dashboard.
  const list = candidateList?.countryCode === progress?.countryCode ? candidateList : null;
  const next = new URLSearchParams();
  if (filters) {
    if (filters.search) next.set("search", filters.search);
    if (filters.min_height !== null) next.set("min", String(filters.min_height));
    if (filters.max_height !== null) next.set("max", String(filters.max_height));
    next.set("climbed", filters.climbed_filter);
  }
  const firstPage = `/account/country-mountains?${next}`;
  if (list?.nextCursor) next.set("after", list.nextCursor);
  return <main className="mx-auto max-w-6xl space-y-6 px-4 py-8">
    <AccountNavigation /><BackButton fallback="/account" />
    <div className="space-y-2">
      <h1 className="text-[28px] font-bold tracking-tight">{t("countryMountains")}</h1>
      <div className="flex flex-wrap items-center gap-2">
        {progress?.countryCode ? <>
          <span aria-hidden="true" className="text-lg">{String.fromCodePoint(...[...progress.countryCode].map((c)=>0x1f1a5+c.charCodeAt(0)))}</span>
          <span className="rounded-full border border-[var(--color-border-soft)] bg-[var(--color-surface-muted)] px-3 py-1 text-xs font-semibold text-[var(--color-text-secondary)]">{t("countryRankingDescription", { country: getCountryName(progress.countryCode, locale) ?? progress.countryCode })}</span>
          <span className="text-xs tabular-nums text-[var(--color-text-muted)]">{progress.totalMountains} · {t("catalogMountains")}</span>
        </> : <p className="text-sm text-[var(--color-text-muted)]">{t("coverage")}</p>}
      </div>
    </div>
    {progress ? <CountryProgressCard progress={progress} /> : <p role="alert" className="border-l-4 border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-4 py-3 text-sm text-[var(--color-danger)]">{t("error")}</p>}
    {progress?.countryCode && <>
      <form method="get" action={`/${locale}/account/country-mountains`} className="grid gap-3 rounded-[var(--radius-card)] border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-xs)] sm:grid-cols-2 lg:grid-cols-[1.4fr_0.7fr_0.7fr_0.9fr] lg:items-end">
        <label className="space-y-2"><span className="block text-sm font-semibold">{t("searchMountains")}</span><input type="search" name="search" maxLength={100} defaultValue={filters?.search ?? ""} className="ui-field min-h-11 w-full px-3" /></label>
        <label className="space-y-2"><span className="block text-sm font-semibold">{t("minHeight")}</span><input type="number" step="any" name="min" defaultValue={filters?.min_height ?? ""} className="ui-field min-h-11 w-full px-3" /></label>
        <label className="space-y-2"><span className="block text-sm font-semibold">{t("maxHeight")}</span><input type="number" step="any" name="max" defaultValue={filters?.max_height ?? ""} className="ui-field min-h-11 w-full px-3" /></label>
        <label className="space-y-2"><span className="block text-sm font-semibold">{t("climbed")}</span><select name="climbed" defaultValue={filters?.climbed_filter ?? "all"} className="ui-field min-h-11 w-full px-3">
          <option value="all">{t("all")}</option><option value="climbed">{t("climbed")}</option><option value="unclimbed">{t("unclimbed")}</option>
        </select></label>
        <div className="flex flex-wrap gap-3 sm:col-span-2 lg:col-span-4"><button type="submit" className="ui-pressable min-h-11 rounded-[var(--radius-control)] bg-[var(--color-forest)] px-5 font-semibold text-[var(--color-text-inverse)] hover:bg-[var(--color-forest-hover)]">{t("applyFilters")}</button>
          <Link href="/account/country-mountains" className="ui-pressable inline-flex min-h-11 items-center px-3 text-[var(--color-forest)] underline">{t("resetFilters")}</Link></div>
      </form>
      {!filters ? <p role="alert" className="border-l-4 border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-4 py-3 text-sm text-[var(--color-danger)]">{t("invalidFilters")}</p> : !list ? <p role="alert" className="border-l-4 border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-4 py-3 text-sm text-[var(--color-danger)]">{t("error")}</p> :
        list.items.length === 0 ? <div className="rounded-[var(--radius-card)] border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] p-8 text-center"><p role="status" className="text-sm text-[var(--color-text-muted)]">{t("emptyResults")}</p></div> :
          <ul className="divide-y divide-[var(--color-border-soft)] overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border-soft)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)]">{list.items.map((mountain) => <li key={mountain.id} className="flex items-center gap-3 px-4 py-3 sm:px-5 hover:bg-[var(--color-surface-muted)]/60">
            <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-[11px] font-bold ${mountain.climbed ? "bg-[var(--color-success-soft)] text-[var(--color-success)]" : "bg-[var(--color-surface-muted)] text-[var(--color-text-muted)]"}`}>{mountain.climbed ? "✓" : "○"}</span>
            <div className="min-w-0 flex-1">
              <Link href={`/mountain/${mountain.id}`} className="ui-pressable text-[14px] font-semibold text-[var(--color-forest)] hover:underline">{(locale === "de" ? mountain.nameDe : null) || mountain.name || t("unnamedMountain")}</Link>
              <p className="text-xs tabular-nums text-[var(--color-text-muted)]">{mountain.height === null ? t("notAvailable") : `${format.number(mountain.height)} m`} · {getCountryName(mountain.countryCode, locale) ?? mountain.countryCode}</p>
            </div>
            <span className={`hidden shrink-0 text-xs font-semibold sm:inline ${mountain.climbed ? "text-[var(--color-success)]" : "text-[var(--color-text-muted)]"}`}>{t(mountain.climbed ? "climbed" : "unclimbed")}</span>
          </li>)}</ul>}
      <nav aria-label={t("pagination")} className="flex flex-wrap gap-4">
        {filters?.after_id && <Link href={firstPage} className="ui-pressable inline-flex min-h-11 items-center px-3 text-[var(--color-forest)] underline">{t("firstPage")}</Link>}
        {list?.nextCursor && <Link href={`/account/country-mountains?${next}`} className="ui-pressable inline-flex min-h-11 items-center rounded-[var(--radius-control)] bg-[var(--color-forest)] px-5 text-[var(--color-text-inverse)] hover:bg-[var(--color-forest-hover)]">{t("next")}</Link>}
      </nav>
    </>}
  </main>;
}
