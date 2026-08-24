import { createRequire } from "node:module";

import { createClient } from "@supabase/supabase-js";

import {
  getAllDirectSummitsForTrack,
  validateTrackForMountain,
} from "../Lib/tracks/validateTrackForMountain.ts";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env");

const RECOVERY_ROUTE_ID = "e0edfa4b-390c-4831-a813-7bbf472540bf";
const ACTIVITY_BUCKET = "activity-tracks";
const PUBLISHED_BUCKET = "community-route-tracks";
const args = process.argv.slice(2);
const routeArguments = args.filter((argument) => argument.startsWith("--route="));
const applyArguments = args.filter((argument) => argument === "--apply");

if (
  args.some((argument) => argument !== "--apply" && !argument.startsWith("--route=")) ||
  routeArguments.length !== 1 ||
  applyArguments.length > 1
) {
  throw new Error(`Usage: node scripts/repair-community-route-associations.mjs --route=${RECOVERY_ROUTE_ID} [--apply]`);
}

const routeId = routeArguments[0].slice("--route=".length);
if (routeId !== RECOVERY_ROUTE_ID) {
  throw new Error("This operational recovery script is locked to the reviewed route ID.");
}

const apply = applyArguments.length === 1;
loadEnvConfig(process.cwd());

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceKey) {
  throw new Error("Server Supabase environment is not configured.");
}

const admin = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function validPosition(position) {
  return Array.isArray(position) &&
    position.length >= 2 &&
    position.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate));
}

function validLine(line) {
  return Array.isArray(line) && line.length >= 2 && line.every(validPosition);
}

function validTrackGeoJson(value) {
  return Boolean(
    value && typeof value === "object" && value.type === "FeatureCollection" &&
    Array.isArray(value.features) && value.features.length > 0 &&
    value.features.every((feature) => {
      const geometry = feature && typeof feature === "object" ? feature.geometry : null;
      if (!geometry || typeof geometry !== "object") return false;
      if (geometry.type === "LineString") return validLine(geometry.coordinates);
      return geometry.type === "MultiLineString" &&
        Array.isArray(geometry.coordinates) &&
        geometry.coordinates.length > 0 &&
        geometry.coordinates.every(validLine);
    }),
  );
}

async function parseTrackBlob(blob, label) {
  let value;
  try {
    value = JSON.parse(await blob.text());
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
  if (!validTrackGeoJson(value)) {
    throw new Error(`${label} is not a safe non-empty route FeatureCollection.`);
  }
  return value;
}

function normalizedRouteLines(geojson) {
  return geojson.features.flatMap((feature) => {
    const lines = feature.geometry.type === "LineString"
      ? [feature.geometry.coordinates]
      : feature.geometry.coordinates;
    return lines.map((line) => line.map((position) => [
      position[0],
      position[1],
      position.length >= 3 ? position[2] : null,
    ]));
  });
}

function routeGeometryMatches(firstGeoJson, secondGeoJson) {
  const firstLines = normalizedRouteLines(firstGeoJson);
  const secondLines = normalizedRouteLines(secondGeoJson);
  if (firstLines.length !== secondLines.length) return false;

  return firstLines.every((firstLine, lineIndex) => {
    const secondLine = secondLines[lineIndex];
    if (firstLine.length !== secondLine.length) return false;
    return firstLine.every((firstPosition, positionIndex) => {
      const secondPosition = secondLine[positionIndex];
      const horizontalMatch =
        Math.abs(firstPosition[0] - secondPosition[0]) <= 1e-9 &&
        Math.abs(firstPosition[1] - secondPosition[1]) <= 1e-9;
      const firstElevation = firstPosition[2];
      const secondElevation = secondPosition[2];
      const elevationMatch = firstElevation === null || secondElevation === null
        ? firstElevation === secondElevation
        : Math.abs(firstElevation - secondElevation) <= 0.01;
      return horizontalMatch && elevationMatch;
    });
  });
}

async function downloadRequired(bucket, path, label) {
  const { data, error } = await admin.storage.from(bucket).download(path);
  if (error || !data) throw new Error(`${label} is unavailable.`);
  return data;
}

async function main() {
  const { data: route, error: routeError } = await admin
    .from("mountain_community_routes")
    .select("id,mountain_id,gps_activity_id,user_id,status,published_gpx_path,published_geojson_path")
    .eq("id", routeId)
    .maybeSingle();
  if (routeError || !route) throw new Error("Reviewed recovery route is unavailable.");

  const expectedGpxPath = `${route.id}/route.gpx`;
  const expectedGeoJsonPath = `${route.id}/route.geojson`;
  if (
    route.status !== "published" ||
    route.published_gpx_path !== expectedGpxPath ||
    route.published_geojson_path !== expectedGeoJsonPath
  ) {
    throw new Error("Route publication state or immutable snapshot paths differ from the reviewed recovery state.");
  }

  const { count: associationCount, error: associationCountError } = await admin
    .from("mountain_community_route_mountains")
    .select("route_id", { count: "exact", head: true })
    .eq("route_id", route.id);
  if (associationCountError || associationCount !== 0) {
    throw new Error("Route associations are no longer empty; manual review is required.");
  }

  const { data: activity, error: activityError } = await admin
    .from("gps_activities")
    .select("id,user_id,processing_status,geojson_url")
    .eq("id", route.gps_activity_id)
    .maybeSingle();
  if (
    activityError || !activity ||
    activity.id !== 22 ||
    activity.user_id !== route.user_id ||
    activity.processing_status !== "ready" ||
    !activity.geojson_url
  ) {
    throw new Error("Canonical activity ownership or readiness does not match the reviewed recovery state.");
  }

  const activityPrefix = `${route.user_id}/${route.gps_activity_id}/`;
  if (!activity.geojson_url.startsWith(activityPrefix)) {
    throw new Error("Canonical activity GeoJSON path is outside the owning activity prefix.");
  }

  await downloadRequired(PUBLISHED_BUCKET, expectedGpxPath, "Immutable GPX snapshot");
  const publishedGeoJsonBlob = await downloadRequired(
    PUBLISHED_BUCKET,
    expectedGeoJsonPath,
    "Immutable GeoJSON snapshot",
  );
  const canonicalGeoJsonBlob = await downloadRequired(
    ACTIVITY_BUCKET,
    activity.geojson_url,
    "Canonical activity GeoJSON",
  );
  const publishedGeoJson = await parseTrackBlob(publishedGeoJsonBlob, "Immutable GeoJSON snapshot");
  const canonicalGeoJson = await parseTrackBlob(canonicalGeoJsonBlob, "Canonical activity GeoJSON");

  if (!routeGeometryMatches(canonicalGeoJson, publishedGeoJson)) {
    throw new Error("Published and canonical route geometry materially differ; manual review is required.");
  }

  const validation = await validateTrackForMountain({
    targetMountainId: route.mountain_id,
    geojson: publishedGeoJson,
    supabase: admin,
  });
  if (validation.status !== "matched") {
    throw new Error(`Strict target validation failed with status ${validation.status}.`);
  }

  const directSummits = await getAllDirectSummitsForTrack({
    targetMountainId: route.mountain_id,
    geojson: publishedGeoJson,
    supabase: admin,
  });
  const primaryAssociations = directSummits.filter((summit) => summit.isPrimary);
  const uniqueMountainIds = new Set(directSummits.map((summit) => summit.mountainId));
  if (
    primaryAssociations.length !== 1 ||
    primaryAssociations[0].mountainId !== route.mountain_id ||
    uniqueMountainIds.size !== directSummits.length
  ) {
    throw new Error("Verified summit associations do not contain exactly one unique requested primary.");
  }

  const verifiedMountains = directSummits.map((summit) => ({
    mountainId: summit.mountainId,
    distanceM: summit.distanceM,
    confidence: summit.confidence,
    isPrimary: summit.isPrimary,
  }));

  if (apply) {
    const { error: repairError } = await admin.rpc(
      "repair_mountain_community_route_associations",
      {
        requested_route_id: route.id,
        requested_associations: directSummits.map((summit) => ({
          mountain_id: summit.mountainId,
          distance_m: summit.distanceM,
          confidence: summit.confidence,
          is_primary: summit.isPrimary,
        })),
      },
    );
    if (repairError) throw new Error("Atomic association recovery failed.");
  }

  console.log(JSON.stringify({
    routeId: route.id,
    primaryMountainId: route.mountain_id,
    verifiedMountains,
    publishedGeojsonPath: route.published_geojson_path,
    status: apply ? "repaired" : "validated_dry_run",
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Community route recovery failed.");
  process.exitCode = 1;
});
