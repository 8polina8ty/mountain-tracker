import Link from "next/link";
import { notFound } from "next/navigation";

import { createClient } from "../../../Lib/supabase/server";
import { formatDate } from "@/Lib/utils";

import Image from "next/image";

import { getMountainImageFromWikidata } from "@/Lib/wikimedia";
import { toggleFavoriteMountain } from "./actions";
import type { ComponentType } from "react";

import {
  Ruler,
  Mountain,
  Clock3,
  Footprints,
} from "lucide-react";

import MountainRouteMap from "@/components/mountain/MountainRouteMap";

type MountainPageProps = {
  params: Promise<{
    id: string;
  }>;
};

type Mountain = {
  id: number;
  name: string | null;
  name_de: string | null;
  height: number;
  latitude: number | null;
  longitude: number | null;
  wikipedia: string | null;
  wikidata: string | null;
};

type AscentProfile = {
  username: string | null;
  avatar_url: string | null;
};

type MountainAscent = {
  id: number;
  user_id: string;
  climbed_at: string | null;
  created_at: string;
  profiles: AscentProfile | null;
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

function getMountainName(mountain: Mountain): string {
  return (
    mountain.name_de ??
    mountain.name ??
    "Без названия"
  );
}



export default async function MountainPage({
  params,
}: MountainPageProps) {
  const { id } = await params;
  const mountainId = Number(id);

  if (!Number.isInteger(mountainId)) {
    notFound();
  }

  const supabase = await createClient();
  const { data: { user },} = await supabase.auth.getUser();

  const { data: mountain, error } = await supabase
    .from("mountains")
    .select(`
      id,
      name,
      name_de,
      height,
      latitude,
      longitude,
      wikipedia,
      wikidata
    `)
    .eq("id", mountainId)
    .maybeSingle();

  if (error) {
    console.error("Ошибка загрузки вершины:", error);
  }

  if (!mountain) {
    notFound();
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
  icon: ComponentType<{
    className?: string;
  }>;
  label: string;
  value: string;
};

function RouteValue({
  icon: Icon,
  label,
  value,
}: RouteValueProps) {
  return (
    <div className="flex min-w-0 flex-col items-center rounded-2xl border border-gray-200 bg-white px-4 py-5 text-center shadow-sm transition hover:shadow-md">
      <Icon className="h-9 w-9 shrink-0 text-green-600 stroke-[2.2]" />

      <p className="mt-4 w-full min-w-0 whitespace-normal break-words text-xs font-semibold uppercase leading-5 tracking-normal text-gray-500 [overflow-wrap:anywhere]">
        {label}
      </p>

      <p className="mt-3 w-full min-w-0 whitespace-normal break-words text-xl font-bold leading-tight text-gray-900 [overflow-wrap:anywhere]">
        {value}
      </p>
    </div>
  );
}

type RouteInformationBlockProps = {
  icon: string;
  title: string;
  text: string;
};

function RouteInformationBlock({
  icon,
  title,
  text,
}: RouteInformationBlockProps) {
  return (
    <div className="rounded-2xl border border-gray-200 p-5">
      <h4 className="font-bold text-gray-900">
        {icon} {title}
      </h4>

      <p className="mt-2 whitespace-pre-line leading-7 text-gray-600">
        {text}
      </p>
    </div>
  );
}


const {
  data: routesData,
  error: routesError,
} = await supabase
  .from("mountain_routes")
  .select(`
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
  `)
  .eq("mountain_id", mountainId)
  .eq("is_verified", true)
  .order("id", {
    ascending: true,
  });

if (routesError) {
  console.error(
    "Ошибка загрузки маршрутов:",
    routesError,
  );
}

const routes =
  (routesData ?? []) as MountainRoute[];

  const {
  data: statisticsData,
  error: statisticsError,
} = await supabase.rpc(
  "get_mountain_statistics",
  {
    p_mountain_id: mountainId,
  },
);

if (statisticsError) {
  console.error(
    "Ошибка загрузки статистики вершины:",
    statisticsError,
  );
}

const statistics =
  statisticsData as MountainStatistics | null;

const totalAscents =
  statistics?.total_ascents ?? 0;

const latestAscentAt =
  statistics?.latest_ascent_at ?? null;

const userHasClimbed =
  statistics?.user_has_climbed ?? false;

const recentAscents =
  statistics?.recent_ascents ?? [];

const favoriteResult = user
  ? await supabase
      .from("favorite_mountains")
      .select("id")
      .eq("user_id", user.id)
      .eq("mountain_id", mountainId)
      .maybeSingle()
  : null;

const isFavorite = Boolean(favoriteResult?.data);

  const typedMountain = mountain as Mountain;
  const mountainName = getMountainName(typedMountain);
  const mountainImage = await getMountainImageFromWikidata(
    typedMountain.wikidata, 
 );
  return (
    <main className="min-h-[calc(100vh-80px)] bg-gray-50 px-4 py-8">
      <div className="mx-auto max-w-5xl">
        <Link
          href="/map"
          className="inline-flex items-center text-sm font-semibold text-green-700 hover:text-green-800"
        >
          ← Вернуться к карте
        </Link>

        <section className="mt-6 overflow-hidden rounded-3xl border border-gray-200 bg-white shadow-sm">
          <div className="relative min-h-[360px] overflow-hidden">
  {mountainImage ? (
    <>
      <Image
        src={mountainImage.url}
        alt={`Вершина ${mountainName}`}
        fill
        priority
        sizes="(max-width: 1024px) 100vw, 1200px"
        className="object-cover"
      />

      <div className="absolute inset-0 bg-gradient-to-r from-black/75 via-black/45 to-black/10" />
    </>
  ) : (
    <div className="absolute inset-0 bg-gradient-to-br from-green-700 to-emerald-500" />
  )}

  <div className="relative z-10 flex min-h-[360px] flex-col justify-end px-6 py-10 text-white sm:px-10">
    <p className="text-sm font-semibold uppercase tracking-widest text-green-100">
      Вершина
    </p>

    <h1 className="mt-3 text-4xl font-bold sm:text-5xl">
      {mountainName}
    </h1>

    <p className="mt-4 text-3xl font-bold">
      {typedMountain.height} м
    </p>
  </div>
</div>

{mountainImage && (
  <div className="border-b border-gray-200 bg-gray-50 px-6 py-3 text-xs text-gray-500 sm:px-10">
    Фото: Wikimedia Commons

    {mountainImage.license && (
      <> · {mountainImage.license}</>
    )}

    {mountainImage.descriptionUrl && (
      <>
        {" · "}
        <a
          href={mountainImage.descriptionUrl}
          target="_blank"
          rel="noreferrer"
          className="font-semibold text-green-700 hover:underline"
        >
          Автор и лицензия
        </a>
      </>
    )}
  </div>
)}

          <div className="grid gap-6 p-6 sm:grid-cols-2 sm:p-10">
            <article className="rounded-2xl border border-gray-200 p-5">
              <p className="text-sm font-semibold uppercase tracking-wide text-gray-500">
                Название
              </p>

              <p className="mt-3 text-xl font-bold text-gray-900">
                {mountainName}
              </p>

              {typedMountain.name &&
                typedMountain.name !== mountainName && (
                  <p className="mt-1 text-gray-500">
                    {typedMountain.name}
                  </p>
                )}
            </article>

            <article className="rounded-2xl border border-gray-200 p-5">
              <p className="text-sm font-semibold uppercase tracking-wide text-gray-500">
                Высота
              </p>

              <p className="mt-3 text-3xl font-bold text-green-600">
                {typedMountain.height} м
              </p>
            </article>

            <article className="rounded-2xl border border-gray-200 p-5">
              <p className="text-sm font-semibold uppercase tracking-wide text-gray-500">
                Координаты
              </p>

              {typedMountain.latitude !== null &&
              typedMountain.longitude !== null ? (
                <p className="mt-3 font-medium text-gray-900">
                  {typedMountain.latitude.toFixed(5)},{" "}
                  {typedMountain.longitude.toFixed(5)}
                </p>
              ) : (
                <p className="mt-3 text-gray-500">
                  Координаты отсутствуют
                </p>
              )}
            </article>

            <article className="rounded-2xl border border-gray-200 p-5">
              <p className="text-sm font-semibold uppercase tracking-wide text-gray-500">
                Внешние источники
              </p>

              <div className="mt-3 flex flex-wrap gap-3">
                {typedMountain.wikipedia && (
                  <a
                    href={`https://de.wikipedia.org/wiki/${encodeURIComponent(
                      typedMountain.wikipedia,
                    )}`}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-xl border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-800 hover:bg-gray-50"
                  >
                    Wikipedia
                  </a>
                )}

                {typedMountain.wikidata && (
                  <a
                    href={`https://www.wikidata.org/wiki/${typedMountain.wikidata}`}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-xl border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-800 hover:bg-gray-50"
                  >
                    Wikidata
                  </a>
                )}

                {!typedMountain.wikipedia &&
                  !typedMountain.wikidata && (
                    <p className="text-gray-500">
                      Источники отсутствуют
                    </p>
                  )}
              </div>
            </article>

<section className="mt-8 rounded-3xl border border-gray-200 bg-white p-6 shadow-sm sm:p-8">
  <div className="flex flex-wrap items-end justify-between gap-4">
    <div>
      <p className="text-sm font-bold uppercase tracking-wider text-green-700">
        Маршруты
      </p>

      <h2 className="mt-2 text-2xl font-bold text-gray-900 sm:text-3xl">
        🥾 Как взойти
      </h2>

      <p className="mt-2 max-w-2xl text-gray-500">
        Проверенные варианты подъёма на вершину. Перед выходом
        обязательно уточняйте погоду, состояние маршрута и
        актуальные ограничения.
      </p>
    </div>

    <div className="rounded-2xl bg-green-50 px-4 py-3">
      <p className="text-sm text-gray-500">
        Доступно маршрутов
      </p>

      <p className="mt-1 text-2xl font-bold text-green-700">
        {routes.length}
      </p>
    </div>
  </div>

  {routes.length === 0 ? (
    <div className="mt-6 rounded-2xl bg-gray-50 p-8 text-center">
      <div className="text-5xl">🧭</div>

      <h3 className="mt-4 text-xl font-bold text-gray-900">
        Маршруты пока не добавлены
      </h3>

      <p className="mt-2 text-gray-500">
        Для этой вершины ещё нет проверенного описания подъёма.
      </p>
    </div>
  ) : (
    <div className="mt-6 space-y-5">
      {routes.map((route) => {
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
            className="overflow-hidden rounded-3xl border border-gray-200"
          >
            <div className="bg-gradient-to-r from-green-700 to-green-500 p-6 text-white">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-bold uppercase tracking-wider text-white/75">
                    {getRouteTypeLabel(route.route_type)}
                  </p>

                  <h3 className="mt-2 text-2xl font-bold">
                    {route.name}
                  </h3>

                  {route.start_location && (
                    <p className="mt-2 text-white/85">
                      📍 Старт: {route.start_location}
                    </p>
                  )}
                </div>

                {route.is_verified && (
                  <span className="rounded-full bg-white/20 px-3 py-1 text-sm font-semibold backdrop-blur">
                    ✓ Проверено
                  </span>
                )}
              </div>
            </div>

            <div className="p-6">
              <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-4">
                <RouteValue
  label="Расстояние"
  value={
    route.distance_km !== null
      ? `${Number(route.distance_km).toLocaleString(
          "ru-RU",
        )} км`
      : "Не указано"
  }
  icon={Ruler}
/>

                <RouteValue
  label="Набор высоты"
  value={
    route.elevation_gain_m !== null
      ? `+${route.elevation_gain_m.toLocaleString(
          "ru-RU",
        )} м`
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
                <div className="mt-6">
                  <h4 className="font-bold text-gray-900">
                    Описание маршрута
                  </h4>

                  <p className="mt-2 whitespace-pre-line leading-7 text-gray-600">
                    {route.description}
                  </p>
                </div>
              )}

              <div className="mt-6 grid gap-4 lg:grid-cols-2">
                {route.best_season && (
                  <RouteInformationBlock
                    title="Лучший сезон"
                    icon="☀️"
                    text={route.best_season}
                  />
                )}

                {route.equipment && (
                  <RouteInformationBlock
                    title="Снаряжение"
                    icon="🎒"
                    text={route.equipment}
                  />
                )}
              </div>

              {route.warnings && (
                <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-5">
                  <h4 className="font-bold text-amber-900">
                    ⚠️ Важное предупреждение
                  </h4>

                  <p className="mt-2 whitespace-pre-line leading-7 text-amber-800">
                    {route.warnings}
                  </p>
                </div>
              )}

              <div className="mt-6 flex flex-wrap gap-3">
                {route.source_url && (
                  <a
                    href={route.source_url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center justify-center rounded-xl border border-green-600 px-4 py-2 font-semibold text-green-700 transition hover:bg-green-50"
                  >
                    Источник
                    {route.source_name
                      ? `: ${route.source_name}`
                      : ""}{" "}
                    ↗
                  </a>
                )}

                {route.gpx_url && (
                  <a
                    href={route.gpx_url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center justify-center rounded-xl bg-green-600 px-4 py-2 font-semibold text-white transition hover:bg-green-700"
                  >
                    Скачать GPX
                  </a>
                )}
              </div>
            </div>
          </article>
        );
      })}
    </div>
  )}

  <div className="mt-6 rounded-2xl border border-gray-200 bg-gray-50 p-5 text-sm leading-6 text-gray-600">
    <strong className="text-gray-900">
      Информация о безопасности:
    </strong>{" "}
    описание маршрута не заменяет актуальную топографическую
    карту, официальный прогноз погоды, проверку состояния тропы и
    личную оценку опыта и снаряжения.
  </div>
</section>

          </div>
<div className="border-t border-gray-200 p-6 sm:p-10">
  <div>
    <p className="text-sm font-semibold uppercase tracking-wide text-green-600">
      Статистика
    </p>

    <h2 className="mt-1 text-2xl font-bold text-gray-900">
      Восхождения на вершину
    </h2>
  </div>

  <div className="mt-6 grid gap-4 sm:grid-cols-3">
    <article className="rounded-2xl border border-gray-200 p-5">
      <p className="text-sm font-semibold uppercase tracking-wide text-gray-500">
        Покорили
      </p>

      <p className="mt-3 text-4xl font-bold text-green-600">
        {totalAscents}
      </p>

      <p className="mt-1 text-sm text-gray-500">
        пользователей
      </p>
    </article>

    <article className="rounded-2xl border border-gray-200 p-5">
      <p className="text-sm font-semibold uppercase tracking-wide text-gray-500">
        Последнее восхождение
      </p>

      <p className="mt-3 text-lg font-bold text-gray-900">
       {latestAscentAt
         ? formatDate(latestAscentAt)
           : "Пока нет"}
     </p>
    </article>

    <article className="rounded-2xl border border-gray-200 p-5">
      <p className="text-sm font-semibold uppercase tracking-wide text-gray-500">
        Ваш статус
      </p>

      <p
        className={`mt-3 text-lg font-bold ${
          userHasClimbed
            ? "text-green-700"
            : "text-gray-600"
        }`}
      >
        {!user
          ? "Войдите в аккаунт"
          : userHasClimbed
            ? "✓ Вершина покорена"
            : "Ещё не покорена"}
      </p>
    </article>
  </div>

{user && (
    <form
      action={async () => {
        "use server";
        await toggleFavoriteMountain(typedMountain.id);
      }}
      className="mt-6"
    >
      <button
        type="submit"
        className={`w-full rounded-xl px-4 py-3 font-semibold transition ${
          isFavorite
            ? "bg-yellow-400 text-gray-900 hover:bg-yellow-500"
            : "border border-gray-300 bg-white text-gray-900 hover:bg-gray-100"
        }`}
      >
        {isFavorite
          ? "★ В избранном"
          : "☆ Добавить в избранное"}
      </button>
    </form>
  )}

   <div className="mt-8">
  <h3 className="text-xl font-bold text-gray-900">
    Последние восхождения
  </h3>

  {recentAscents.length === 0 ? (
    <p className="mt-3 rounded-2xl bg-gray-50 p-5 text-gray-600">
      Эту вершину ещё никто не отметил.
    </p>
  ) : (
    <div className="mt-3 space-y-3">
      {recentAscents.map((ascent) => {
  const username =
    ascent.display_name ??
    ascent.username ??
    "Пользователь";

  return (
    <article
      key={ascent.id}
      className="flex items-center justify-between gap-4 rounded-2xl border border-gray-200 p-4"
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full bg-green-100 font-bold text-green-700">
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
          <p className="truncate font-semibold text-gray-900">
            {username}
          </p>

          {ascent.user_id === user?.id && (
            <p className="text-xs font-medium text-green-700">
              Это вы
            </p>
          )}
        </div>
      </div>

      <p className="shrink-0 text-sm text-gray-500">
        {formatDate(
          ascent.climbed_at ??
            ascent.created_at,
        )}
      </p>
    </article>
  );
})}
    </div>
  )}
</div>

</div>

        </section>
      </div>
    </main>
  );
}