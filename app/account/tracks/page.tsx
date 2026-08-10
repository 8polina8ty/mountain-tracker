import Link from "next/link";
import { redirect } from "next/navigation";
import { Route, Upload } from "lucide-react";

import { createClient } from "@/Lib/supabase/server";
import AccountNavigation from "@/components/account/AccountNavigation";
import AccountPageHeader from "@/components/account/AccountPageHeader";
import GpsTrackList, {
  type GpsTrackListItem,
} from "@/components/account/GpsTrackList";

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
    redirect("/auth/login");
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

  const trackItems: GpsTrackListItem[] = activities.map((activity) => ({
    id: activity.id,
    title: activity.title ?? `GPS-трек №${activity.id}`,
    sourceLabel: getSourceLabel(activity.source_type),
    dateLabel: formatDate(activity.started_at ?? activity.created_at),
    statusLabel: getStatusLabel(activity.processing_status),
    statusTone:
      activity.processing_status === "ready"
        ? "success"
        : activity.processing_status === "failed"
          ? "danger"
          : "warning",
    distanceLabel: formatDistance(activity.distance_m),
    durationLabel: formatDuration(activity.duration_seconds),
    elevationGainLabel:
      activity.elevation_gain_m !== null
        ? `+${Math.round(activity.elevation_gain_m).toLocaleString("ru-RU")} м`
        : "—",
    maximumElevationLabel:
      activity.maximum_elevation_m !== null
        ? `${Math.round(activity.maximum_elevation_m).toLocaleString("ru-RU")} м`
        : "—",
    canOpen: activity.processing_status === "ready",
    originalFilePath: activity.original_file_url,
    geoJsonFilePath: activity.geojson_url,
  }));

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
            <Link data-track-import-action href="/account/tracks/import" className="ui-pressable inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-forest)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--color-forest-hover)]">
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
              className="ui-pressable mt-6 inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-forest)] px-5 py-2 font-semibold text-white hover:bg-[var(--color-forest-hover)]"
            >
              <Upload aria-hidden="true" className="h-4 w-4" />
              Загрузить первый трек
            </Link>
          </section>
        ) : (
          <GpsTrackList items={trackItems} />
        )}
      </div>
    </main>
  );
}
