import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { createAdminClient } from "@/Lib/supabase/admin";
import { createClient } from "@/Lib/supabase/server";
import { GPX_ACTIVITY_BUCKET } from "@/Lib/tracks/importGpxActivity";
import { validateTrackForMountain, getAllDirectSummitsForTrack } from "@/Lib/tracks/validateTrackForMountain";
import { validateCommunityRouteContent } from "@/Lib/tracks/communityRouteContent";

export const dynamic = "force-dynamic";

const PUBLISHED_BUCKET = "community-route-tracks";

type PublishBody = { gpsActivityId?: unknown; targetMountainId?: unknown; title?: unknown };
type ActivityRow = {
  id: number; user_id: string; processing_status: string; original_file_url: string | null;
  geojson_url: string | null; distance_m: number | null; elevation_gain_m: number | null;
  duration_seconds: number | null; started_at: string | null; title: string | null;
};

function positiveInteger(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function validGeoJson(value: unknown): value is GeoJSON.FeatureCollection<GeoJSON.LineString | GeoJSON.MultiLineString> {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { type?: unknown; features?: unknown };
  return candidate.type === "FeatureCollection" && Array.isArray(candidate.features) &&
    candidate.features.length > 0 && candidate.features.every((feature) => {
      if (!feature || typeof feature !== "object") return false;
      const geometry = (feature as { geometry?: { type?: unknown; coordinates?: unknown } }).geometry;
      return Boolean(geometry && (geometry.type === "LineString" || geometry.type === "MultiLineString") && Array.isArray(geometry.coordinates));
    });
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: auth, error: authError } = await supabase.auth.getUser();
  if (authError || !auth.user) return NextResponse.json({ error: "auth" }, { status: 401 });

  let body: PublishBody;
  try { body = await request.json() as PublishBody; }
  catch { return NextResponse.json({ error: "invalid_request" }, { status: 400 }); }

  const gpsActivityId = positiveInteger(body.gpsActivityId);
  const targetMountainId = positiveInteger(body.targetMountainId);
  if (!gpsActivityId || !targetMountainId) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  const admin = createAdminClient();
  const { data: activityData, error: activityError } = await admin
    .from("gps_activities")
    .select("id,user_id,processing_status,original_file_url,geojson_url,distance_m,elevation_gain_m,duration_seconds,started_at,title")
    .eq("id", gpsActivityId).eq("user_id", auth.user.id).maybeSingle();
  const activity = activityData as ActivityRow | null;
  if (activityError || !activity) return NextResponse.json({ error: "activity_unavailable" }, { status: 404 });
  if (activity.processing_status !== "ready" || !activity.original_file_url || !activity.geojson_url) {
    return NextResponse.json({ error: "activity_not_ready" }, { status: 409 });
  }
  const activityPrefix = `${auth.user.id}/${gpsActivityId}/`;
  if (!activity.original_file_url.startsWith(activityPrefix) || !activity.geojson_url.startsWith(activityPrefix)) {
    return NextResponse.json({ error: "activity_storage_invalid" }, { status: 409 });
  }

  const { data: geoJsonBlob, error: geoJsonError } = await admin.storage
    .from(GPX_ACTIVITY_BUCKET).download(activity.geojson_url);
  if (geoJsonError || !geoJsonBlob) return NextResponse.json({ error: "activity_storage_unavailable" }, { status: 503 });
  let geojson: unknown;
  const geoJsonText = await geoJsonBlob.text();
  try { geojson = JSON.parse(geoJsonText); }
  catch { return NextResponse.json({ error: "activity_track_invalid" }, { status: 409 }); }
  if (!validGeoJson(geojson)) return NextResponse.json({ error: "activity_track_invalid" }, { status: 409 });

  const validation = await validateTrackForMountain({ targetMountainId, geojson, supabase: admin });
  if (validation.status !== "matched") {
    return NextResponse.json({ error: validation.status, validation }, { status: 422 });
  }

  const directSummits = await getAllDirectSummitsForTrack({ targetMountainId, geojson, supabase: admin });
  if (validation.distanceM === null || validation.confidence === null) {
    return NextResponse.json({ error: "low_confidence" }, { status: 422 });
  }

  const content = validateCommunityRouteContent({
    title: typeof body.title === "string" ? body.title : activity.title ?? "GPS route",
    summary: null, description: null, start_location: null, route_type: null,
    difficulty_system: null, difficulty_value: null, best_season: null,
    equipment: null, warnings: null, conditions_notes: null,
  });
  if (!content.ok) return NextResponse.json({ error: "title_invalid" }, { status: 400 });
  const { data: originalGpx, error: originalError } = await admin.storage
    .from(GPX_ACTIVITY_BUCKET).download(activity.original_file_url);
  if (originalError || !originalGpx) return NextResponse.json({ error: "activity_storage_unavailable" }, { status: 503 });

  const routeId = randomUUID();
  const publishedPath = `${routeId}/route.gpx`;
  const publishedGeoJsonPath = `${routeId}/route.geojson`;
  const { error: snapshotError } = await admin.storage.from(PUBLISHED_BUCKET)
    .upload(publishedPath, originalGpx, { contentType: "application/gpx+xml", cacheControl: "3600", upsert: false });
  if (snapshotError) return NextResponse.json({ error: "snapshot_failed" }, { status: 503 });
  const { error: geoJsonSnapshotError } = await admin.storage.from(PUBLISHED_BUCKET)
    .upload(publishedGeoJsonPath, new Blob([geoJsonText], { type: "application/geo+json" }), { contentType: "application/geo+json", cacheControl: "3600", upsert: false });
  if (geoJsonSnapshotError) {
    await admin.storage.from(PUBLISHED_BUCKET).remove([publishedPath]);
    return NextResponse.json({ error: "snapshot_failed" }, { status: 503 });
  }

  const associationRows = directSummits.map((summit) => ({
    mountain_id: summit.mountainId,
    distance_m: summit.distanceM,
    confidence: summit.confidence,
    is_primary: summit.isPrimary,
  }));

  const authorName = String(auth.user.user_metadata?.username ?? auth.user.email?.split("@")[0] ?? "Mountain Tracker user").slice(0, 80);
  const { data: route, error: publishError } = await admin
    .rpc("publish_mountain_community_route", {
      requested_route_id: routeId,
      requested_mountain_id: targetMountainId,
      requested_gps_activity_id: gpsActivityId,
      requested_user_id: auth.user.id,
      requested_title: content.value.title,
      requested_summary: content.value.summary,
      requested_description: content.value.description,
      requested_start_location: content.value.start_location,
      requested_route_type: content.value.route_type,
      requested_difficulty_system: content.value.difficulty_system,
      requested_difficulty_value: content.value.difficulty_value,
      requested_best_season: content.value.best_season,
      requested_equipment: content.value.equipment,
      requested_warnings: content.value.warnings,
      requested_conditions_notes: content.value.conditions_notes,
      requested_author_name: authorName,
      requested_validation_distance_m: validation.distanceM,
      requested_validation_confidence: validation.confidence,
      requested_distance_m: activity.distance_m ?? 0,
      requested_elevation_gain_m: activity.elevation_gain_m ?? 0,
      requested_duration_seconds: activity.duration_seconds,
      requested_activity_date: activity.started_at,
      requested_published_gpx_path: publishedPath,
      requested_published_geojson_path: publishedGeoJsonPath,
      requested_associations: associationRows,
    })
    .single();
  if (publishError) {
    await admin.storage.from(PUBLISHED_BUCKET).remove([publishedPath, publishedGeoJsonPath]);
    return NextResponse.json(
      { error: publishError.code === "23505" ? "already_published" : "publish_failed" },
      { status: publishError.code === "23505" ? 409 : 500 },
    );
  }

  return NextResponse.json({ route, validation, associations: directSummits }, { status: 201 });
}
