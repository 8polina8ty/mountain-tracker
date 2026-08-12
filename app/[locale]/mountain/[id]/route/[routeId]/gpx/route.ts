import { getTranslations } from "next-intl/server";

import { createClient } from "@/Lib/supabase/server";
import { defaultLocale, isLocale } from "@/i18n/locales";

export const dynamic = "force-dynamic";

type RouteGpxParams = {
  locale: string;
  id: string;
  routeId: string;
};

type RouteGpxRecord = {
  id: number;
  name: string;
  gpx_url: string | null;
};

type MountainNameRecord = {
  name: string | null;
  name_de: string | null;
};

function toPositiveInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }

  const number = Number(value);

  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function slugPart(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function buildGpxDownloadName(
  mountainName: string,
  routeName: string,
  routeId: number,
): { base: string; asciiFallback: string } {
  const mountain = slugPart(mountainName) || "mountain";
  const route = slugPart(routeName) || `route-${routeId}`;
  const base = `${mountain}-${route}`.slice(0, 80);
  const asciiFallback =
    base
      .replace(/[^A-Za-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "mountain-route";

  return { base, asciiFallback };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<RouteGpxParams> },
) {
  const { locale, id, routeId } = await params;

  const activeLocale = isLocale(locale) ? locale : defaultLocale;
  const t = await getTranslations({
    locale: activeLocale,
    namespace: "Mountain",
  });

  const unavailable = (status: number) =>
    new Response(t("Routes.gpxUnavailable"), {
      status,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });

  if (!isLocale(locale)) {
    return unavailable(404);
  }

  const mountainId = toPositiveInteger(id);
  const routeIdNumber = toPositiveInteger(routeId);

  if (mountainId === null || routeIdNumber === null) {
    return unavailable(404);
  }

  const supabase = await createClient();

  const { data: route, error } = await supabase
    .from("mountain_routes")
    .select("id, name, gpx_url")
    .eq("id", routeIdNumber)
    .eq("mountain_id", mountainId)
    .eq("is_verified", true)
    .maybeSingle();

  if (error) {
    console.error("Ошибка загрузки маршрута для GPX:", error);
  }

  const gpxUrl = (route as RouteGpxRecord | null)?.gpx_url;

  if (!route || !gpxUrl) {
    return unavailable(404);
  }

  if (!/^https?:\/\//i.test(gpxUrl)) {
    return unavailable(404);
  }

  let upstream: Response;

  try {
    upstream = await fetch(gpxUrl, {
      headers: { Accept: "application/gpx+xml" },
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return unavailable(503);
  }

  if (!upstream.ok) {
    return unavailable(503);
  }

  const { data: mountain } = (await supabase
    .from("mountains")
    .select("name, name_de")
    .eq("id", mountainId)
    .maybeSingle()) as { data: MountainNameRecord | null };

  const mountainName = mountain?.name_de ?? mountain?.name ?? "mountain";
  const { base, asciiFallback } = buildGpxDownloadName(
    mountainName,
    (route as RouteGpxRecord).name,
    routeIdNumber,
  );

  const headers = new Headers();
  headers.set("Content-Type", "application/gpx+xml");
  headers.set(
    "Content-Disposition",
    `attachment; filename="${asciiFallback}.gpx"; filename*=UTF-8''${encodeURIComponent(`${base}.gpx`)}`,
  );
  headers.set("Cache-Control", "private, no-store");

  const contentLength = upstream.headers.get("content-length");
  if (contentLength) {
    headers.set("Content-Length", contentLength);
  }

  return new Response(upstream.body, { status: 200, headers });
}
