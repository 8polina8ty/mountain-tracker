"use client";

import { createClient } from "@/Lib/supabase/client";
import { detectMountainFromTrack } from "@/Lib/tracks/detectMountainFromTrack";
import type { ParsedGpxTrack } from "@/Lib/tracks/parseGpxFile";
import type { RecordedTrackPoint } from "./trackRecording";
import { buildGpxXml, buildGpxTrackName, computeTrackStats } from "./trackRecording";

export type SavedTrackResult = {
  activityId: number;
  originalFilePath: string;
  geoJsonFilePath: string;
};

export type SaveRecordedTrackOptions = {
  points: RecordedTrackPoint[];
  startedAt: number;
  finishedAt: number;
  activeDurationMs: number;
  trackName?: string;
  authenticationErrorMessage?: string;
};

export class SaveRecordedTrackAuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SaveRecordedTrackAuthenticationError";
  }
}

function buildParsedTrackFromPoints(
  points: RecordedTrackPoint[],
  startedAt: number,
  finishedAt: number,
  activeDurationMs: number,
): ParsedGpxTrack {
  const stats = computeTrackStats(points);

  const coordinates: GeoJSON.Position[] = points.map((point) => {
    if (point.altitudeM !== null) {
      return [point.longitude, point.latitude, point.altitudeM];
    }
    return [point.longitude, point.latitude];
  });

  const elevations = points
    .map((p) => p.altitudeM)
    .filter((e): e is number => e !== null);

  const startedAtIso = new Date(startedAt).toISOString();
  const finishedAtIso = new Date(finishedAt).toISOString();
  const durationSeconds = Math.max(0, Math.round(activeDurationMs / 1000));

  const trackName = buildGpxTrackName(startedAt);

  const geojson: ParsedGpxTrack["geojson"] = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {
          name: trackName,
          source: "phone_recording",
          point_count: points.length,
        },
        geometry: {
          type: "LineString",
          coordinates,
        },
      },
    ],
  };

  return {
    geojson,
    pointCount: points.length,
    startedAt: startedAtIso,
    finishedAt: finishedAtIso,
    durationSeconds,
    distanceM: Math.round(stats.distanceM),
    elevationGainM: Math.round(stats.elevationGainM),
    minimumElevationM:
      elevations.length > 0 ? Math.min(...elevations) : null,
    maximumElevationM:
      elevations.length > 0 ? Math.max(...elevations) : null,
  };
}

export async function saveRecordedTrack(
  options: SaveRecordedTrackOptions,
): Promise<SavedTrackResult> {
  const {
    points,
    startedAt,
    finishedAt,
    activeDurationMs,
    trackName,
    authenticationErrorMessage,
  } = options;

  if (points.length < 2) {
    throw new Error("Insufficient points to save track");
  }

  const supabase = createClient();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (!user) {
    throw new SaveRecordedTrackAuthenticationError(
      authenticationErrorMessage ?? "Authentication required to save track",
    );
  }

  if (userError) {
    throw userError;
  }

  let activityId: number | null = null;
  let uploadedFilePath: string | null = null;
  let uploadedGeoJsonPath: string | null = null;

  try {
    const parsedTrack = buildParsedTrackFromPoints(
      points,
      startedAt,
      finishedAt,
      activeDurationMs,
    );

    const gpxXml = buildGpxXml(points, trackName ?? buildGpxTrackName(startedAt));
    const gpxBlob = new Blob([gpxXml], { type: "application/gpx+xml" });

    const extension = "gpx";

    const {
      data: activity,
      error: activityError,
    } = await supabase
      .from("gps_activities")
      .insert({
        user_id: user.id,
        source_type: "phone_recording",
        title: trackName ?? buildGpxTrackName(startedAt),
        activity_type: "hiking",
        processing_status: "pending",
        is_public: false,
      })
      .select("id")
      .single();

    if (activityError) {
      throw activityError;
    }

    activityId = Number(activity.id);

    if (!Number.isInteger(activityId)) {
      throw new Error("Activity ID missing");
    }

    uploadedFilePath = [user.id, String(activityId), `original.${extension}`].join("/");

    const { error: uploadError } = await supabase.storage
      .from("activity-tracks")
      .upload(uploadedFilePath, gpxBlob, {
        cacheControl: "3600",
        contentType: "application/gpx+xml",
        upsert: false,
      });

    if (uploadError) {
      throw uploadError;
    }

    const { error: processingUpdateError } = await supabase
      .from("gps_activities")
      .update({
        original_file_url: uploadedFilePath,
        processing_status: "processing",
        processing_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", activityId)
      .eq("user_id", user.id);

    if (processingUpdateError) {
      throw processingUpdateError;
    }

    const detectedMountain = await detectMountainFromTrack({
      supabase,
      geojson: parsedTrack.geojson,
    });

    const geoJsonFileName = "track.geojson";
    uploadedGeoJsonPath = [user.id, String(activityId), geoJsonFileName].join("/");

    const geoJsonBlob = new Blob(
      [JSON.stringify(parsedTrack.geojson, null, 2)],
      { type: "application/geo+json" },
    );

    const { error: geoJsonUploadError } = await supabase.storage
      .from("activity-tracks")
      .upload(uploadedGeoJsonPath, geoJsonBlob, {
        cacheControl: "3600",
        contentType: "application/geo+json",
        upsert: false,
      });

    if (geoJsonUploadError) {
      throw geoJsonUploadError;
    }

    const { error: readyUpdateError } = await supabase
      .from("gps_activities")
      .update({
        original_file_url: uploadedFilePath,
        geojson_url: uploadedGeoJsonPath,
        started_at: parsedTrack.startedAt,
        finished_at: parsedTrack.finishedAt,
        duration_seconds: parsedTrack.durationSeconds,
        distance_m: parsedTrack.distanceM,
        elevation_gain_m: parsedTrack.elevationGainM,
        minimum_elevation_m: parsedTrack.minimumElevationM,
        maximum_elevation_m: parsedTrack.maximumElevationM,
        detected_mountain_id: detectedMountain?.mountainId ?? null,
        detection_distance_m: detectedMountain?.distanceM ?? null,
        detection_confidence: detectedMountain?.confidence ?? null,
        detection_status: detectedMountain ? "detected" : "not_found",
        gps_verified: false,
        processing_status: "ready",
        processing_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", activityId)
      .eq("user_id", user.id);

    if (readyUpdateError) {
      throw readyUpdateError;
    }

    return {
      activityId,
      originalFilePath: uploadedFilePath,
      geoJsonFilePath: uploadedGeoJsonPath,
    };
  } catch (error) {
    const filesToRemove = [uploadedFilePath, uploadedGeoJsonPath].filter(
      (path): path is string => path !== null,
    );

    if (filesToRemove.length > 0) {
      await supabase.storage.from("activity-tracks").remove(filesToRemove);
    }

    if (activityId !== null) {
      await supabase
        .from("gps_activities")
        .delete()
        .eq("id", activityId)
        .eq("user_id", user.id);
    }

    throw error;
  }
}

export function buildDefaultTrackName(startedAt: number, locale: string): string {
  const date = new Date(startedAt);
  const formattedDate = date.toLocaleDateString(locale, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
  return formattedDate;
}
