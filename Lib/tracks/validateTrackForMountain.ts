import type { SupabaseClient } from "@supabase/supabase-js";

import {
  evaluateMountainCandidatesForTrack,
  type MountainDetectionCandidate,
} from "./detectMountainFromTrack.ts";

export const PUBLIC_ROUTE_MAX_SUMMIT_DISTANCE_M = 300;
export const PUBLIC_ROUTE_DIRECT_SUMMIT_RADIUS_M = 100;
export const PUBLIC_ROUTE_MIN_CONFIDENCE = 0.75;
export const PUBLIC_ROUTE_MIN_CONFIDENCE_MARGIN = 0.08;

export type PublicRouteValidationStatus =
  | "matched"
  | "wrong_mountain"
  | "ambiguous"
  | "too_far"
  | "low_confidence"
  | "mountain_coordinates_missing"
  | "not_found";

export type PublicRouteValidationResult = {
  targetMountainId: number;
  detectedMountainId: number | null;
  mountainName: string | null;
  distanceM: number | null;
  confidence: number | null;
  targetCandidate: MountainDetectionCandidate | null;
  runnerUp: MountainDetectionCandidate | null;
  allCandidates: MountainDetectionCandidate[];
  status: PublicRouteValidationStatus;
};

export type DirectSummitAssociation = {
  mountainId: number;
  mountainName: string;
  mountainHeight: number | null;
  distanceM: number;
  confidence: number;
  isPrimary: boolean;
};

type TargetMountain = {
  id: number;
  latitude: number | null;
  longitude: number | null;
};

function classifyTrackForMountainInternal(
  targetMountainId: number,
  targetHasCoordinates: boolean,
  candidates: MountainDetectionCandidate[],
): PublicRouteValidationResult {
  const targetCandidate = candidates.find(
    (candidate) => candidate.mountainId === targetMountainId,
  ) ?? null;
  const bestMountain = candidates[0] ?? null;
  const runnerUp = candidates[1] ?? null;
  const base = {
    targetMountainId,
    detectedMountainId: bestMountain?.mountainId ?? null,
    mountainName: bestMountain?.mountainName ?? null,
    distanceM: targetCandidate?.distanceM ?? bestMountain?.distanceM ?? null,
    confidence: targetCandidate?.confidence ?? bestMountain?.confidence ?? null,
    targetCandidate,
    runnerUp,
    allCandidates: candidates,
  };

  if (!targetHasCoordinates) return { ...base, status: "mountain_coordinates_missing" };
  if (!bestMountain) return { ...base, status: "not_found" };
  if (!targetCandidate) return { ...base, status: "wrong_mountain" };
  if (
    !Number.isFinite(targetCandidate.distanceM) || targetCandidate.distanceM < 0 ||
    !Number.isFinite(targetCandidate.confidence) || targetCandidate.confidence < PUBLIC_ROUTE_MIN_CONFIDENCE ||
    targetCandidate.confidence > 1
  ) {
    return { ...base, status: "low_confidence" };
  }
  if (targetCandidate.distanceM <= PUBLIC_ROUTE_DIRECT_SUMMIT_RADIUS_M) {
    return { ...base, status: "matched" };
  }
  if (bestMountain.mountainId !== targetMountainId) return { ...base, status: "wrong_mountain" };
  if (targetCandidate.distanceM > PUBLIC_ROUTE_MAX_SUMMIT_DISTANCE_M) return { ...base, status: "too_far" };
  if (
    runnerUp &&
    bestMountain.confidence - runnerUp.confidence < PUBLIC_ROUTE_MIN_CONFIDENCE_MARGIN
  ) {
    return { ...base, status: "ambiguous" };
  }
  return { ...base, status: "matched" };
}

export function classifyTrackForMountain(
  targetMountainId: number,
  targetHasCoordinates: boolean,
  detected: { mountainId: number; mountainName: string; distanceM: number; confidence: number; runnerUp: MountainDetectionCandidate | null; candidates: MountainDetectionCandidate[] } | null,
): PublicRouteValidationResult {
  if (!detected) {
    return classifyTrackForMountainInternal(targetMountainId, targetHasCoordinates, []);
  }
  return classifyTrackForMountainInternal(targetMountainId, targetHasCoordinates, detected.candidates);
}

export function getDirectSummitAssociations(
  targetMountainId: number,
  candidates: MountainDetectionCandidate[],
  validationStatus: PublicRouteValidationStatus,
): DirectSummitAssociation[] {
  const associations: DirectSummitAssociation[] = [];
  let primaryAdded = false;

  for (const candidate of candidates) {
    const isDirectSummit =
      candidate.distanceM <= PUBLIC_ROUTE_DIRECT_SUMMIT_RADIUS_M &&
      candidate.confidence >= PUBLIC_ROUTE_MIN_CONFIDENCE;

    if (!isDirectSummit) continue;

    const isPrimary = candidate.mountainId === targetMountainId;
    if (isPrimary) {
      primaryAdded = true;
    }

    associations.push({
      mountainId: candidate.mountainId,
      mountainName: candidate.mountainName,
      mountainHeight: candidate.mountainHeight,
      distanceM: candidate.distanceM,
      confidence: candidate.confidence,
      isPrimary,
    });
  }

  const primaryCandidate = candidates.find((c) => c.mountainId === targetMountainId);
  const primaryPassedValidation = validationStatus === "matched" && primaryCandidate;
  if (primaryPassedValidation && !primaryAdded) {
    associations.unshift({
      mountainId: primaryCandidate.mountainId,
      mountainName: primaryCandidate.mountainName,
      mountainHeight: primaryCandidate.mountainHeight,
      distanceM: primaryCandidate.distanceM,
      confidence: primaryCandidate.confidence,
      isPrimary: true,
    });
    primaryAdded = true;
  }

  if (!primaryAdded && associations.length > 0) {
    associations[0].isPrimary = true;
  }

  return associations;
}

export async function validateTrackForMountain({
  targetMountainId,
  geojson,
  supabase,
}: {
  targetMountainId: number;
  geojson: GeoJSON.FeatureCollection<GeoJSON.LineString | GeoJSON.MultiLineString>;
  supabase: SupabaseClient;
}): Promise<PublicRouteValidationResult> {
  const { data } = await supabase
    .from("mountains")
    .select("id, latitude, longitude")
    .eq("id", targetMountainId)
    .maybeSingle();
  const target = data as TargetMountain | null;
  if (!target) {
    return classifyTrackForMountainInternal(targetMountainId, true, []);
  }
  const hasCoordinates = target.latitude !== null && target.longitude !== null;
  if (!hasCoordinates) return classifyTrackForMountainInternal(targetMountainId, false, []);

  const candidates = await evaluateMountainCandidatesForTrack({
    supabase,
    geojson,
    confirmationRadiusM: PUBLIC_ROUTE_MAX_SUMMIT_DISTANCE_M,
  });
  return classifyTrackForMountainInternal(targetMountainId, true, candidates);
}

export async function getAllDirectSummitsForTrack({
  geojson,
  supabase,
  targetMountainId,
}: {
  geojson: GeoJSON.FeatureCollection<GeoJSON.LineString | GeoJSON.MultiLineString>;
  supabase: SupabaseClient;
  targetMountainId: number;
}): Promise<DirectSummitAssociation[]> {
  const candidates = await evaluateMountainCandidatesForTrack({
    supabase,
    geojson,
    confirmationRadiusM: PUBLIC_ROUTE_MAX_SUMMIT_DISTANCE_M,
  });
  const validation = classifyTrackForMountainInternal(targetMountainId, true, candidates);
  return getDirectSummitAssociations(targetMountainId, candidates, validation.status);
}
