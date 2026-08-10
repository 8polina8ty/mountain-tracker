import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, Map } from "lucide-react";

import ActivityTrackMap from "@/components/account/ActivityTrackMap";
import AccountNavigation from "@/components/account/AccountNavigation";
import AccountPageHeader from "@/components/account/AccountPageHeader";
import { createClient } from "@/Lib/supabase/server";
import DetectedMountainSection from "@/components/account/DetectedMountainSection";

type ActivityPageProps = {
  params: Promise<{
    id: string;
  }>;
};

type GpsActivity = {
  id: number;
  user_id: string;
  title: string | null;
  source_type: string;
  activity_type: string;
  started_at: string | null;
  finished_at: string | null;
  duration_seconds: number | null;
  distance_m: number | null;
  elevation_gain_m: number | null;
  minimum_elevation_m: number | null;
  maximum_elevation_m: number | null;
  geojson_url: string | null;
  processing_status: string;
  processing_error: string | null;
  created_at: string;
  detected_mountain_id: number | null;
  detection_distance_m: number | null;
  detection_confidence: number | null;
  detection_status: string;
  gps_verified: boolean;
};

function formatDistance(
  distanceM: number | null,
): string {
  if (distanceM === null) {
    return "Не указано";
  }

  return `${(distanceM / 1000).toLocaleString(
    "ru-RU",
    {
      minimumFractionDigits: 1,
      maximumFractionDigits: 2,
    },
  )} км`;
}

function formatDuration(
  durationSeconds: number | null,
): string {
  if (durationSeconds === null) {
    return "Не указано";
  }

  const hours = Math.floor(
    durationSeconds / 3600,
  );

  const minutes = Math.floor(
    (durationSeconds % 3600) / 60,
  );

  if (hours === 0) {
    return `${minutes} мин`;
  }

  return `${hours} ч ${minutes} мин`;
}

function formatDate(
  value: string | null,
): string {
  if (!value) {
    return "Не указано";
  }

  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "long",
    timeStyle: "short",
  }).format(new Date(value));
}

function getSourceLabel(
  sourceType: string,
): string {
  switch (sourceType) {
    case "garmin":
      return "Garmin";

    case "suunto":
      return "Suunto";

    case "strava":
      return "Strava";

    case "komoot":
      return "Komoot";

    case "phone_recording":
      return "Телефон";

    case "file_upload":
      return "Загрузка файла";

    default:
      return "Другое устройство";
  }
}

export default async function ActivityPage({
  params,
}: ActivityPageProps) {
  const { id } = await params;
  const activityId = Number(id);

  if (!Number.isInteger(activityId)) {
    notFound();
  }

  const supabase = await createClient();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    redirect("/auth/login");
  }

  const {
    data: activityData,
    error: activityError,
  } = await supabase
    .from("gps_activities")
    .select(`
      id,
      user_id,
      title,
      source_type,
      activity_type,
      started_at,
      finished_at,
      duration_seconds,
      distance_m,
      elevation_gain_m,
      minimum_elevation_m,
      maximum_elevation_m,
      geojson_url,
      processing_status,
      processing_error,
      detected_mountain_id,
      detection_distance_m,
      detection_confidence,
      detection_status,
      gps_verified,
      created_at
    `)
    .eq("id", activityId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (activityError) {
    console.error(
      "Ошибка загрузки GPS-активности:",
      activityError,
    );
  }

  if (!activityData) {
    notFound();
  }

  const activity =
    activityData as GpsActivity;

    type DetectedMountain = {
  id: number;
  name: string | null;
  name_de: string | null;
  height: number | null;
};

let detectedMountain:
  | DetectedMountain
  | null = null;

if (activity.detected_mountain_id !== null) {
  const {
    data: detectedMountainData,
    error: detectedMountainError,
  } = await supabase
    .from("mountains")
    .select(`
      id,
      name,
      name_de,
      height
    `)
    .eq(
      "id",
      activity.detected_mountain_id,
    )
    .maybeSingle();

  if (detectedMountainError) {
    console.error(
      "Ошибка загрузки найденной вершины:",
      detectedMountainError,
    );
  }

  detectedMountain =
    detectedMountainData as
      | DetectedMountain
      | null;
}

  let signedGeoJsonUrl: string | null = null;
  let signedUrlError = "";

  if (
    activity.processing_status === "ready" &&
    activity.geojson_url
  ) {
    const {
      data: signedUrlData,
      error: signedUrlStorageError,
    } = await supabase.storage
      .from("activity-tracks")
      .createSignedUrl(
        activity.geojson_url,
        60 * 60,
      );

    if (signedUrlStorageError) {
      console.error(
        "Ошибка создания подписанной ссылки:",
        signedUrlStorageError,
      );

      signedUrlError =
        signedUrlStorageError.message;
    } else {
      signedGeoJsonUrl =
        signedUrlData.signedUrl;
    }
  }

  const title =
    activity.title ?? `GPS-трек №${activity.id}`;

  return (
    <main className="min-h-[calc(100dvh-58px)] bg-[var(--color-bg)] px-4 py-6 lg:min-h-[calc(100dvh-66px)] lg:px-6 lg:py-8">
      <div className="mx-auto max-w-7xl">
        <AccountNavigation />
        <AccountPageHeader
          eyebrow="03.1 / Запись маршрута"
          title={title}
          description={`Источник: ${getSourceLabel(activity.source_type)}. Технические данные и геометрия сохранённого маршрута.`}
          actions={
            <Link href="/account/tracks" className="ui-pressable inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 text-sm font-semibold text-[var(--color-text)] hover:border-[var(--color-forest)]">
              <ArrowLeft aria-hidden="true" className="h-4 w-4" />
              Все треки
            </Link>
          }
        />

        <section className="py-8" aria-labelledby="track-metrics-title">
          <p className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.075em] text-[var(--color-text-muted)]">
            Техническая сводка
          </p>
          <h2 id="track-metrics-title" className="mt-1 text-2xl font-bold text-[var(--color-text)]">
            Параметры активности
          </h2>

          <dl className="mt-5 grid grid-cols-2 border-y border-[var(--color-border-strong)] lg:grid-cols-4">
            <ActivityValue
              label="Расстояние"
              value={formatDistance(
                activity.distance_m,
              )}
            />

            <ActivityValue
              label="Набор высоты"
              value={
                activity.elevation_gain_m !==
                null
                  ? `+${Math.round(
                      activity.elevation_gain_m,
                    ).toLocaleString(
                      "ru-RU",
                    )} м`
                  : "Не указано"
              }
            />

            <ActivityValue
              label="Продолжительность"
              value={formatDuration(
                activity.duration_seconds,
              )}
            />

            <ActivityValue
              label="Максимальная высота"
              value={
                activity.maximum_elevation_m !==
                null
                  ? `${Math.round(
                      activity.maximum_elevation_m,
                    ).toLocaleString(
                      "ru-RU",
                    )} м`
                  : "Не указано"
              }
            />
          </dl>

          <dl className="grid border-b border-[var(--color-border)] sm:grid-cols-2">
            <div className="py-5 sm:border-r sm:border-[var(--color-border-soft)] sm:pr-6">
              <dt className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.075em] text-[var(--color-text-muted)]">
                Начало активности
              </dt>

              <dd className="mt-2 font-semibold text-[var(--color-text)]">
                {formatDate(
                  activity.started_at,
                )}
              </dd>
            </div>

            <div className="border-t border-[var(--color-border-soft)] py-5 sm:border-t-0 sm:pl-6">
              <dt className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.075em] text-[var(--color-text-muted)]">
                Окончание активности
              </dt>

              <dd className="mt-2 font-semibold text-[var(--color-text)]">
                {formatDate(
                  activity.finished_at,
                )}
              </dd>
            </div>
          </dl>

          <DetectedMountainSection
  activityId={activity.id}
  activityStartedAt={activity.started_at}
  detectedMountain={
    detectedMountain
  }
  detectionDistanceM={
    activity.detection_distance_m
  }
  detectionConfidence={
    activity.detection_confidence
  }
  detectionStatus={
    activity.detection_status
  }
  gpsVerified={
    activity.gps_verified
  }
/>

          <div className="mt-10 border-t border-[var(--color-border-strong)] pt-8">
            <div className="mb-5 flex items-center gap-3">
              <Map aria-hidden="true" className="h-5 w-5 text-[var(--color-track)]" />
              <h2 className="text-2xl font-bold text-[var(--color-text)]">Геометрия маршрута</h2>
            </div>
            {activity.processing_status ===
              "ready" &&
              signedGeoJsonUrl && (
                <ActivityTrackMap
                  signedGeoJsonUrl={
                    signedGeoJsonUrl
                  }
                  activityTitle={title}
                />
              )}

            {activity.processing_status ===
              "pending" && (
                <ActivityStatus
                  title="Трек ожидает обработки"
                  text="Файл уже загружен, но GeoJSON ещё не создан."
                />
              )}

            {activity.processing_status ===
              "processing" && (
                <ActivityStatus
                  title="Трек обрабатывается"
                  text="Рассчитываем расстояние, высоту и маршрут."
                />
              )}

            {activity.processing_status ===
              "failed" && (
                <ActivityStatus
                  title="Не удалось обработать трек"
                  text={
                    activity.processing_error ??
                    "Причина ошибки не указана."
                  }
                  isError
                />
              )}

            {activity.processing_status ===
              "ready" &&
              !signedGeoJsonUrl && (
                <ActivityStatus
                  title="Карта временно недоступна"
                  text={
                    signedUrlError ||
                    "Не удалось получить приватный файл трека."
                  }
                  isError
                />
              )}
          </div>
        </section>
      </div>
    </main>
  );
}

type ActivityValueProps = {
  label: string;
  value: string;
};

function ActivityValue({
  label,
  value,
}: ActivityValueProps) {
  return (
    <div className="min-w-0 border-b border-[var(--color-border-soft)] px-4 py-5 odd:border-r lg:border-b-0 lg:border-r lg:first:pl-0 lg:last:border-r-0 lg:last:pr-0">
      <dt className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.075em] text-[var(--color-text-muted)]">
        {label}
      </dt>

      <dd className="mt-2 break-words [font-family:var(--font-technical)] text-xl font-bold tabular-nums text-[var(--color-text)] sm:text-2xl">
        {value}
      </dd>
    </div>
  );
}

type ActivityStatusProps = {
  title: string;
  text: string;
  isError?: boolean;
};

function ActivityStatus({
  title,
  text,
  isError = false,
}: ActivityStatusProps) {
  return (
    <div
      className={[
        "border-l-4 p-6",
        isError
          ? "border-[var(--color-danger)] bg-[var(--color-danger-soft)]"
          : "border-[var(--color-info)] bg-[var(--color-info-soft)]",
      ].join(" ")}
    >
      <p
        className={
          isError
            ? "font-bold text-[var(--color-danger)]"
            : "font-bold text-[var(--color-text)]"
        }
      >
        {title}
      </p>

      <p
        className={[
          "mt-2 text-sm",
          isError
            ? "text-[var(--color-danger)]"
            : "text-[var(--color-text-secondary)]",
        ].join(" ")}
      >
        {text}
      </p>
    </div>
  );
}
