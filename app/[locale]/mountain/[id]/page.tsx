import type { LucideIcon } from "lucide-react";
import {
  ArrowLeft,
  Backpack,
  BadgeCheck,
  CalendarDays,
  Check,
  Clock3,
  Download,
  ExternalLink,
  Footprints,
  MapPin,
  Mountain,
  Navigation,
  Ruler,
  ShieldAlert,
  Sun,
  Users,
} from "lucide-react";
import Image from "next/image";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";

import { createClient } from "@/Lib/supabase/server";
import { getMountainImageFromWikidata } from "@/Lib/wikimedia";
import { getSummitWeather } from "@/Lib/weather/summitWeather";
import MountainRouteMap from "@/components/mountain/MountainRouteMap";
import SummitWeatherSection from "@/components/mountain/SummitWeatherSection";
import CommunityRoutesSection, { type CommunityRouteView } from "@/components/mountain/CommunityRoutesSection";
import ProjectPicker from "@/components/projects/ProjectPicker";

import FavoriteMountainToggle from "@/components/mountain/FavoriteMountainToggle";
import type { Locale } from "@/i18n/locales";
import { Link } from "@/i18n/navigation";
import {
  getLocalizedSeoUrls,
  getOpenGraphLocale,
} from "@/i18n/seo";

type MountainPageProps = {
  params: Promise<{
    locale: Locale;
    id: string;
  }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

type MountainRecord = {
  id: number;
  name: string | null;
  name_de: string | null;
  height: number;
  latitude: number | null;
  longitude: number | null;
  wikipedia: string | null;
  wikidata: string | null;
};

type MountainStatisticsAscent = {
  id: number;
  user_id: string;
  climbed_at: string | null;
  created_at: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
};

type MountainStatistics = {
  total_ascents: number;
  latest_ascent_at: string | null;
  user_has_climbed: boolean;
  recent_ascents: MountainStatisticsAscent[];
};

type MountainRoute = {
  id: number;
  mountain_id: number;
  name: string;
  start_location: string | null;
  route_type: string;
  difficulty_system: string | null;
  difficulty_value: string | null;
  distance_km: number | null;
  elevation_gain_m: number | null;
  duration_minutes: number | null;
  description: string | null;
  best_season: string | null;
  equipment: string | null;
  warnings: string | null;
  gpx_url: string | null;
  geojson_url: string | null;
  source_name: string | null;
  source_url: string | null;
  is_verified: boolean;
};

function getMountainName(mountain: MountainRecord, fallback: string): string {
  return mountain.name_de ?? mountain.name ?? fallback;
}

function getRouteTypeKey(routeType: string):
  | "hiking"
  | "mountaineering"
  | "viaFerrata"
  | "climbing"
  | "skiTouring"
  | "mixed"
  | "other"
  | "route" {
  switch (routeType) {
    case "hiking":
      return "hiking";
    case "mountaineering":
      return "mountaineering";
    case "via_ferrata":
      return "viaFerrata";
    case "climbing":
      return "climbing";
    case "ski_touring":
      return "skiTouring";
    case "mixed":
      return "mixed";
    case "other":
      return "other";
    default:
      return "route";
  }
}

type RouteValueProps = {
  icon: LucideIcon;
  label: string;
  value: string;
};

function RouteValue({ icon: Icon, label, value }: RouteValueProps) {
  return (
    <div className="min-w-0 border-l border-[var(--color-border)] pl-4 sm:pl-5">
      <div className="flex items-center gap-2 text-[var(--color-text-muted)]">
        <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
        <p className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.075em]">
          {label}
        </p>
      </div>

      <p className="mt-2 w-full min-w-0 break-words [font-family:var(--font-technical)] text-base font-bold tabular-nums text-[var(--color-text)] [overflow-wrap:anywhere] sm:text-lg">
        {value}
      </p>
    </div>
  );
}

type RouteInformationBlockProps = {
  icon: LucideIcon;
  title: string;
  text: string;
};

function RouteInformationBlock({
  icon: Icon,
  title,
  text,
}: RouteInformationBlockProps) {
  return (
    <div className="border-t border-[var(--color-border-soft)] pt-4">
      <h4 className="flex items-center gap-2 text-sm font-bold text-[var(--color-text)]">
        <Icon
          aria-hidden="true"
          className="h-4 w-4 text-[var(--color-forest)]"
        />
        {title}
      </h4>

      <p className="mt-2 whitespace-pre-line text-sm leading-6 text-[var(--color-text-secondary)]">
        {text}
      </p>
    </div>
  );
}

export async function generateMetadata({
  params,
}: MountainPageProps): Promise<Metadata> {
  const { id, locale } = await params;
  const t = await getTranslations({ locale, namespace: "Metadata.Mountain" });
  const format = await getFormatter({ locale });
  const { alternates, canonical } = getLocalizedSeoUrls(
    locale,
    `/mountain/${id}`,
  );
  const mountainId = Number(id);

  let title = t("fallbackTitle");
  let description = t("fallbackDescription");

  if (Number.isInteger(mountainId)) {
    const supabase = await createClient();
    const { data: mountain } = await supabase
      .from("mountains")
      .select("name, name_de, height")
      .eq("id", mountainId)
      .maybeSingle();

    if (mountain) {
      const mountainName = mountain.name_de ?? mountain.name;

      if (mountainName) {
        title = t("title", { name: mountainName });
        description = t("description", {
          name: mountainName,
          height: format.number(Number(mountain.height)),
        });
      }
    }
  }

  return {
    title,
    description,
    alternates,
    openGraph: {
      title,
      description,
      url: canonical ?? undefined,
      locale: getOpenGraphLocale(locale),
      type: "website",
    },
  };
}

export default async function MountainPage({ params, searchParams }: MountainPageProps) {
  const { id, locale } = await params;
  const activeSearchParams = (await searchParams) ?? {};
  const t = await getTranslations({ locale, namespace: "Mountain" });
  const format = await getFormatter({ locale });
  const mountainId = Number(id);

  if (!Number.isInteger(mountainId)) {
    notFound();
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: mountain, error } = await supabase
    .from("mountains")
    .select(
      `
        id,
        name,
        name_de,
        height,
        latitude,
        longitude,
        wikipedia,
        wikidata
      `,
    )
    .eq("id", mountainId)
    .maybeSingle();

  if (error) {
    console.error("Ошибка загрузки вершины:", error);
  }

  if (!mountain) {
    notFound();
  }

  const { data: routesData, error: routesError } = await supabase
    .from("mountain_routes")
    .select(
      `
        id,
        mountain_id,
        name,
        start_location,
        route_type,
        difficulty_system,
        difficulty_value,
        distance_km,
        elevation_gain_m,
        duration_minutes,
        description,
        best_season,
        equipment,
        warnings,
        gpx_url,
        geojson_url,
        source_name,
        source_url,
        is_verified
      `,
    )
    .eq("mountain_id", mountainId)
    .eq("is_verified", true)
    .order("id", {
      ascending: true,
    });

  if (routesError) {
    console.error("Ошибка загрузки маршрутов:", routesError);
  }

  const routes = (routesData ?? []) as MountainRoute[];

  const requestedCommunityPage = Number(Array.isArray(activeSearchParams.communityPage)
    ? activeSearchParams.communityPage[0]
    : activeSearchParams.communityPage);
  const communityPage = Number.isSafeInteger(requestedCommunityPage) && requestedCommunityPage > 0
    ? requestedCommunityPage
    : 1;
  const communityPageSize = 10;
  const communityStart = (communityPage - 1) * communityPageSize;
  const { data: communityRouteData } = await supabase.rpc(
    "list_published_mountain_community_routes",
    {
      requested_mountain_id: mountainId,
      requested_limit: communityPageSize,
      requested_offset: communityStart,
    },
  );
  const communityRoutes = (communityRouteData ?? []) as CommunityRouteView[];
  const communityRouteCount = Number(communityRoutes[0]?.total_count ?? 0);

  const { data: statisticsData, error: statisticsError } =
    await supabase.rpc("get_mountain_statistics", {
      p_mountain_id: mountainId,
    });

  if (statisticsError) {
    console.error(
      "Ошибка загрузки статистики вершины:",
      statisticsError,
    );
  }

  const statistics = statisticsData as MountainStatistics | null;
  const totalAscents = statistics?.total_ascents ?? 0;
  const latestAscentAt = statistics?.latest_ascent_at ?? null;
  const userHasClimbed = statistics?.user_has_climbed ?? false;
  const recentAscents = statistics?.recent_ascents ?? [];

  const favoriteResult = user
    ? await supabase
        .from("favorite_mountains")
        .select("id")
        .eq("user_id", user.id)
        .eq("mountain_id", mountainId)
        .maybeSingle()
    : null;

  const isFavorite = Boolean(favoriteResult?.data);
  const typedMountain = mountain as MountainRecord;
  const mountainName = getMountainName(typedMountain, t("Status.unnamed"));
  const mountainImage = await getMountainImageFromWikidata(
    typedMountain.wikidata,
  );
  const hasCoordinates =
    typedMountain.latitude !== null && typedMountain.longitude !== null;
  const coordinateText = hasCoordinates
    ? `${typedMountain.latitude!.toFixed(5)}, ${typedMountain.longitude!.toFixed(5)}`
    : null;

  const summitWeather = hasCoordinates
    ? await getSummitWeather({
        latitude: typedMountain.latitude!,
        longitude: typedMountain.longitude!,
        elevationM: Number(typedMountain.height),
      })
    : null;

  return (
    <main className="min-h-[calc(100dvh-58px)] bg-[var(--color-bg)] text-[var(--color-text)] lg:min-h-[calc(100dvh-66px)]">
      <div className="mx-auto max-w-7xl px-4 pb-16 pt-5 sm:pb-20 sm:pt-7 lg:px-6 lg:pb-24">
        <Link
          href="/map"
          className="ui-pressable inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-forest)]"
        >
          <ArrowLeft aria-hidden="true" size={17} />
          {t("Hero.backToMap")}
        </Link>

        <header className="mt-4 overflow-hidden border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-card)] lg:grid lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <div className="flex min-h-[350px] flex-col justify-between bg-[var(--color-surface-inverse)] px-5 py-7 text-[var(--color-text-inverse)] sm:min-h-[410px] sm:px-8 sm:py-10 lg:min-h-[440px] lg:px-10 lg:py-10">
            <div>
              <div className="flex items-center gap-2 [font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.1em] text-[var(--color-text-subtle)]">
                <Mountain aria-hidden="true" size={16} />
                {t("Hero.profile")}
              </div>

              <h1 className="mt-6 max-w-3xl break-words [overflow-wrap:anywhere] [font-family:var(--font-display)] text-[clamp(3rem,9vw,6.5rem)] font-bold leading-[0.88] tracking-[-0.035em]">
                {mountainName}
              </h1>

              {typedMountain.name && typedMountain.name !== mountainName && (
                <p className="mt-5 text-base text-[var(--color-text-subtle)] sm:text-lg">
                  {typedMountain.name}
                </p>
              )}
            </div>

            <div className="mt-10 flex flex-wrap items-end justify-between gap-6 border-t border-white/15 pt-6">
              <div>
                <p className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.09em] text-[var(--color-text-subtle)]">
                  {t("Hero.elevationAboveSeaLevel")}
                </p>
                <p className="mt-2 [font-family:var(--font-technical)] text-[clamp(2.5rem,7vw,4.5rem)] font-bold leading-none tabular-nums">
                  {format.number(typedMountain.height)}
                  <span className="ml-2 text-[0.42em] font-semibold text-[var(--color-text-subtle)]">
                    {t("Units.meter")}
                  </span>
                </p>
              </div>

              {user && userHasClimbed && (
                <div className="inline-flex min-h-10 items-center gap-2 border border-[var(--color-success-border)] bg-[var(--color-success-soft)] px-3 text-sm font-bold text-[var(--color-success)]">
                  <Check aria-hidden="true" size={17} />
                  {t("Ascent.summitReached")}
                </div>
              )}
            </div>
          </div>

          <div className="relative min-h-[300px] bg-[var(--color-bg-terrain)] sm:min-h-[400px] lg:min-h-[440px]">
            {mountainImage ? (
              <Image
                src={mountainImage.url}
                alt={t("Accessibility.mountainImage", { mountainName })}
                fill
                priority
                sizes="(max-width: 1023px) 100vw, 58vw"
                className="object-cover"
              />
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center overflow-hidden px-6 text-center text-[var(--color-text-secondary)]">
                <div className="absolute -left-16 top-10 h-48 w-[120%] rounded-[50%] border border-[var(--color-border-strong)] opacity-35" />
                <div className="absolute -left-8 top-24 h-48 w-[110%] rounded-[50%] border border-[var(--color-border-strong)] opacity-50" />
                <Mountain
                  aria-hidden="true"
                  className="relative text-[var(--color-granite)]"
                  size={92}
                  strokeWidth={1.2}
                />
                <p className="relative mt-6 [font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.16em]">
                  Alpine Survey
                </p>
                <p className="relative mt-2 max-w-xs text-sm text-[var(--color-text-muted)]">
                  {t("Hero.imageUnavailable")}
                </p>
              </div>
            )}

            {mountainImage && (
              <div className="absolute inset-x-0 bottom-0 bg-[#101713]/90 px-4 py-3 text-[var(--font-size-caption)] text-[#d8ddd8] sm:px-5">
                {t("Hero.photoCredit")}: Wikimedia Commons
                {mountainImage.license && <> · {mountainImage.license}</>}
                {mountainImage.descriptionUrl && (
                  <>
                    {" · "}
                    <a
                      href={mountainImage.descriptionUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 font-semibold text-white hover:underline"
                    >
                      {t("Hero.authorAndLicense")}
                      <ExternalLink aria-hidden="true" size={11} />
                    </a>
                  </>
                )}
              </div>
            )}
          </div>
        </header>

        <dl className="grid border-x border-b border-[var(--color-border)] bg-[var(--color-surface)] sm:grid-cols-3">
          <div className="border-b border-[var(--color-border-soft)] px-5 py-5 sm:border-b-0 sm:border-r sm:px-6">
            <dt className="flex items-center gap-2 [font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.075em] text-[var(--color-text-muted)]">
              <Navigation aria-hidden="true" size={14} />
              {t("Summary.coordinates")}
            </dt>
            <dd className="mt-2 [font-family:var(--font-technical)] text-sm font-bold tabular-nums text-[var(--color-text)]">
              {coordinateText ?? t("Status.noData")}
            </dd>
          </div>

          <div className="border-b border-[var(--color-border-soft)] px-5 py-5 sm:border-b-0 sm:border-r sm:px-6">
            <dt className="flex items-center gap-2 [font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.075em] text-[var(--color-text-muted)]">
              <Ruler aria-hidden="true" size={14} />
              {t("Summary.verifiedRoutes")}
            </dt>
            <dd className="mt-2 [font-family:var(--font-technical)] text-sm font-bold tabular-nums text-[var(--color-text)]">
              {t("Summary.routeCount", { count: routes.length })}
            </dd>
          </div>

          <div className="px-5 py-5 sm:px-6">
            <dt className="flex items-center gap-2 [font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.075em] text-[var(--color-text-muted)]">
              <Users aria-hidden="true" size={14} />
              {t("Summary.recordedAscents")}
            </dt>
            <dd className="mt-2 [font-family:var(--font-technical)] text-sm font-bold tabular-nums text-[var(--color-text)]">
              {t("Summary.ascentCount", { count: totalAscents })}
            </dd>
          </div>
        </dl>

        <div className="mt-12 grid items-start gap-12 lg:grid-cols-[minmax(0,1fr)_288px] lg:gap-10 xl:gap-14">
          <div className="min-w-0 space-y-16">
            <section aria-labelledby="overview-title">
              <div className="border-b border-[var(--color-border-strong)] pb-5">
                <p className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.1em] text-[var(--color-forest)]">
                  {t("Passport.sectionLabel")}
                </p>
                <h2
                  id="overview-title"
                  className="mt-2 text-3xl font-bold text-[var(--color-text)] sm:text-4xl"
                >
                  {t("Passport.title")}
                </h2>
              </div>

              <dl className="divide-y divide-[var(--color-border-soft)] border-b border-[var(--color-border)]">
                <div className="grid gap-2 py-5 sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-8">
                  <dt className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.075em] text-[var(--color-text-muted)]">
                    {t("Passport.primaryName")}
                  </dt>
                  <dd className="font-semibold text-[var(--color-text)]">
                    {mountainName}
                  </dd>
                </div>

                {typedMountain.name && typedMountain.name !== mountainName && (
                  <div className="grid gap-2 py-5 sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-8">
                    <dt className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.075em] text-[var(--color-text-muted)]">
                      {t("Passport.alternateName")}
                    </dt>
                    <dd className="text-[var(--color-text-secondary)]">
                      {typedMountain.name}
                    </dd>
                  </div>
                )}

                <div className="grid gap-2 py-5 sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-8">
                  <dt className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.075em] text-[var(--color-text-muted)]">
                    {t("Passport.elevation")}
                  </dt>
                  <dd className="[font-family:var(--font-technical)] font-bold tabular-nums text-[var(--color-text)]">
                    {format.number(typedMountain.height)} {t("Units.meter")}
                  </dd>
                </div>

                <div className="grid gap-2 py-5 sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-8">
                  <dt className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.075em] text-[var(--color-text-muted)]">
                    {t("Passport.location")}
                  </dt>
                  <dd className="[font-family:var(--font-technical)] text-sm font-semibold tabular-nums text-[var(--color-text-secondary)]">
                    {coordinateText ?? t("Status.coordinatesUnavailable")}
                  </dd>
                </div>
              </dl>
            </section>

            <SummitWeatherSection locale={locale} weather={summitWeather} />

            <section aria-labelledby="routes-title">
              <div className="flex flex-wrap items-end justify-between gap-5 border-b border-[var(--color-border-strong)] pb-5">
                <div>
                  <p className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.1em] text-[var(--color-forest)]">
                    {t("Routes.sectionLabel")}
                  </p>
                  <h2
                    id="routes-title"
                    className="mt-2 text-3xl font-bold text-[var(--color-text)] sm:text-4xl"
                  >
                    {t("Routes.title")}
                  </h2>
                  <p className="mt-3 max-w-2xl text-[var(--color-text-secondary)]">
                    {t("Routes.introduction")}
                  </p>
                </div>

                <div className="border-l border-[var(--color-border)] pl-4 text-right">
                  <p className="text-xs font-semibold text-[var(--color-text-muted)]">
                    {t("Routes.inProfile")}
                  </p>
                  <p className="mt-1 [font-family:var(--font-technical)] text-2xl font-bold tabular-nums text-[var(--color-text)]">
                    {t("Routes.routeCount", { count: routes.length })}
                  </p>
                </div>
              </div>

              {routes.length === 0 ? (
                <div className="border-b border-[var(--color-border)] py-12 text-center sm:py-16">
                  <Mountain
                    aria-hidden="true"
                    className="mx-auto text-[var(--color-text-subtle)]"
                    size={44}
                    strokeWidth={1.4}
                  />
                  <h3 className="mt-5 text-2xl font-bold text-[var(--color-text)]">
                    {t("Routes.emptyTitle")}
                  </h3>
                  <p className="mx-auto mt-2 max-w-lg text-[var(--color-text-muted)]">
                    {t("Routes.emptyDescription")}
                  </p>
                </div>
              ) : (
                <div>
                  {routes.map((route, routeIndex) => {
                    const hours =
                      route.duration_minutes !== null
                        ? Math.floor(route.duration_minutes / 60)
                        : null;
                    const minutes =
                      route.duration_minutes !== null
                        ? route.duration_minutes % 60
                        : null;
                    const durationText =
                      hours !== null && minutes !== null
                        ? [
                            hours > 0
                              ? t("Routes.duration.hours", { count: hours })
                              : "",
                            minutes > 0
                              ? t("Routes.duration.minutes", { count: minutes })
                              : "",
                          ]
                            .filter(Boolean)
                            .join(" ")
                        : null;
                    const difficultyText = [
                      route.difficulty_system,
                      route.difficulty_value,
                    ]
                      .filter(Boolean)
                      .join(" ");

                    return (
                      <article
                        key={route.id}
                        className="border-b border-[var(--color-border-strong)] py-10 sm:py-12"
                      >
                        <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 [font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.075em] text-[var(--color-text-muted)]">
                              <span>{t("Routes.routeNumber", { number: String(routeIndex + 1).padStart(2, "0") })}</span>
                              <span aria-hidden="true" className="h-px w-5 bg-[var(--color-border-strong)]" />
                              <span>{t(`Routes.routeTypes.${getRouteTypeKey(route.route_type)}`)}</span>
                            </div>

                            <h3 className="mt-3 break-words [overflow-wrap:anywhere] text-3xl font-bold leading-tight text-[var(--color-text)] sm:text-4xl">
                              {route.name}
                            </h3>

                            {route.start_location && (
                              <p className="mt-3 flex items-start gap-2 text-sm text-[var(--color-text-secondary)]">
                                <MapPin
                                  aria-hidden="true"
                                  className="mt-0.5 shrink-0 text-[var(--color-forest)]"
                                  size={16}
                                />
                                {t("Routes.startPoint")}: {route.start_location}
                              </p>
                            )}
                          </div>

                          {route.is_verified && (
                            <span className="inline-flex min-h-9 shrink-0 items-center gap-2 border border-[var(--color-success-border)] bg-[var(--color-success-soft)] px-3 text-xs font-bold text-[var(--color-success)]">
                              <BadgeCheck aria-hidden="true" size={15} />
                              {t("Routes.verified")}
                            </span>
                          )}
                        </div>

                        <div className="mt-8 grid grid-cols-2 gap-y-7 sm:grid-cols-4">
                          <RouteValue
                            label={t("RouteMetrics.distance")}
                            value={
                              route.distance_km !== null
                                ? `${format.number(Number(route.distance_km))} ${t("Units.kilometer")}`
                                : t("Status.notSpecified")
                            }
                            icon={Ruler}
                          />
                          <RouteValue
                            label={t("RouteMetrics.elevationGain")}
                            value={
                              route.elevation_gain_m !== null
                                ? `+${format.number(route.elevation_gain_m)} ${t("Units.meter")}`
                                : t("Status.notSpecified")
                            }
                            icon={Mountain}
                          />
                          <RouteValue
                            label={t("RouteMetrics.duration")}
                            value={durationText ?? t("Status.notSpecified")}
                            icon={Clock3}
                          />
                          <RouteValue
                            label={t("RouteMetrics.difficulty")}
                            value={difficultyText || t("Status.notSpecified")}
                            icon={Footprints}
                          />
                        </div>

                        {route.geojson_url && (
                          <MountainRouteMap
                            key={`${locale}-${route.id}`}
                            geojsonUrl={route.geojson_url}
                            routeName={route.name}
                          />
                        )}

                        {route.description && (
                          <div className="mt-8 grid gap-3 sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-8">
                            <h4 className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.075em] text-[var(--color-text-muted)]">
                              {t("Routes.description")}
                            </h4>
                            <p className="whitespace-pre-line leading-7 text-[var(--color-text-secondary)]">
                              {route.description}
                            </p>
                          </div>
                        )}

                        {(route.best_season || route.equipment) && (
                          <div className="mt-8 grid gap-6 sm:grid-cols-2">
                            {route.best_season && (
                              <RouteInformationBlock
                                title={t("Routes.bestSeason")}
                                icon={Sun}
                                text={route.best_season}
                              />
                            )}
                            {route.equipment && (
                              <RouteInformationBlock
                                title={t("Routes.equipment")}
                                icon={Backpack}
                                text={route.equipment}
                              />
                            )}
                          </div>
                        )}

                        {route.warnings && (
                          <div className="mt-8 border-l-4 border-[var(--color-warning)] bg-[var(--color-warning-soft)] px-4 py-4 sm:px-5">
                            <h4 className="flex items-center gap-2 font-bold text-[var(--color-warning)]">
                              <ShieldAlert aria-hidden="true" size={18} />
                              {t("Routes.warning")}
                            </h4>
                            <p className="mt-2 whitespace-pre-line text-sm leading-6 text-[var(--color-text-secondary)]">
                              {route.warnings}
                            </p>
                          </div>
                        )}

                        {(route.source_url || route.gpx_url) && (
                          <div className="mt-8 flex flex-wrap gap-3">
                            {route.gpx_url && (
                              <a
                                href={`/${locale}/mountain/${mountainId}/route/${route.id}/gpx`}
                                aria-label={t("Routes.downloadGpxFor", { routeName: route.name })}
                                className="ui-pressable inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-forest)] px-4 text-sm font-bold text-[var(--color-text-inverse)] hover:bg-[var(--color-forest-hover)]"
                              >
                                <Download aria-hidden="true" size={17} />
                                {t("Routes.downloadGpx")}
                              </a>
                            )}
                            {route.source_url && (
                              <a
                                href={route.source_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="ui-pressable inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 text-sm font-bold text-[var(--color-text-secondary)] hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-text)]"
                              >
                                {route.source_name
                                  ? t("Routes.sourceNamed", { sourceName: route.source_name })
                                  : t("Routes.source")}
                                <ExternalLink aria-hidden="true" size={15} />
                              </a>
                            )}
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              )}

              <div className="mt-6 flex items-start gap-3 border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-4 py-4 text-sm leading-6 text-[var(--color-text-secondary)] sm:px-5">
                <ShieldAlert
                  aria-hidden="true"
                  className="mt-0.5 shrink-0 text-[var(--color-warning)]"
                  size={18}
                />
                <p>
                  <strong className="text-[var(--color-text)]">
                    {t("Routes.safetyTitle")}
                  </strong>{" "}
                  {t("Routes.safetyDescription")}
                </p>
              </div>
            </section>

            <CommunityRoutesSection
              locale={locale}
              mountainId={mountainId}
              mountainName={mountainName}
              routes={communityRoutes}
              count={communityRouteCount ?? 0}
              page={communityPage}
              pageSize={communityPageSize}
              authenticated={Boolean(user)}
              searchParams={activeSearchParams}
            />

            <section aria-labelledby="recent-ascents-title">
              <div className="border-b border-[var(--color-border-strong)] pb-5">
                <p className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.1em] text-[var(--color-forest)]">
                  {t("Ascent.sectionLabel")}
                </p>
                <h2
                  id="recent-ascents-title"
                  className="mt-2 text-3xl font-bold text-[var(--color-text)] sm:text-4xl"
                >
                  {t("Ascent.recentAscents")}
                </h2>
              </div>

              {recentAscents.length === 0 ? (
                <p className="border-b border-[var(--color-border)] py-8 text-[var(--color-text-muted)]">
                  {t("Ascent.empty")}
                </p>
              ) : (
                <div className="divide-y divide-[var(--color-border-soft)] border-b border-[var(--color-border)]">
                  {recentAscents.map((ascent) => {
                    const username =
                      ascent.display_name ??
                      ascent.username ??
                      t("Status.userFallback");

                    return (
                      <article
                        key={ascent.id}
                        className="flex items-center justify-between gap-4 py-4"
                      >
                        <div className="flex min-w-0 items-center gap-3">
                          <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[var(--color-border)] bg-[var(--color-surface-muted)] font-bold text-[var(--color-forest)]">
                            {ascent.avatar_url ? (
                              <Image
                                src={ascent.avatar_url}
                                alt={username}
                                width={44}
                                height={44}
                                sizes="44px"
                                className="h-full w-full object-cover"
                              />
                            ) : (
                              username.charAt(0).toUpperCase()
                            )}
                          </div>

                          <div className="min-w-0">
                            <p className="truncate font-semibold text-[var(--color-text)]">
                              {username}
                            </p>
                            {ascent.user_id === user?.id && (
                              <p className="text-xs font-semibold text-[var(--color-success)]">
                                {t("Ascent.you")}
                              </p>
                            )}
                          </div>
                        </div>

                        <p className="shrink-0 [font-family:var(--font-technical)] text-xs tabular-nums text-[var(--color-text-muted)]">
                          {format.dateTime(
                            new Date(ascent.climbed_at ?? ascent.created_at),
                            { year: "numeric", month: "long", day: "numeric" },
                          )}
                        </p>
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
          </div>

          <aside className="space-y-10 lg:sticky lg:top-[90px]" aria-label={t("Accessibility.statusAndResources")}>
            <section aria-labelledby="ascent-status-title">
              <div className="border-b border-[var(--color-border-strong)] pb-4">
                <p className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.1em] text-[var(--color-forest)]">
                  {t("Ascent.statusLabel")}
                </p>
                <h2
                  id="ascent-status-title"
                  className="mt-2 text-2xl font-bold text-[var(--color-text)]"
                >
                  {t("Ascent.yourRecord")}
                </h2>
              </div>

              <div
                className={`mt-4 border-l-4 px-4 py-4 ${
                  user && userHasClimbed
                    ? "border-[var(--color-success)] bg-[var(--color-success-soft)]"
                    : "border-[var(--color-border-strong)] bg-[var(--color-surface-muted)]"
                }`}
              >
                <p
                  className={`flex items-center gap-2 font-bold ${
                    user && userHasClimbed
                      ? "text-[var(--color-success)]"
                      : "text-[var(--color-text-secondary)]"
                  }`}
                >
                  {user && userHasClimbed ? (
                    <Check aria-hidden="true" size={18} />
                  ) : (
                    <Mountain aria-hidden="true" size={18} />
                  )}
                  {!user
                    ? t("Ascent.loginRequired")
                    : userHasClimbed
                      ? t("Ascent.summitReached")
                      : t("Ascent.notClimbed")}
                </p>
                <p className="mt-2 text-sm leading-6 text-[var(--color-text-muted)]">
                  {!user
                    ? t("Ascent.loginDescription")
                    : userHasClimbed
                      ? t("Ascent.climbedDescription")
                      : t("Ascent.notClimbedDescription")}
                </p>
              </div>

              <dl className="mt-5 divide-y divide-[var(--color-border-soft)] border-y border-[var(--color-border)]">
                <div className="flex items-center justify-between gap-4 py-4">
                  <dt className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
                    <Users aria-hidden="true" size={16} />
                    {t("Ascent.totalRecords")}
                  </dt>
                  <dd className="[font-family:var(--font-technical)] font-bold tabular-nums text-[var(--color-text)]">
                    {t("Ascent.ascentCount", { count: totalAscents })}
                  </dd>
                </div>
                <div className="flex items-start justify-between gap-4 py-4">
                  <dt className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
                    <CalendarDays aria-hidden="true" size={16} />
                    {t("Ascent.latest")}
                  </dt>
                  <dd className="text-right text-sm font-semibold text-[var(--color-text)]">
                    {latestAscentAt
                      ? format.dateTime(new Date(latestAscentAt), {
                          year: "numeric",
                          month: "long",
                          day: "numeric",
                        })
                      : t("Ascent.noneYet")}
                  </dd>
                </div>
              </dl>

              {user && (
                <FavoriteMountainToggle
                  mountainId={typedMountain.id}
                  mountainName={mountainName}
                  locale={locale}
                  isFavorite={isFavorite}
                />
              )}
              <ProjectPicker
                mountainId={typedMountain.id}
                mountainName={mountainName}
                context="detail"
              />
            </section>

            <section aria-labelledby="external-resources-title">
              <div className="border-b border-[var(--color-border-strong)] pb-4">
                <p className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.1em] text-[var(--color-forest)]">
                  {t("Resources.sectionLabel")}
                </p>
                <h2
                  id="external-resources-title"
                  className="mt-2 text-2xl font-bold text-[var(--color-text)]"
                >
                  {t("Resources.title")}
                </h2>
              </div>

              <div className="mt-3 divide-y divide-[var(--color-border-soft)] border-b border-[var(--color-border)]">
                {hasCoordinates && (
                  <a
                    href={`https://www.openstreetmap.org/?mlat=${typedMountain.latitude}&mlon=${typedMountain.longitude}#map=15/${typedMountain.latitude}/${typedMountain.longitude}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ui-pressable flex min-h-12 items-center justify-between gap-3 py-3 text-sm font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-forest)]"
                  >
                    <span className="flex items-center gap-2">
                      <MapPin aria-hidden="true" size={16} />
                      OpenStreetMap
                    </span>
                    <ExternalLink aria-hidden="true" size={14} />
                  </a>
                )}

                {typedMountain.wikipedia && (
                  <a
                    href={`https://de.wikipedia.org/wiki/${encodeURIComponent(typedMountain.wikipedia)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ui-pressable flex min-h-12 items-center justify-between gap-3 py-3 text-sm font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-forest)]"
                  >
                    <span>Wikipedia</span>
                    <ExternalLink aria-hidden="true" size={14} />
                  </a>
                )}

                {typedMountain.wikidata && (
                  <a
                    href={`https://www.wikidata.org/wiki/${typedMountain.wikidata}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ui-pressable flex min-h-12 items-center justify-between gap-3 py-3 text-sm font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-forest)]"
                  >
                    <span>Wikidata</span>
                    <ExternalLink aria-hidden="true" size={14} />
                  </a>
                )}

                {mountainImage?.descriptionUrl && (
                  <a
                    href={mountainImage.descriptionUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ui-pressable flex min-h-12 items-center justify-between gap-3 py-3 text-sm font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-forest)]"
                  >
                    <span>Wikimedia Commons</span>
                    <ExternalLink aria-hidden="true" size={14} />
                  </a>
                )}

                {!hasCoordinates &&
                  !typedMountain.wikipedia &&
                  !typedMountain.wikidata &&
                  !mountainImage?.descriptionUrl && (
                    <p className="py-4 text-sm text-[var(--color-text-muted)]">
                      {t("Resources.empty")}
                    </p>
                  )}
              </div>
            </section>
          </aside>
        </div>
      </div>
    </main>
  );
}
