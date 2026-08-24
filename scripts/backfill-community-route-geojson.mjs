import { createRequire } from "node:module";

import { createClient } from "@supabase/supabase-js";

import { validateTrackForMountain, getAllDirectSummitsForTrack } from "../Lib/tracks/validateTrackForMountain.ts";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env");

const ACTIVITY_BUCKET = "activity-tracks";
const PUBLISHED_BUCKET = "community-route-tracks";
const args = process.argv.slice(2);

if (args.some((argument) => argument !== "--apply")) {
  throw new Error("Unknown argument. Run without arguments for dry-run or use only --apply.");
}

const apply = args.includes("--apply");
loadEnvConfig(process.cwd());

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceKey) {
  throw new Error("Server Supabase environment is not configured.");
}

const admin = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function validCoordinates(value) {
  if (!Array.isArray(value) || value.length === 0) return false;
  if (typeof value[0] === "number") {
    return value.length >= 2 && value.every((coordinate) => Number.isFinite(coordinate));
  }
  return value.every(validCoordinates);
}

function validGeoJson(value) {
  return Boolean(
    value && typeof value === "object" && value.type === "FeatureCollection" &&
    Array.isArray(value.features) && value.features.length > 0 &&
    value.features.every((feature) => {
      const geometry = feature && typeof feature === "object" ? feature.geometry : null;
      return Boolean(
        geometry && (geometry.type === "LineString" || geometry.type === "MultiLineString") &&
        validCoordinates(geometry.coordinates),
      );
    }),
  );
}

function report(route, status, extra = {}) {
  console.log(JSON.stringify({
    routeId: route.id,
    mountainId: route.mountain_id,
    gpsActivityId: route.gps_activity_id,
    status,
    destinationPath: `${route.id}/route.geojson`,
    ...extra,
  }));
}

async function processRoute(route) {
  const destinationPath = `${route.id}/route.geojson`;
  const expectedGpxPath = `${route.id}/route.gpx`;
  if (route.published_gpx_path !== expectedGpxPath) {
    report(route, "invalid_gpx_snapshot_path");
    return false;
  }

  const { data: activity, error: activityError } = await admin
    .from("gps_activities")
    .select("id,user_id,processing_status,geojson_url")
    .eq("id", route.gps_activity_id)
    .maybeSingle();
  if (activityError || !activity || activity.user_id !== route.user_id) {
    report(route, "activity_owner_mismatch_or_missing");
    return false;
  }
  if (activity.processing_status !== "ready" || !activity.geojson_url) {
    report(route, "activity_not_ready");
    return false;
  }
  const activityPrefix = `${route.user_id}/${route.gps_activity_id}/`;
  if (!activity.geojson_url.startsWith(activityPrefix)) {
    report(route, "invalid_activity_geojson_path");
    return false;
  }

  const { data: existingGpx, error: gpxError } = await admin.storage
    .from(PUBLISHED_BUCKET)
    .download(expectedGpxPath);
  if (gpxError || !existingGpx) {
    report(route, "missing_gpx_snapshot");
    return false;
  }

  const { data: geoJsonBlob, error: geoJsonError } = await admin.storage
    .from(ACTIVITY_BUCKET)
    .download(activity.geojson_url);
  if (geoJsonError || !geoJsonBlob) {
    report(route, "canonical_geojson_unavailable");
    return false;
  }

  let geojson;
  try {
    geojson = JSON.parse(await geoJsonBlob.text());
  } catch {
    report(route, "invalid_geojson_json");
    return false;
  }
  if (!validGeoJson(geojson)) {
    report(route, "invalid_geojson_feature_collection");
    return false;
  }

  const validation = await validateTrackForMountain({
    targetMountainId: route.mountain_id,
    geojson,
    supabase: admin,
  });

  const directSummits = await getAllDirectSummitsForTrack({
    targetMountainId: route.mountain_id,
    geojson,
    supabase: admin,
  });

  const verifiedMountains = directSummits.map((summit) => ({
    mountainId: summit.mountainId,
    distanceM: summit.distanceM,
    confidence: summit.confidence,
    isPrimary: summit.isPrimary,
  }));

  report(route, validation.status, {
    validationDistanceM: validation.distanceM,
    validationConfidence: validation.confidence,
    mode: apply ? "apply" : "dry-run",
    verifiedMountains,
  });

  if (validation.status !== "matched" || !apply) return validation.status === "matched";

  const sanitizedGeoJson = JSON.stringify(geojson);
  const { error: uploadError } = await admin.storage
    .from(PUBLISHED_BUCKET)
    .upload(destinationPath, sanitizedGeoJson, {
      contentType: "application/geo+json",
      cacheControl: "3600",
      upsert: false,
    });
  if (uploadError) {
    report(route, "snapshot_upload_failed");
    return false;
  }

  const associationRows = directSummits.map((summit) => ({
    mountain_id: summit.mountainId,
    distance_m: summit.distanceM,
    confidence: summit.confidence,
    is_primary: summit.isPrimary,
  }));

  const { error: finalizeError } = await admin.rpc(
    "finalize_mountain_community_route_backfill",
    {
      requested_route_id: route.id,
      requested_published_geojson_path: destinationPath,
      requested_associations: associationRows,
    },
  );
  if (finalizeError) {
    const { error: compensationError } = await admin.storage
      .from(PUBLISHED_BUCKET)
      .remove([destinationPath]);
    report(route, compensationError ? "finalize_failed_compensation_failed" : "finalize_failed_compensated");
    return false;
  }

  report(route, "backfilled");
  return true;
}

console.log(apply ? "APPLY mode: approved mutations are enabled." : "DRY RUN: no Storage or database mutations will occur.");
const { data: routes, error: routesError } = await admin
  .from("mountain_community_routes")
  .select("id,mountain_id,gps_activity_id,user_id,status,published_gpx_path,published_geojson_path")
  .eq("status", "published")
  .is("published_geojson_path", null)
  .order("published_at", { ascending: true });
if (routesError) throw new Error("Unable to load routes requiring GeoJSON backfill.");

let failed = 0;
for (const route of routes ?? []) {
  try {
    if (!await processRoute(route)) failed += 1;
  } catch {
    report(route, "unexpected_error");
    failed += 1;
  }
}
console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", reviewed: routes?.length ?? 0, failed }));
if (failed > 0) process.exitCode = 1;
