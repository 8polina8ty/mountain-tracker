import { createAdminClient } from "@/Lib/supabase/admin";

export const dynamic = "force-dynamic";
const BUCKET = "community-route-tracks";
const UUID = /^[0-9a-f-]{36}$/i;

export async function GET(_request: Request, { params }: { params: Promise<{ id: string; routeId: string }> }) {
  const { id, routeId } = await params;
  const mountainId = Number(id);
  if (!Number.isSafeInteger(mountainId) || mountainId <= 0 || !UUID.test(routeId)) return new Response(null, { status: 404 });
  const admin = createAdminClient();
  const { data: assoc } = await admin.from("mountain_community_route_mountains")
    .select("route_id")
    .eq("route_id", routeId).eq("mountain_id", mountainId).maybeSingle();
  if (!assoc) return new Response(null, { status: 404 });

  const { data } = await admin.from("mountain_community_routes")
    .select("id,published_geojson_path").eq("id", routeId).eq("status", "published").maybeSingle();
  const route = data as { id: string; published_geojson_path: string } | null;
  if (!route || route.published_geojson_path !== `${route.id}/route.geojson`) return new Response(null, { status: 404 });
  const { data: blob, error } = await admin.storage.from(BUCKET).download(route.published_geojson_path);
  if (error || !blob) return new Response(null, { status: 404 });
  return new Response(blob.stream(), { headers: { "Content-Type": "application/geo+json", "Cache-Control": "private, no-store" } });
}
