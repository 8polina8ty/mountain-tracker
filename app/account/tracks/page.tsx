import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowUpRight, Route, Upload } from "lucide-react";

import { createClient } from "@/Lib/supabase/server";
import AccountNavigation from "@/components/account/AccountNavigation";
import AccountPageHeader from "@/components/account/AccountPageHeader";
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
    <main className="min-h-[calc(100dvh-58px)] bg-[var(--color-bg)] px-4 py-6 lg:min-h-[calc(100dvh-66px)] lg:px-6 lg:py-8">
      <div className="mx-auto max-w-7xl">
        <AccountNavigation />
        <AccountPageHeader
          eyebrow="03 / Маршрутный архив"
          title="GPS-треки"
          description="Записанные маршруты с часов, телефона и туристических приложений, собранные в едином техническом архиве."
          metric={{ label: "Всего маршрутов", value: activities.length }}
          actions={
            <Link href="/account/tracks/import" className="inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-forest)] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[var(--color-forest-hover)]">
              <Upload aria-hidden="true" className="h-4 w-4" />
              Импортировать трек
            </Link>
          }
        />

        {activities.length === 0 ? (
          <section className="border-b border-[var(--color-border-strong)] py-14 text-center">
            <Route aria-hidden="true" className="mx-auto h-9 w-9 text-[var(--color-track)]" />
            <h2 className="mt-5 text-2xl font-bold text-[var(--color-text)]">
              GPS-треков пока нет
            </h2>

            <p className="mx-auto mt-2 max-w-lg text-[var(--color-text-muted)]">
              Загрузите GPX с Garmin, Suunto,
              Strava, Komoot, часов или телефона.
            </p>

            <Link
              href="/account/tracks/import"
              className="mt-6 inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-forest)] px-5 py-2 font-semibold text-white transition-colors hover:bg-[var(--color-forest-hover)]"
            >
              <Upload aria-hidden="true" className="h-4 w-4" />
              Загрузить первый трек
            </Link>
          </section>
        ) : (
          <section className="border-t border-[var(--color-border-strong)]" aria-label="Список GPS-треков">
            {activities.map((activity) => {
              const canOpen =
                activity.processing_status ===
                "ready";

              return (
                <article
                  key={activity.id}
                  className="border-b border-[var(--color-border)] py-6"
                >
                  <div className="grid gap-5 lg:grid-cols-[minmax(220px,1.1fr)_minmax(360px,1.5fr)_180px] lg:items-center">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={[
                            "[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.075em]",
                            activity.processing_status ===
                            "ready"
                              ? "text-[var(--color-success)]"
                              : activity.processing_status ===
                                "failed"
                              ? "text-[var(--color-danger)]"
                              : "text-[var(--color-warning)]",
                          ].join(" ")}
                        >
                          {getStatusLabel(
                            activity.processing_status,
                          )}
                        </span>

                        <span className="text-sm text-[var(--color-text-muted)]">
                          {getSourceLabel(
                            activity.source_type,
                          )}
                        </span>
                      </div>

                      <h2 className="mt-2 break-words text-2xl font-bold text-[var(--color-text)]">
                        {activity.title ??
                          `GPS-трек №${activity.id}`}
                      </h2>

                      <p className="mt-1 [font-family:var(--font-technical)] text-xs text-[var(--color-text-muted)]">
                        {formatDate(
                          activity.started_at ??
                            activity.created_at,
                        )}
                      </p>
                    </div>

                    <dl className="grid grid-cols-2 border-y border-[var(--color-border-soft)] sm:grid-cols-4 sm:border-y-0">
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
                    </dl>

                    <div className="flex shrink-0 flex-col gap-2">
  {canOpen ? (
    <Link
      href={`/account/tracks/${activity.id}`}
      className="inline-flex min-h-11 items-center justify-between gap-2 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 text-sm font-semibold text-[var(--color-text)] transition-colors hover:border-[var(--color-track)] hover:text-[var(--color-track)]"
    >
      Открыть маршрут
      <ArrowUpRight aria-hidden="true" className="h-4 w-4" />
    </Link>
  ) : (
    <span className="inline-flex min-h-11 items-center justify-center rounded-[var(--radius-control)] bg-[var(--color-surface-muted)] px-4 py-2 text-sm font-semibold text-[var(--color-text-disabled)]">
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
    <div className="min-w-0 border-r border-[var(--color-border-soft)] px-3 py-3 first:pl-0 last:border-r-0 sm:py-1">
      <dt className="[font-family:var(--font-technical)] text-[10px] font-bold uppercase tracking-[0.05em] text-[var(--color-text-muted)]">
        {label}
      </dt>

      <dd className="mt-1 break-words [font-family:var(--font-technical)] text-sm font-bold tabular-nums text-[var(--color-text)]">
        {value}
      </dd>
    </div>
  );
}
