import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { createClient } from "@/Lib/supabase/server";
import type { Locale } from "@/i18n/locales";
import { getLocalizedSeoUrls, getOpenGraphLocale } from "@/i18n/seo";
import RouteExplorerClient from "@/components/routes/RouteExplorerClient";

type RoutesPageProps = {
  params: Promise<{ locale: Locale }>;
};

export type RouteIndexEntry = {
  id: number;
  mountain_id: number;
  name: string;
  route_type: string;
  distance_km: number | null;
  elevation_gain_m: number | null;
  duration_minutes: number | null;
  gpx_url: string | null;
  geojson_url: string | null;
  mountain: {
    id: number;
    name: string | null;
    name_de: string | null;
    height: number;
    latitude: number | null;
    longitude: number | null;
  };
};

export async function generateMetadata({ params }: RoutesPageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Routes" });
  const { alternates, canonical } = getLocalizedSeoUrls(locale, "/routes");
  const title = t("title");
  const description = t("subtitle", { count: 573 });
  return {
    title,
    description,
    alternates,
    openGraph: { title, description, url: canonical ?? undefined, locale: getOpenGraphLocale(locale), type: "website" },
  };
}

export default async function RoutesPage({ params }: RoutesPageProps) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Routes" });
  const supabase = await createClient();

  // Lightweight index: only verified generated routes. Prefer GH set via source_name + generated path.
  const { data, error } = await supabase
    .from("mountain_routes")
    .select(
      `
        id,
        mountain_id,
        name,
        route_type,
        distance_km,
        elevation_gain_m,
        duration_minutes,
        gpx_url,
        geojson_url,
        mountains!inner (
          id,
          name,
          name_de,
          height,
          latitude,
          longitude
        )
      `,
    )
    .eq("is_verified", true)
    .like("gpx_url", "%/generated/%")
    .order("id", { ascending: true })
    .limit(1000);

  // Fallback if like filter excludes: try without like
  let rows = (data ?? []) as unknown as Array<RouteIndexEntry & { mountains: RouteIndexEntry["mountain"] }>;
  let loadError: string | null = null;
  if (error) {
    console.error("Route explorer load error:", error);
    loadError = error.message;
    rows = [];
  }
  // Some deployments may have gpx_url not containing generated for legacy; fallback to is_verified only if count 0
  if (rows.length === 0 && !loadError) {
    const fallback = await supabase
      .from("mountain_routes")
      .select(
        `id,mountain_id,name,route_type,distance_km,elevation_gain_m,duration_minutes,gpx_url,geojson_url,mountains!inner(id,name,name_de,height,latitude,longitude)`,
      )
      .eq("is_verified", true)
      .order("id", { ascending: true })
      .limit(1000);
    if (!fallback.error && fallback.data) {
      rows = fallback.data as unknown as typeof rows;
    }
  }

  const index: RouteIndexEntry[] = rows
    .filter((r) => r.mountains?.latitude != null && r.mountains?.longitude != null)
    .map((r) => ({
      id: r.id,
      mountain_id: r.mountain_id,
      name: r.name,
      route_type: r.route_type,
      distance_km: r.distance_km,
      elevation_gain_m: r.elevation_gain_m,
      duration_minutes: r.duration_minutes,
      gpx_url: r.gpx_url,
      geojson_url: r.geojson_url,
      mountain: {
        id: r.mountains.id,
        name: r.mountains.name,
        name_de: r.mountains.name_de,
        height: r.mountains.height,
        latitude: r.mountains.latitude,
        longitude: r.mountains.longitude,
      },
    }));

  const liveCount = index.length;

  return (
    <main className="min-h-[calc(100dvh-58px)] bg-[var(--color-bg)] text-[var(--color-text)] lg:min-h-[calc(100dvh-66px)]">
      <div className="mx-auto max-w-[1920px] px-4 py-6 sm:px-6 lg:px-6">
        <header className="mb-6 border-b border-[var(--color-border-strong)] pb-5">
          <p className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.1em] text-[var(--color-forest)]">
            {t("countLabel", { count: liveCount })}
          </p>
          <h1 className="mt-2 text-3xl font-bold tracking-[-0.02em] sm:text-4xl">{t("title")}</h1>
          <p className="mt-2 max-w-2xl text-[var(--color-text-secondary)]">{t("subtitle", { count: liveCount })}</p>
          {loadError && <p className="mt-3 text-sm text-[var(--color-danger)]" role="alert">{t("error")}: {loadError}</p>}
        </header>
        <RouteExplorerClient locale={locale} routes={index} />
      </div>
    </main>
  );
}
