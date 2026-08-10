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
  Star,
  Sun,
  Users,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";

import { createClient } from "../../../Lib/supabase/server";
import { formatDate } from "@/Lib/utils";
import { getMountainImageFromWikidata } from "@/Lib/wikimedia";
import MountainRouteMap from "@/components/mountain/MountainRouteMap";

import { toggleFavoriteMountain } from "./actions";

type MountainPageProps = {
  params: Promise<{
    id: string;
  }>;
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

function getMountainName(mountain: MountainRecord): string {
  return mountain.name_de ?? mountain.name ?? "Без названия";
}

function getRouteTypeLabel(routeType: string): string {
  switch (routeType) {
    case "hiking":
      return "Пеший маршрут";
    case "mountaineering":
      return "Альпинистский маршрут";
    case "via_ferrata":
      return "Виа феррата";
    case "climbing":
      return "Скалолазный маршрут";
    case "ski_touring":
      return "Ски-тур";
    case "mixed":
      return "Смешанный маршрут";
    default:
      return "Маршрут";
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

export default async function MountainPage({ params }: MountainPageProps) {
  const { id } = await params;
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
  const mountainName = getMountainName(typedMountain);
  const mountainImage = await getMountainImageFromWikidata(
    typedMountain.wikidata,
  );
  const hasCoordinates =
    typedMountain.latitude !== null && typedMountain.longitude !== null;
  const coordinateText = hasCoordinates
    ? `${typedMountain.latitude!.toFixed(5)}, ${typedMountain.longitude!.toFixed(5)}`
    : null;

  return (
    <main className="min-h-[calc(100dvh-58px)] bg-[var(--color-bg)] text-[var(--color-text)] lg:min-h-[calc(100dvh-66px)]">
      <div className="mx-auto max-w-7xl px-4 pb-16 pt-5 sm:pb-20 sm:pt-7 lg:px-6 lg:pb-24">
        <Link
          href="/map"
          className="ui-pressable inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-forest)]"
        >
          <ArrowLeft aria-hidden="true" size={17} />
          Вернуться к карте
        </Link>

        <header className="mt-4 overflow-hidden border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-card)] lg:grid lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <div className="flex min-h-[350px] flex-col justify-between bg-[var(--color-surface-inverse)] px-5 py-7 text-[var(--color-text-inverse)] sm:min-h-[410px] sm:px-8 sm:py-10 lg:min-h-[440px] lg:px-10 lg:py-10">
            <div>
              <div className="flex items-center gap-2 [font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.1em] text-[var(--color-text-subtle)]">
                <Mountain aria-hidden="true" size={16} />
                Горный профиль
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
                  Высота над уровнем моря
                </p>
                <p className="mt-2 [font-family:var(--font-technical)] text-[clamp(2.5rem,7vw,4.5rem)] font-bold leading-none tabular-nums">
                  {typedMountain.height.toLocaleString("ru-RU")}
                  <span className="ml-2 text-[0.42em] font-semibold text-[var(--color-text-subtle)]">
                    м
                  </span>
                </p>
              </div>

              {user && userHasClimbed && (
                <div className="inline-flex min-h-10 items-center gap-2 border border-[var(--color-success-border)] bg-[var(--color-success-soft)] px-3 text-sm font-bold text-[var(--color-success)]">
                  <Check aria-hidden="true" size={17} />
                  Вершина покорена
                </div>
              )}
            </div>
          </div>

          <div className="relative min-h-[300px] bg-[var(--color-bg-terrain)] sm:min-h-[400px] lg:min-h-[440px]">
            {mountainImage ? (
              <Image
                src={mountainImage.url}
                alt={`Вершина ${mountainName}`}
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
                  Изображение вершины пока отсутствует
                </p>
              </div>
            )}

            {mountainImage && (
              <div className="absolute inset-x-0 bottom-0 bg-[#101713]/90 px-4 py-3 text-[var(--font-size-caption)] text-[#d8ddd8] sm:px-5">
                Фото: Wikimedia Commons
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
                      Автор и лицензия
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
              Координаты
            </dt>
            <dd className="mt-2 [font-family:var(--font-technical)] text-sm font-bold tabular-nums text-[var(--color-text)]">
              {coordinateText ?? "Нет данных"}
            </dd>
          </div>

          <div className="border-b border-[var(--color-border-soft)] px-5 py-5 sm:border-b-0 sm:border-r sm:px-6">
            <dt className="flex items-center gap-2 [font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.075em] text-[var(--color-text-muted)]">
              <Ruler aria-hidden="true" size={14} />
              Проверенные маршруты
            </dt>
            <dd className="mt-2 [font-family:var(--font-technical)] text-sm font-bold tabular-nums text-[var(--color-text)]">
              {routes.length.toLocaleString("ru-RU")}
            </dd>
          </div>

          <div className="px-5 py-5 sm:px-6">
            <dt className="flex items-center gap-2 [font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.075em] text-[var(--color-text-muted)]">
              <Users aria-hidden="true" size={14} />
              Отмечено восхождений
            </dt>
            <dd className="mt-2 [font-family:var(--font-technical)] text-sm font-bold tabular-nums text-[var(--color-text)]">
              {totalAscents.toLocaleString("ru-RU")}
            </dd>
          </div>
        </dl>

        <div className="mt-12 grid items-start gap-12 lg:grid-cols-[minmax(0,1fr)_288px] lg:gap-10 xl:gap-14">
          <div className="min-w-0 space-y-16">
            <section aria-labelledby="overview-title">
              <div className="border-b border-[var(--color-border-strong)] pb-5">
                <p className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.1em] text-[var(--color-forest)]">
                  01 / Обзор
                </p>
                <h2
                  id="overview-title"
                  className="mt-2 text-3xl font-bold text-[var(--color-text)] sm:text-4xl"
                >
                  Паспорт вершины
                </h2>
              </div>

              <dl className="divide-y divide-[var(--color-border-soft)] border-b border-[var(--color-border)]">
                <div className="grid gap-2 py-5 sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-8">
                  <dt className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.075em] text-[var(--color-text-muted)]">
                    Основное название
                  </dt>
                  <dd className="font-semibold text-[var(--color-text)]">
                    {mountainName}
                  </dd>
                </div>

                {typedMountain.name && typedMountain.name !== mountainName && (
                  <div className="grid gap-2 py-5 sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-8">
                    <dt className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.075em] text-[var(--color-text-muted)]">
                      Альтернативное название
                    </dt>
                    <dd className="text-[var(--color-text-secondary)]">
                      {typedMountain.name}
                    </dd>
                  </div>
                )}

                <div className="grid gap-2 py-5 sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-8">
                  <dt className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.075em] text-[var(--color-text-muted)]">
                    Высота
                  </dt>
                  <dd className="[font-family:var(--font-technical)] font-bold tabular-nums text-[var(--color-text)]">
                    {typedMountain.height.toLocaleString("ru-RU")} м
                  </dd>
                </div>

                <div className="grid gap-2 py-5 sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-8">
                  <dt className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.075em] text-[var(--color-text-muted)]">
                    Геопозиция
                  </dt>
                  <dd className="[font-family:var(--font-technical)] text-sm font-semibold tabular-nums text-[var(--color-text-secondary)]">
                    {coordinateText ?? "Координаты отсутствуют"}
                  </dd>
                </div>
              </dl>
            </section>

            <section aria-labelledby="routes-title">
              <div className="flex flex-wrap items-end justify-between gap-5 border-b border-[var(--color-border-strong)] pb-5">
                <div>
                  <p className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.1em] text-[var(--color-forest)]">
                    02 / Маршруты
                  </p>
                  <h2
                    id="routes-title"
                    className="mt-2 text-3xl font-bold text-[var(--color-text)] sm:text-4xl"
                  >
                    Линии восхождения
                  </h2>
                  <p className="mt-3 max-w-2xl text-[var(--color-text-secondary)]">
                    Проверенные варианты подъёма. Перед выходом уточняйте
                    погоду, состояние маршрута и актуальные ограничения.
                  </p>
                </div>

                <div className="border-l border-[var(--color-border)] pl-4 text-right">
                  <p className="text-xs font-semibold text-[var(--color-text-muted)]">
                    В профиле
                  </p>
                  <p className="mt-1 [font-family:var(--font-technical)] text-2xl font-bold tabular-nums text-[var(--color-text)]">
                    {routes.length.toLocaleString("ru-RU")}
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
                    Маршруты пока не добавлены
                  </h3>
                  <p className="mx-auto mt-2 max-w-lg text-[var(--color-text-muted)]">
                    Для этой вершины ещё нет проверенного описания подъёма.
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
                            hours > 0 ? `${hours} ч` : "",
                            minutes > 0 ? `${minutes} мин` : "",
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
                              <span>Маршрут {String(routeIndex + 1).padStart(2, "0")}</span>
                              <span aria-hidden="true" className="h-px w-5 bg-[var(--color-border-strong)]" />
                              <span>{getRouteTypeLabel(route.route_type)}</span>
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
                                Старт: {route.start_location}
                              </p>
                            )}
                          </div>

                          {route.is_verified && (
                            <span className="inline-flex min-h-9 shrink-0 items-center gap-2 border border-[var(--color-success-border)] bg-[var(--color-success-soft)] px-3 text-xs font-bold text-[var(--color-success)]">
                              <BadgeCheck aria-hidden="true" size={15} />
                              Проверено
                            </span>
                          )}
                        </div>

                        <div className="mt-8 grid grid-cols-2 gap-y-7 sm:grid-cols-4">
                          <RouteValue
                            label="Расстояние"
                            value={
                              route.distance_km !== null
                                ? `${Number(route.distance_km).toLocaleString("ru-RU")} км`
                                : "Не указано"
                            }
                            icon={Ruler}
                          />
                          <RouteValue
                            label="Набор высоты"
                            value={
                              route.elevation_gain_m !== null
                                ? `+${route.elevation_gain_m.toLocaleString("ru-RU")} м`
                                : "Не указано"
                            }
                            icon={Mountain}
                          />
                          <RouteValue
                            label="Время"
                            value={durationText ?? "Не указано"}
                            icon={Clock3}
                          />
                          <RouteValue
                            label="Сложность"
                            value={difficultyText || "Не указано"}
                            icon={Footprints}
                          />
                        </div>

                        {route.geojson_url && (
                          <MountainRouteMap
                            geojsonUrl={route.geojson_url}
                            routeName={route.name}
                          />
                        )}

                        {route.description && (
                          <div className="mt-8 grid gap-3 sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-8">
                            <h4 className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.075em] text-[var(--color-text-muted)]">
                              Описание маршрута
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
                                title="Лучший сезон"
                                icon={Sun}
                                text={route.best_season}
                              />
                            )}
                            {route.equipment && (
                              <RouteInformationBlock
                                title="Снаряжение"
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
                              Важное предупреждение
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
                                href={route.gpx_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="ui-pressable inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-forest)] px-4 text-sm font-bold text-[var(--color-text-inverse)] hover:bg-[var(--color-forest-hover)]"
                              >
                                <Download aria-hidden="true" size={17} />
                                Скачать GPX
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
                                  ? `Источник: ${route.source_name}`
                                  : "Источник маршрута"}
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
                    Информация о безопасности:
                  </strong>{" "}
                  описание маршрута не заменяет актуальную топографическую
                  карту, официальный прогноз погоды, проверку состояния тропы
                  и личную оценку опыта и снаряжения.
                </p>
              </div>
            </section>

            <section aria-labelledby="recent-ascents-title">
              <div className="border-b border-[var(--color-border-strong)] pb-5">
                <p className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.1em] text-[var(--color-forest)]">
                  03 / Журнал
                </p>
                <h2
                  id="recent-ascents-title"
                  className="mt-2 text-3xl font-bold text-[var(--color-text)] sm:text-4xl"
                >
                  Последние восхождения
                </h2>
              </div>

              {recentAscents.length === 0 ? (
                <p className="border-b border-[var(--color-border)] py-8 text-[var(--color-text-muted)]">
                  Эту вершину ещё никто не отметил.
                </p>
              ) : (
                <div className="divide-y divide-[var(--color-border-soft)] border-b border-[var(--color-border)]">
                  {recentAscents.map((ascent) => {
                    const username =
                      ascent.display_name ??
                      ascent.username ??
                      "Пользователь";

                    return (
                      <article
                        key={ascent.id}
                        className="flex items-center justify-between gap-4 py-4"
                      >
                        <div className="flex min-w-0 items-center gap-3">
                          <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[var(--color-border)] bg-[var(--color-surface-muted)] font-bold text-[var(--color-forest)]">
                            {ascent.avatar_url ? (
                              <img
                                src={ascent.avatar_url}
                                alt={username}
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
                                Это вы
                              </p>
                            )}
                          </div>
                        </div>

                        <p className="shrink-0 [font-family:var(--font-technical)] text-xs tabular-nums text-[var(--color-text-muted)]">
                          {formatDate(ascent.climbed_at ?? ascent.created_at)}
                        </p>
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
          </div>

          <aside className="space-y-10 lg:sticky lg:top-[90px]" aria-label="Статус и ресурсы вершины">
            <section aria-labelledby="ascent-status-title">
              <div className="border-b border-[var(--color-border-strong)] pb-4">
                <p className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.1em] text-[var(--color-forest)]">
                  Статус восхождения
                </p>
                <h2
                  id="ascent-status-title"
                  className="mt-2 text-2xl font-bold text-[var(--color-text)]"
                >
                  Ваша отметка
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
                    ? "Требуется вход"
                    : userHasClimbed
                      ? "Вершина покорена"
                      : "Ещё не покорена"}
                </p>
                <p className="mt-2 text-sm leading-6 text-[var(--color-text-muted)]">
                  {!user
                    ? "Войдите в аккаунт, чтобы видеть персональный статус вершины."
                    : userHasClimbed
                      ? "Восхождение учтено в вашем горном журнале."
                      : "Восхождение пока не отмечено в вашем горном журнале."}
                </p>
              </div>

              <dl className="mt-5 divide-y divide-[var(--color-border-soft)] border-y border-[var(--color-border)]">
                <div className="flex items-center justify-between gap-4 py-4">
                  <dt className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
                    <Users aria-hidden="true" size={16} />
                    Всего отметок
                  </dt>
                  <dd className="[font-family:var(--font-technical)] font-bold tabular-nums text-[var(--color-text)]">
                    {totalAscents.toLocaleString("ru-RU")}
                  </dd>
                </div>
                <div className="flex items-start justify-between gap-4 py-4">
                  <dt className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
                    <CalendarDays aria-hidden="true" size={16} />
                    Последнее
                  </dt>
                  <dd className="text-right text-sm font-semibold text-[var(--color-text)]">
                    {latestAscentAt ? formatDate(latestAscentAt) : "Пока нет"}
                  </dd>
                </div>
              </dl>

              {user && (
                <form
                  action={async () => {
                    "use server";
                    await toggleFavoriteMountain(typedMountain.id);
                  }}
                  className="mt-4"
                >
                  <button
                    type="submit"
                    className={`ui-pressable flex min-h-11 w-full items-center justify-center gap-2 rounded-[var(--radius-control)] border px-4 text-sm font-bold ${
                      isFavorite
                        ? "ui-destructive border-[var(--color-danger-border)] bg-[var(--color-danger-soft)] text-[var(--color-danger)]"
                        : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-text)]"
                    }`}
                  >
                    <Star
                      aria-hidden="true"
                      size={17}
                      fill={isFavorite ? "currentColor" : "none"}
                    />
                    {isFavorite ? "В избранном" : "Добавить в избранное"}
                  </button>
                </form>
              )}
            </section>

            <section aria-labelledby="external-resources-title">
              <div className="border-b border-[var(--color-border-strong)] pb-4">
                <p className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.1em] text-[var(--color-forest)]">
                  Справочные данные
                </p>
                <h2
                  id="external-resources-title"
                  className="mt-2 text-2xl font-bold text-[var(--color-text)]"
                >
                  Внешние ресурсы
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
                      Внешние источники отсутствуют.
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
