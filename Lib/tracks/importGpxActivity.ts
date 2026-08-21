import type { SupabaseClient } from "@supabase/supabase-js";

import { detectMountainFromTrack, type DetectedMountain } from "./detectMountainFromTrack.ts";
import { parseGpxFile, type ParsedGpxTrack } from "./parseGpxFile.ts";

export const GPX_ACTIVITY_BUCKET = "activity-tracks";

export type GpxImportSource = "garmin" | "suunto" | "strava" | "komoot" | "watch" | "phone" | "other";
export type GpxImportFailureReason = "auth" | "validation" | "activity-create" | "original-upload" | "parse" | "detection" | "metadata-update" | "geojson-upload" | "cleanup-required" | "unknown";
export type GpxImportResult =
  | { ok: true; gpsActivityId: number; track: ParsedGpxTrack; detectedMountain: DetectedMountain | null }
  | { ok: false; reason: GpxImportFailureReason; retryable: boolean };

export type GpxImportInput = {
  supabase: SupabaseClient;
  file: File;
  source: GpxImportSource;
};

type GpxImportDependencies = {
  parse: typeof parseGpxFile;
  detect: typeof detectMountainFromTrack;
};

function databaseSourceType(source: GpxImportSource): string {
  if (source === "phone") return "phone_recording";
  if (source === "watch" || source === "other") return "other";
  return source;
}

export function buildGpxActivityPaths(userId: string, activityId: number) {
  const directory = `${userId}/${activityId}`;
  return { originalPath: `${directory}/original.gpx`, geoJsonPath: `${directory}/track.geojson` };
}

async function compensateFailedImport(
  supabase: SupabaseClient,
  activityId: number | null,
  paths: string[],
): Promise<boolean> {
  let cleaned = true;
  if (paths.length > 0) {
    const { error } = await supabase.storage.from(GPX_ACTIVITY_BUCKET).remove(paths);
    if (error) cleaned = false;
  }
  if (activityId !== null) {
    const { error } = await supabase.from("gps_activities").delete().eq("id", activityId);
    if (error) cleaned = false;
  }
  return cleaned;
}

export async function importGpxActivity(
  { supabase, file, source }: GpxImportInput,
  dependencies: GpxImportDependencies = { parse: parseGpxFile, detect: detectMountainFromTrack },
): Promise<GpxImportResult> {
  let activityId: number | null = null;
  let originalPath: string | null = null;
  let geoJsonPath: string | null = null;
  let originalUploadAttempted = false;
  let geoJsonUploadAttempted = false;
  let failureReason: GpxImportFailureReason = "unknown";

  try {
    const { data: authData, error: authError } = await supabase.auth.getUser();
    if (authError || !authData.user) return { ok: false, reason: "auth", retryable: false };
    if (file.name.split(".").pop()?.toLowerCase() !== "gpx") return { ok: false, reason: "validation", retryable: false };

    failureReason = "activity-create";
    const { data: activity, error: activityError } = await supabase.from("gps_activities").insert({
      user_id: authData.user.id,
      source_type: databaseSourceType(source),
      title: file.name.replace(/\.[^.]+$/, ""),
      activity_type: "hiking",
      processing_status: "pending",
      is_public: false,
    }).select("id").single();
    if (activityError) throw activityError;
    activityId = Number((activity as { id?: unknown } | null)?.id);
    if (!Number.isInteger(activityId)) throw new Error("activity-id-missing");

    ({ originalPath, geoJsonPath } = buildGpxActivityPaths(authData.user.id, activityId));
    failureReason = "original-upload";
    originalUploadAttempted = true;
    const { error: originalUploadError } = await supabase.storage.from(GPX_ACTIVITY_BUCKET).upload(originalPath, file, {
      cacheControl: "3600",
      contentType: file.type || "application/octet-stream",
      upsert: false,
    });
    if (originalUploadError) throw originalUploadError;

    failureReason = "metadata-update";
    const { error: processingError } = await supabase.from("gps_activities").update({
      original_file_url: originalPath,
      processing_status: "processing",
      processing_error: null,
      updated_at: new Date().toISOString(),
    }).eq("id", activityId).eq("user_id", authData.user.id);
    if (processingError) throw processingError;

    failureReason = "parse";
    const track = await dependencies.parse(file);
    failureReason = "detection";
    const detectedMountain = await dependencies.detect({ supabase, geojson: track.geojson });

    const geoJsonBlob = new Blob([JSON.stringify(track.geojson, null, 2)], { type: "application/geo+json" });
    failureReason = "geojson-upload";
    geoJsonUploadAttempted = true;
    const { error: geoJsonUploadError } = await supabase.storage.from(GPX_ACTIVITY_BUCKET).upload(geoJsonPath, geoJsonBlob, {
      cacheControl: "3600",
      contentType: "application/geo+json",
      upsert: false,
    });
    if (geoJsonUploadError) throw geoJsonUploadError;

    failureReason = "metadata-update";
    const { error: readyError } = await supabase.from("gps_activities").update({
      original_file_url: originalPath,
      geojson_url: geoJsonPath,
      started_at: track.startedAt,
      finished_at: track.finishedAt,
      duration_seconds: track.durationSeconds,
      distance_m: track.distanceM,
      elevation_gain_m: track.elevationGainM,
      minimum_elevation_m: track.minimumElevationM,
      maximum_elevation_m: track.maximumElevationM,
      detected_mountain_id: detectedMountain?.mountainId ?? null,
      detection_distance_m: detectedMountain?.distanceM ?? null,
      detection_confidence: detectedMountain?.confidence ?? null,
      detection_status: detectedMountain ? "detected" : "not_found",
      gps_verified: false,
      processing_status: "ready",
      processing_error: null,
      updated_at: new Date().toISOString(),
    }).eq("id", activityId).eq("user_id", authData.user.id);
    if (readyError) throw readyError;

    return { ok: true, gpsActivityId: activityId, track, detectedMountain };
  } catch {
    const attemptedPaths = [
      originalUploadAttempted ? originalPath : null,
      geoJsonUploadAttempted ? geoJsonPath : null,
    ].filter((path): path is string => path !== null);
    const cleaned = await compensateFailedImport(supabase, activityId, attemptedPaths);
    return cleaned
      ? { ok: false, reason: failureReason, retryable: true }
      : { ok: false, reason: "cleanup-required", retryable: false };
  }
}
