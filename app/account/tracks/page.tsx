import Link from "next/link";
import { redirect } from "next/navigation";

import { createClient } from "@/Lib/supabase/server";
import DeleteGpsTrackButton from "@/components/account/DeleteGpsTrackButton";

type GpsActivity = {
  id: number;
  title: string | null;
  source_type: string;
  started_at: string | null;
  duration_seconds: number | null;
  distance_m: number | null;
  elevation_gain_m: number | null;
  maximum_elevation_m: number | null;

  original_file_url: string | null;
  geojson_url: string | null;

  processing_status: string;
  created_at: string;
};

function formatDistance(
  distanceM: number | null,
): string {
  if (distanceM === null) {
    return "—";
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
    return "—";
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
    return "Дата не указана";
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

function getStatusLabel(
  status: string,
): string {
  switch (status) {
    case "ready":
      return "Готов";

    case "processing":
      return "Обрабатывается";

    case "pending":
      return "Ожидает обработки";

    case "failed":
      return "Ошибка";

    default:
      return status;
  }
}

export default async function TracksPage() {
  const supabase = await createClient();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    redirect("/login");
  }

  const {
    data,
    error,
  } = await supabase
    .from("gps_activities")
    .select(`
      id,
      title,
      source_type,
      started_at,
      duration_seconds,
      distance_m,
      elevation_gain_m,
      maximum_elevation_m,
      original_file_url,
      geojson_url,
      processing_status,
      created_at
    `)
    .eq("user_id", user.id)
    .order("created_at", {
      ascending: false,
    });

  if (error) {
    console.error(
      "Ошибка загрузки GPS-треков:",
      error,
    );
  }

  const activities =
    (data ?? []) as GpsActivity[];

  return (
    <main className="min-h-[calc(100vh-80px)] bg-gray-50 px-4 py-8">
      <div className="mx-auto max-w-6xl">
        <Link
          href="/account/ascents"
          className="font-semibold text-green-700 transition hover:text-green-800"
        >
          ← Вернуться к моим восхождениям
        </Link>

        <div className="mt-6 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-bold uppercase tracking-wider text-green-700">
              GPS-активности
            </p>

            <h1 className="mt-2 text-3xl font-bold text-gray-900">
              Мои GPS-треки
            </h1>

            <p className="mt-2 text-gray-500">
              Загруженные и записанные маршруты
              с часов, телефона и туристических
              приложений.
            </p>
          </div>

          <Link
            href="/account/tracks/import"
            className="inline-flex shrink-0 items-center justify-center rounded-xl bg-green-600 px-5 py-3 font-semibold text-white transition hover:bg-green-700"
          >
            Импортировать трек
          </Link>
        </div>

        {activities.length === 0 ? (
          <section className="mt-8 rounded-3xl border border-gray-200 bg-white p-10 text-center shadow-sm">
            <div className="text-6xl">
              🗺️
            </div>

            <h2 className="mt-5 text-2xl font-bold text-gray-900">
              GPS-треков пока нет
            </h2>

            <p className="mx-auto mt-2 max-w-lg text-gray-500">
              Загрузите GPX с Garmin, Suunto,
              Strava, Komoot, часов или телефона.
            </p>

            <Link
              href="/account/tracks/import"
              className="mt-6 inline-flex rounded-xl bg-green-600 px-5 py-3 font-semibold text-white transition hover:bg-green-700"
            >
              Загрузить первый трек
            </Link>
          </section>
        ) : (
          <section className="mt-8 space-y-4">
            {activities.map((activity) => {
              const canOpen =
                activity.processing_status ===
                "ready";

              return (
                <article
                  key={activity.id}
                  className="rounded-3xl border border-gray-200 bg-white p-5 shadow-sm sm:p-6"
                >
                  <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={[
                            "rounded-full px-3 py-1 text-xs font-bold",
                            activity.processing_status ===
                            "ready"
                              ? "bg-green-100 text-green-700"
                              : activity.processing_status ===
                                "failed"
                              ? "bg-red-100 text-red-700"
                              : "bg-amber-100 text-amber-700",
                          ].join(" ")}
                        >
                          {getStatusLabel(
                            activity.processing_status,
                          )}
                        </span>

                        <span className="text-sm text-gray-500">
                          {getSourceLabel(
                            activity.source_type,
                          )}
                        </span>
                      </div>

                      <h2 className="mt-3 break-words text-xl font-bold text-gray-900">
                        {activity.title ??
                          `GPS-трек №${activity.id}`}
                      </h2>

                      <p className="mt-1 text-sm text-gray-500">
                        {formatDate(
                          activity.started_at ??
                            activity.created_at,
                        )}
                      </p>
                    </div>

                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      <TrackValue
                        label="Расстояние"
                        value={formatDistance(
                          activity.distance_m,
                        )}
                      />

                      <TrackValue
                        label="Время"
                        value={formatDuration(
                          activity.duration_seconds,
                        )}
                      />

                      <TrackValue
                        label="Набор"
                        value={
                          activity.elevation_gain_m !==
                          null
                            ? `+${Math.round(
                                activity.elevation_gain_m,
                              ).toLocaleString(
                                "ru-RU",
                              )} м`
                            : "—"
                        }
                      />

                      <TrackValue
                        label="Макс. высота"
                        value={
                          activity.maximum_elevation_m !==
                          null
                            ? `${Math.round(
                                activity.maximum_elevation_m,
                              ).toLocaleString(
                                "ru-RU",
                              )} м`
                            : "—"
                        }
                      />
                    </div>

                    <div className="flex shrink-0 flex-col gap-2">
  {canOpen ? (
    <Link
      href={`/account/tracks/${activity.id}`}
      className="inline-flex items-center justify-center rounded-xl border border-green-600 px-5 py-3 font-semibold text-green-700 transition hover:bg-green-50"
    >
      Открыть карту →
    </Link>
  ) : (
    <span className="inline-flex items-center justify-center rounded-xl bg-gray-100 px-5 py-3 font-semibold text-gray-400">
      Карта недоступна
    </span>
  )}

  <DeleteGpsTrackButton
    activityId={activity.id}
    activityTitle={
      activity.title ??
      `GPS-трек №${activity.id}`
    }
    originalFilePath={
      activity.original_file_url
    }
    geoJsonFilePath={
      activity.geojson_url
    }
  />
</div>
                  </div>
                </article>
              );
            })}
          </section>
        )}
      </div>
    </main>
  );
}

type TrackValueProps = {
  label: string;
  value: string;
};

function TrackValue({
  label,
  value,
}: TrackValueProps) {
  return (
    <div className="min-w-[110px] rounded-2xl bg-gray-50 p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
        {label}
      </p>

      <p className="mt-1 break-words font-bold text-gray-900">
        {value}
      </p>
    </div>
  );
}