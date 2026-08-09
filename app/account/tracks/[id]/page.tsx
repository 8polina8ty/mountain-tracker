import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import ActivityTrackMap from "@/components/account/ActivityTrackMap";
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
    redirect("/login");
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
    <main className="min-h-[calc(100vh-80px)] bg-gray-50 px-4 py-8">
      <div className="mx-auto max-w-6xl">
        <Link
          href="/account/ascents"
          className="font-semibold text-green-700 transition hover:text-green-800"
        >
          ← Вернуться к моим восхождениям
        </Link>

        <section className="mt-6 rounded-3xl border border-gray-200 bg-white p-6 shadow-sm sm:p-8">
          <p className="text-sm font-bold uppercase tracking-wider text-green-700">
            GPS-активность
          </p>

          <h1 className="mt-2 break-words text-3xl font-bold text-gray-900">
            {title}
          </h1>

          <p className="mt-2 text-gray-500">
            Источник:{" "}
            {getSourceLabel(
              activity.source_type,
            )}
          </p>

          <div className="mt-8 grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-4">
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
          </div>

          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <div className="rounded-2xl bg-gray-50 p-5">
              <p className="text-sm font-semibold text-gray-500">
                Начало активности
              </p>

              <p className="mt-2 font-bold text-gray-900">
                {formatDate(
                  activity.started_at,
                )}
              </p>
            </div>

            <div className="rounded-2xl bg-gray-50 p-5">
              <p className="text-sm font-semibold text-gray-500">
                Окончание активности
              </p>

              <p className="mt-2 font-bold text-gray-900">
                {formatDate(
                  activity.finished_at,
                )}
              </p>
            </div>
          </div>

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

          <div className="mt-8">
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
    <div className="rounded-2xl border border-gray-200 bg-white p-5">
      <p className="text-xs font-bold uppercase tracking-wide text-gray-500">
        {label}
      </p>

      <p className="mt-3 break-words text-xl font-bold text-gray-900">
        {value}
      </p>
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
        "rounded-2xl border p-6 text-center",
        isError
          ? "border-red-200 bg-red-50"
          : "border-gray-200 bg-gray-50",
      ].join(" ")}
    >
      <p
        className={
          isError
            ? "font-bold text-red-800"
            : "font-bold text-gray-900"
        }
      >
        {title}
      </p>

      <p
        className={[
          "mt-2 text-sm",
          isError
            ? "text-red-700"
            : "text-gray-500",
        ].join(" ")}
      >
        {text}
      </p>
    </div>
  );
}