import { Route, Upload } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";

import { createClient } from "@/Lib/supabase/server";
import AccountNavigation from "@/components/account/AccountNavigation";
import AccountPageHeader from "@/components/account/AccountPageHeader";
import GpsTrackList, {
  type GpsTrackListItem,
} from "@/components/account/GpsTrackList";
import type { Locale } from "@/i18n/locales";
import { Link, redirect } from "@/i18n/navigation";

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

type TracksPageProps = {
  params: Promise<{ locale: Locale }>;
};

export default async function TracksPage({ params }: TracksPageProps) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Tracks" });
  const format = await getFormatter({ locale });
  const supabase = await createClient();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return redirect({ href: "/auth/login", locale });
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

  const sourceLabels: Record<string, string> = {
    garmin: "Garmin",
    suunto: "Suunto",
    strava: "Strava",
    komoot: "Komoot",
    phone_recording: t("Sources.phone"),
    file_upload: t("Sources.fileUpload"),
  };
  const statusLabels: Record<string, string> = {
    ready: t("Processing.ready"),
    processing: t("Processing.processing"),
    pending: t("Processing.pending"),
    failed: t("Processing.failed"),
  };

  function formatDuration(durationSeconds: number | null) {
    if (durationSeconds === null) return "—";
    const hours = Math.floor(durationSeconds / 3600);
    const minutes = Math.floor((durationSeconds % 3600) / 60);
    return hours === 0
      ? t("Duration.minutes", { minutes })
      : t("Duration.hoursMinutes", { hours, minutes });
  }

  const trackItems: GpsTrackListItem[] = activities.map((activity) => ({
    id: activity.id,
    title: activity.title ?? t("List.fallbackTitle", { id: activity.id }),
    sourceLabel: sourceLabels[activity.source_type] ?? t("Sources.other"),
    dateLabel: format.dateTime(new Date(activity.started_at ?? activity.created_at), { dateStyle: "long", timeStyle: "short" }),
    statusLabel: statusLabels[activity.processing_status] ?? activity.processing_status,
    statusTone:
      activity.processing_status === "ready"
        ? "success"
        : activity.processing_status === "failed"
          ? "danger"
          : "warning",
    distanceLabel: activity.distance_m === null ? "—" : `${format.number(activity.distance_m / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 2 })} ${t("Units.kilometer")}`,
    durationLabel: formatDuration(activity.duration_seconds),
    elevationGainLabel:
      activity.elevation_gain_m !== null
        ? `+${format.number(Math.round(activity.elevation_gain_m))} ${t("Units.meter")}`
        : "—",
    maximumElevationLabel:
      activity.maximum_elevation_m !== null
        ? `${format.number(Math.round(activity.maximum_elevation_m))} ${t("Units.meter")}`
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
          eyebrow={t("List.eyebrow")}
          title={t("List.title")}
          description={t("List.description")}
          metric={{ label: t("List.total"), value: t("List.count", { count: activities.length }) }}
          actions={
            <Link data-track-import-action href="/account/tracks/import" className="ui-pressable inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-forest)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--color-forest-hover)]">
              <Upload aria-hidden="true" className="h-4 w-4" />
              {t("List.import")}
            </Link>
          }
        />

        {activities.length === 0 ? (
          <section className="border-b border-[var(--color-border-strong)] py-14 text-center">
            <Route aria-hidden="true" className="mx-auto h-9 w-9 text-[var(--color-track)]" />
            <h2 className="mt-5 text-2xl font-bold text-[var(--color-text)]">
              {t("List.emptyTitle")}
            </h2>

            <p className="mx-auto mt-2 max-w-lg text-[var(--color-text-muted)]">
              {t("List.emptyDescription")}
            </p>

            <Link
              href="/account/tracks/import"
              className="ui-pressable mt-6 inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-forest)] px-5 py-2 font-semibold text-white hover:bg-[var(--color-forest-hover)]"
            >
              <Upload aria-hidden="true" className="h-4 w-4" />
              {t("List.importFirst")}
            </Link>
          </section>
        ) : (
          <GpsTrackList items={trackItems} />
        )}
      </div>
    </main>
  );
}
