import { Download, ShieldCheck } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";

import type { Locale } from "@/i18n/locales";
import { Link } from "@/i18n/navigation";
import CommunityRouteUpload from "./CommunityRouteUpload";

export type CommunityRouteView = {
  id: string; title: string; summary: string | null; author_display_name: string; validation_distance_m: number;
  validation_confidence: number; distance_m: number; elevation_gain_m: number;
  duration_seconds: number | null; published_at: string; total_count: number;
};

function duration(seconds: number | null): string {
  if (seconds === null) return "—";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${String(minutes).padStart(2, "0")}`;
}

export default async function CommunityRoutesSection({ locale, mountainId, mountainName, routes, count, page, pageSize, authenticated, searchParams }: {
  locale: Locale; mountainId: number; mountainName: string; routes: CommunityRouteView[]; count: number;
  page: number; pageSize: number; authenticated: boolean; searchParams: Record<string, string | string[] | undefined>;
}) {
  const t = await getTranslations({ locale, namespace: "Mountain.CommunityRoutes" });
  const format = await getFormatter({ locale });
  const pages = Math.max(1, Math.ceil(count / pageSize));
  function pageHref(nextPage: number) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(searchParams)) {
      if (key === "communityPage") continue;
      if (Array.isArray(value)) value.forEach((item) => query.append(key, item));
      else if (value !== undefined) query.set(key, value);
    }
    if (nextPage > 1) query.set("communityPage", String(nextPage));
    const suffix = query.toString();
    return `/mountain/${mountainId}${suffix ? `?${suffix}` : ""}`;
  }
  return (
    <section aria-labelledby="community-routes-title">
      <div className="flex flex-col gap-5 border-b border-[var(--color-border-strong)] pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="technical text-[var(--font-size-label)] font-bold uppercase tracking-[0.1em] text-[var(--color-pine)]">{t("sectionLabel")}</p>
          <h2 id="community-routes-title" className="mt-2 text-3xl font-bold sm:text-4xl">{t("title", { count })}</h2>
          <p className="mt-2 max-w-2xl text-sm text-[var(--color-text-muted)]">{t("description")}</p>
        </div>
        <CommunityRouteUpload mountainId={mountainId} mountainName={mountainName} authenticated={authenticated} />
      </div>
      {routes.length === 0 ? (
        <div className="border-b border-[var(--color-border)] py-10 text-center">
          <ShieldCheck aria-hidden="true" className="mx-auto text-[var(--color-text-subtle)]" size={32} />
          <p className="mt-4 font-bold">{t("empty")}</p>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">{t(authenticated ? "emptyAuthenticated" : "emptyAnonymous")}</p>
        </div>
      ) : (
        <div className="border-b border-[var(--color-border)]">
          <div className="technical hidden grid-cols-[7rem_minmax(0,1.4fr)_minmax(7rem,0.8fr)_minmax(10rem,1fr)_6rem_3rem] gap-3 border-b border-[var(--color-border)] py-2 text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--color-text-muted)] sm:grid">
            <span>{t("date")}</span><span>{t("route")}</span><span>{t("author")}</span><span>{t("routeData")}</span><span>{t("gpsMatch")}</span><span>{t("download")}</span>
          </div>
          <div className="divide-y divide-[var(--color-border-soft)]">
          {routes.map((route) => (
            <article key={route.id} className="grid gap-3 py-4 sm:grid-cols-[7rem_minmax(0,1.4fr)_minmax(7rem,0.8fr)_minmax(10rem,1fr)_6rem_3rem] sm:items-center">
              <time className="technical text-xs text-[var(--color-text-muted)]" dateTime={route.published_at}>{format.dateTime(new Date(route.published_at), { day: "2-digit", month: "short", year: "2-digit" })}</time>
              <div className="min-w-0"><Link href={`/mountain/${mountainId}/community-route/${route.id}`} className="ui-pressable block truncate font-bold hover:text-[var(--color-pine)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-pine)]">{route.title}</Link>{route.summary && <p className="mt-1 line-clamp-1 text-xs text-[var(--color-text-muted)]">{route.summary}</p>}</div>
              <p className="truncate text-sm text-[var(--color-text-secondary)]">{route.author_display_name}</p>
              <p className="technical text-xs tabular-nums text-[var(--color-text-secondary)]">{format.number(route.distance_m / 1000, { maximumFractionDigits: 1 })} km · ↑{format.number(route.elevation_gain_m)} m · {duration(route.duration_seconds)}</p>
              <span className="inline-flex min-h-7 w-fit items-center rounded-full bg-[var(--color-success-soft)] px-2 text-xs font-bold text-[var(--color-success)]">{t("gpsBadge", { confidence: format.number(route.validation_confidence * 100, { maximumFractionDigits: 0 }) })}</span>
              <a href={`/${locale}/mountain/${mountainId}/community-route/${route.id}/gpx`} aria-label={t("downloadLabel", { title: route.title })} className="ui-pressable grid h-11 w-11 place-items-center rounded-[var(--radius-control)] hover:bg-[var(--color-surface-muted)]"><Download aria-hidden="true" size={18} /></a>
            </article>
          ))}
          </div>
        </div>
      )}
      {pages > 1 && <nav aria-label={t("pagination")} className="mt-5 flex flex-wrap gap-2">{Array.from({ length: pages }, (_, index) => index + 1).map((number) => <Link key={number} href={pageHref(number)} aria-current={number === page ? "page" : undefined} className={`ui-pressable grid h-11 min-w-11 place-items-center rounded-[var(--radius-control)] border ${number === page ? "border-[var(--color-pine)] bg-[var(--color-surface-muted)]" : "border-[var(--color-border)]"}`}>{number}</Link>)}</nav>}
    </section>
  );
}
