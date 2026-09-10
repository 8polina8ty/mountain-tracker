// Scale-safe contract: a bulk executor resolves candidates from one reusable
// offline spatial index (for example SQLite R-tree). It must not issue one
// broad Supabase mountains scan per GPX track.

import { calculateCoordinateDistanceMeters } from "./gpxNormalization.ts";
import {
  buildRouteSegmentSpatialIndex,
  getRouteSegmentCandidateIndexes,
} from "../tracks/routeSegmentSpatialIndex.ts";
import type {
  Coordinate,
  MountainMatchClassification,
  MountainMatchOutcome,
  NormalizedGpxGeometry,
  TrackBoundingBox,
} from "./types.ts";

export interface MountainMatchThresholds {
  directMatchMeters: number;
  possibleMeters: number;
  candidateSearchMeters: number;
  ambiguityConfidenceMargin: number;
  maximumCandidates: number;
}

export const DEFAULT_MATCH_THRESHOLDS: Readonly<MountainMatchThresholds> = {
  directMatchMeters: 100,
  possibleMeters: 300,
  candidateSearchMeters: 2_500,
  ambiguityConfidenceMargin: 0.08,
  maximumCandidates: 5_000,
} as const;

export interface MatchableMountain {
  id: number;
  coordinates: Coordinate;
  name: string | null;
  height: number | null;
}

export interface MountainCandidateIndex {
  readonly indexVersion: string;
  queryTrackCorridor(input: {
    geometry: NormalizedGpxGeometry["geometry"];
    boundingBox: TrackBoundingBox;
    radiusM: number;
    maximumCandidates: number;
  }): {
    candidates: MatchableMountain[];
    limitExceeded: boolean;
  };
}

export interface MountainMatchCandidate {
  mountainId: number;
  minDistanceM: number;
  classification: MountainMatchClassification;
  confidence: number;
  isPrimary: boolean;
}

export interface MountainMatchPlan {
  trackIdHint: string;
  indexVersion: string;
  candidateCount: number;
  status: "READY" | "NO_CANDIDATES" | "REVIEW_REQUIRED";
  candidates: MatchableMountain[];
}

export interface MountainMatchResult {
  outcome: MountainMatchOutcome;
  candidates: MountainMatchCandidate[];
}

export function planMountainMatch(
  trackIdHint: string,
  geometry: NormalizedGpxGeometry,
  index: MountainCandidateIndex,
  options: {
    candidateSearchMeters?: number;
    maximumCandidates?: number;
  } = {},
): MountainMatchPlan {
  const candidateSearchMeters =
    options.candidateSearchMeters ?? DEFAULT_MATCH_THRESHOLDS.candidateSearchMeters;
  const maximumCandidates =
    options.maximumCandidates ?? DEFAULT_MATCH_THRESHOLDS.maximumCandidates;
  const result = index.queryTrackCorridor({
    geometry: geometry.geometry,
    boundingBox: geometry.boundingBox,
    radiusM: candidateSearchMeters,
    maximumCandidates,
  });
  return {
    trackIdHint,
    indexVersion: index.indexVersion,
    candidateCount: result.candidates.length,
    status: result.limitExceeded
      ? "REVIEW_REQUIRED"
      : result.candidates.length === 0
        ? "NO_CANDIDATES"
        : "READY",
    candidates: result.candidates,
  };
}

export function matchResolvedPeaks(
  geometry: NormalizedGpxGeometry,
  candidatePeaks: MatchableMountain[],
  thresholdOverrides: Partial<MountainMatchThresholds> = {},
): MountainMatchResult {
  const thresholds = { ...DEFAULT_MATCH_THRESHOLDS, ...thresholdOverrides };
  const coordinates = extractCoordinates(geometry.geometry);
  const segments = extractSegments(geometry.geometry);
  const segmentIndex = buildRouteSegmentSpatialIndex(
    segments.map(([start, end]) => ({
      startLongitude: start[0],
      startLatitude: start[1],
      endLongitude: end[0],
      endLatitude: end[1],
    })),
    thresholds.candidateSearchMeters,
  );
  const candidates = candidatePeaks
    .map((peak) => {
      const candidateSegmentIndexes = getRouteSegmentCandidateIndexes(
        segmentIndex,
        peak.coordinates[0],
        peak.coordinates[1],
      );
      const minDistanceM =
        candidateSegmentIndexes.length > 0
          ? Math.min(
              ...candidateSegmentIndexes.map((index) =>
                pointToSegmentDistanceMeters(
                  peak.coordinates,
                  segments[index][0],
                  segments[index][1],
                ),
              ),
            )
          : nearestCoordinateDistance(coordinates, peak.coordinates);
      const candidate: MountainMatchCandidate = {
        mountainId: peak.id,
        minDistanceM,
        classification: classifyDistance(
          minDistanceM,
          thresholds.directMatchMeters,
          thresholds.possibleMeters,
        ),
        confidence: distanceConfidence(minDistanceM, thresholds.possibleMeters),
        isPrimary: false,
      };
      return candidate;
    })
    .filter((candidate) => candidate.minDistanceM <= thresholds.candidateSearchMeters)
    .sort(
      (left, right) =>
        classificationOrder(left.classification) -
          classificationOrder(right.classification) ||
        right.confidence - left.confidence ||
        left.minDistanceM - right.minDistanceM ||
        left.mountainId - right.mountainId,
    );

  const directCandidates = candidates.filter(
    (candidate) => candidate.classification === "DIRECT",
  );
  if (directCandidates.length === 0) {
    return { outcome: "NO_SUMMIT", candidates };
  }
  const best = directCandidates[0];
  const runnerUp = directCandidates[1];
  if (
    runnerUp &&
    best.confidence - runnerUp.confidence < thresholds.ambiguityConfidenceMargin
  ) {
    return { outcome: "AMBIGUOUS", candidates };
  }
  best.isPrimary = true;
  return { outcome: "DIRECT", candidates };
}

function classifyDistance(
  distanceM: number,
  directMatchMeters: number,
  possibleMeters: number,
): MountainMatchClassification {
  if (distanceM <= directMatchMeters) return "DIRECT";
  if (distanceM <= possibleMeters) return "POSSIBLE";
  return "REJECTED";
}

function classificationOrder(value: MountainMatchClassification): number {
  if (value === "DIRECT") return 0;
  if (value === "POSSIBLE") return 1;
  return 2;
}

function distanceConfidence(distanceM: number, possibleMeters: number): number {
  return round(Math.max(0, 1 - distanceM / Math.max(1, possibleMeters)), 4);
}

function nearestCoordinateDistance(coordinates: Coordinate[], target: Coordinate): number {
  let minimum = Infinity;
  for (const coordinate of coordinates) {
    minimum = Math.min(
      minimum,
      calculateCoordinateDistanceMeters(coordinate, target),
    );
  }
  return minimum;
}

function extractCoordinates(
  geometry: NormalizedGpxGeometry["geometry"],
): Coordinate[] {
  return geometry.type === "LineString"
    ? geometry.coordinates
    : geometry.coordinates.flat();
}

function extractSegments(
  geometry: NormalizedGpxGeometry["geometry"],
): Array<readonly [Coordinate, Coordinate]> {
  const components =
    geometry.type === "LineString" ? [geometry.coordinates] : geometry.coordinates;
  const segments: Array<readonly [Coordinate, Coordinate]> = [];
  for (const component of components) {
    for (let index = 1; index < component.length; index += 1) {
      segments.push([component[index - 1], component[index]]);
    }
  }
  return segments;
}

function pointToSegmentDistanceMeters(
  point: Coordinate,
  start: Coordinate,
  end: Coordinate,
): number {
  const averageLatitudeRadians =
    ((point[1] + start[1] + end[1]) / 3) * (Math.PI / 180);
  const longitudeScale = Math.max(0.1, Math.cos(averageLatitudeRadians));
  const segmentX = (end[0] - start[0]) * longitudeScale;
  const segmentY = end[1] - start[1];
  const pointX = (point[0] - start[0]) * longitudeScale;
  const pointY = point[1] - start[1];
  const lengthSquared = segmentX ** 2 + segmentY ** 2;
  const fraction =
    lengthSquared === 0
      ? 0
      : Math.max(
          0,
          Math.min(1, (pointX * segmentX + pointY * segmentY) / lengthSquared),
        );
  const projected: Coordinate = [
    start[0] + (end[0] - start[0]) * fraction,
    start[1] + (end[1] - start[1]) * fraction,
  ];
  return calculateCoordinateDistanceMeters(point, projected);
}

function round(value: number, digits: number): number {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}
