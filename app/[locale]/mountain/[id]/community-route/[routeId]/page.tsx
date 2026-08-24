import { ArrowLeft, Download, MapPin, ShieldCheck } from "lucide-react";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";

import CommunityRouteEditor from "@/components/mountain/CommunityRouteEditor";
import CommunityRouteMap from "@/components/mountain/CommunityRouteMap";
import type { CommunityRouteContent, CommunityRouteType } from "@/Lib/tracks/communityRouteContent";
import { createAdminClient } from "@/Lib/supabase/admin";
import { createClient } from "@/Lib/supabase/server";
import type { Locale } from "@/i18n/locales";
import { Link } from "@/i18n/navigation";

type RouteRecord = CommunityRouteContent & {
  id: string; mountain_id: number; author_display_name: string; validation_distance_m: number;
  validation_confidence: number; distance_m: number; elevation_gain_m: number; duration_seconds: number | null;
  published_at: string; updated_at: string;
};

export default async function CommunityRoutePage({ params }: { params: Promise<{ locale: Locale; id: string; routeId: string }> }) {
  const { locale, id, routeId } = await params;
  const mountainId = Number(id);
  if (!Number.isSafeInteger(mountainId) || mountainId <= 0) notFound();
  const t = await getTranslations({ locale, namespace: "Mountain.CommunityRoutes" });
  const format = await getFormatter({ locale });
  const supabase = await createClient();
  const [{ data: routeData }, { data: mountain }, { data: auth }] = await Promise.all([
    supabase.rpc("get_published_mountain_community_route", {
      requested_route_id: routeId,
      requested_mountain_id: mountainId,
    }).maybeSingle(),
    supabase.from("mountains").select("name,name_de").eq("id", mountainId).maybeSingle(),
    supabase.auth.getUser(),
  ]);
  if (!routeData || !mountain) notFound();
  const route = routeData as RouteRecord;
  const mountainName = mountain.name_de ?? mountain.name ?? t("unknownMountain");
  let owner = false;
  if (auth.user) {
    const admin = createAdminClient();
    const { data: ownedRoute } = await admin
      .from("mountain_community_routes")
      .select("id")
      .eq("id", routeId)
      .eq("mountain_id", mountainId)
      .eq("user_id", auth.user.id)
      .eq("status", "published")
      .maybeSingle();
    owner = Boolean(ownedRoute);
  }
  const routeTypeKey = route.route_type === "via_ferrata" ? "viaFerrata" : route.route_type === "ski_touring" ? "skiTouring" : route.route_type;
  const difficulty = [route.difficulty_system, route.difficulty_value].filter(Boolean).join(" ");
  const duration = route.duration_seconds === null ? "—" : `${Math.floor(route.duration_seconds / 3600)}h ${String(Math.floor((route.duration_seconds % 3600) / 60)).padStart(2, "0")}`;
  const initial: CommunityRouteContent = {
    title: route.title, summary: route.summary, description: route.description, start_location: route.start_location,
    route_type: route.route_type as CommunityRouteType | null, difficulty_system: route.difficulty_system,
    difficulty_value: route.difficulty_value, best_season: route.best_season, equipment: route.equipment,
    warnings: route.warnings, conditions_notes: route.conditions_notes,
  };
  return <main className="min-h-[calc(100dvh-64px)] bg-[var(--color-bg)] px-4 py-8 lg:px-6 lg:py-12"><article className="mx-auto max-w-5xl">
    <Link href={`/mountain/${mountainId}`} className="ui-pressable inline-flex min-h-11 items-center gap-2 text-sm font-bold text-[var(--color-text-secondary)]"><ArrowLeft aria-hidden="true" size={17} />{mountainName}</Link>
    <header className="mt-5 border-y border-[var(--color-border-strong)] py-8"><p className="technical text-xs font-bold uppercase tracking-[0.1em] text-[var(--color-pine)]">{t("detailLabel")}</p><div className="mt-3 flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between"><div><h1 className="text-3xl font-bold sm:text-5xl">{route.title}</h1>{route.summary && <p className="mt-3 max-w-3xl whitespace-pre-line text-[var(--color-text-secondary)]">{route.summary}</p>}<p className="mt-3 text-sm text-[var(--color-text-muted)]">{route.author_display_name} · {format.dateTime(new Date(route.published_at), { dateStyle: "medium" })}</p></div>{owner && <CommunityRouteEditor routeId={route.id} initial={initial} />}</div></header>
    <div className="grid grid-cols-2 gap-px border-b border-[var(--color-border)] bg-[var(--color-border-soft)] sm:grid-cols-4">{[[t("distance"), `${format.number(route.distance_m / 1000, { maximumFractionDigits: 1 })} km`],[t("elevation"), `↑${format.number(route.elevation_gain_m)} m`],[t("duration"), duration],[t("gpsMatch"), `${format.number(route.validation_confidence * 100, { maximumFractionDigits: 0 })}%`]].map(([label,value]) => <div key={label} className="bg-[var(--color-surface)] p-4"><p className="technical text-xs text-[var(--color-text-muted)]">{label}</p><p className="mt-1 font-bold">{value}</p></div>)}</div>
    <CommunityRouteMap geojsonUrl={`/${locale}/mountain/${mountainId}/community-route/${route.id}/geojson`} routeName={route.title} />
    <div className="space-y-8 py-8">
      {route.description && <Content title={t("sections.description")} text={route.description} />}
      {(route.start_location || route.route_type || difficulty || route.best_season) && <section><h2 className="text-2xl font-bold">{t("sections.routeInfo")}</h2><dl className="mt-4 divide-y divide-[var(--color-border-soft)] border-y border-[var(--color-border)]">{route.start_location && <Info label={t("startLocation")} value={route.start_location} icon />}{routeTypeKey && <Info label={t("routeType")} value={t(`routeTypes.${routeTypeKey}`)} />}{difficulty && <Info label={t("difficulty")} value={difficulty} />}{route.best_season && <Info label={t("bestSeason")} value={route.best_season} />}</dl></section>}
      {route.equipment && <Content title={t("sections.preparation")} text={route.equipment} />}
      {route.warnings && <Content title={t("sections.safety")} text={route.warnings} warning />}
      {route.conditions_notes && <Content title={t("sections.conditions")} text={route.conditions_notes} />}
    </div>
    <div className="flex flex-wrap gap-3 border-t border-[var(--color-border)] pt-6"><a href={`/${locale}/mountain/${mountainId}/community-route/${route.id}/gpx`} className="ui-pressable inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-pine)] px-4 font-bold text-white"><Download aria-hidden="true" size={17} />{t("download")}</a><span className="inline-flex min-h-11 items-center gap-2 text-sm text-[var(--color-text-muted)]"><ShieldCheck aria-hidden="true" size={17} />{t("verifiedAt", { distance: format.number(route.validation_distance_m) })}</span></div>
  </article></main>;
}

function Content({ title, text, warning = false }: { title: string; text: string; warning?: boolean }) { return <section className={warning ? "border-l-4 border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-5" : ""}><h2 className="text-2xl font-bold">{title}</h2><p className="mt-3 whitespace-pre-line leading-7 text-[var(--color-text-secondary)]">{text}</p></section>; }
function Info({ label, value, icon = false }: { label: string; value: string; icon?: boolean }) { return <div className="grid gap-1 py-3 sm:grid-cols-[12rem_1fr]"><dt className="text-sm font-bold text-[var(--color-text-muted)]">{icon && <MapPin aria-hidden="true" className="mr-1 inline" size={14} />}{label}</dt><dd className="whitespace-pre-line">{value}</dd></div>; }
