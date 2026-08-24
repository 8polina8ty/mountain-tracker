import { getTranslations } from "next-intl/server";

import { createAdminClient } from "@/Lib/supabase/admin";
import { defaultLocale, isLocale } from "@/i18n/locales";

export const dynamic = "force-dynamic";
const PUBLISHED_BUCKET = "community-route-tracks";

function positiveInteger(value: string): number | null {
  return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
}
function filenamePart(value: string): string {
  return value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "community-route";
}

export async function GET(_request: Request, { params }: { params: Promise<{ locale: string; id: string; routeId: string }> }) {
  const { locale, id, routeId } = await params;
  const activeLocale = isLocale(locale) ? locale : defaultLocale;
  const t = await getTranslations({ locale: activeLocale, namespace: "Mountain.CommunityRoutes" });
  const unavailable = () => new Response(t("downloadUnavailable"), { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "private, no-store" } });
  if (!isLocale(locale)) return unavailable();
  const mountainId = positiveInteger(id);
  if (!mountainId || !/^[0-9a-f-]{36}$/i.test(routeId)) return unavailable();

  const admin = createAdminClient();
  const { data: assoc } = await admin.from("mountain_community_route_mountains")
    .select("route_id")
    .eq("route_id", routeId).eq("mountain_id", mountainId).maybeSingle();
  if (!assoc) return unavailable();

  const { data } = await admin.from("mountain_community_routes")
    .select("id,title,published_gpx_path,status")
    .eq("id", routeId).eq("status", "published").maybeSingle();
  const route = data as { id: string; title: string; published_gpx_path: string; status: string } | null;
  if (!route || route.published_gpx_path !== `${route.id}/route.gpx`) return unavailable();
  const { data: blob, error } = await admin.storage.from(PUBLISHED_BUCKET).download(route.published_gpx_path);
  if (error || !blob) return unavailable();
  const name = `${filenamePart(route.title)}-community-${route.id.slice(0, 8)}.gpx`;
  return new Response(blob.stream(), { headers: {
    "Content-Type": "application/gpx+xml",
    "Content-Disposition": `attachment; filename="${name}"`,
    "Cache-Control": "private, no-store",
  } });
}
