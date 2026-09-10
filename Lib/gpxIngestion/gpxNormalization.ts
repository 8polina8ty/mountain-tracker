// Phase 12A/12B deterministic normalization of already-parsed GPX segments.
// The server SAX parser feeds this environment-independent numeric and identity
// core; the existing browser import remains behaviorally unchanged.

import {
  normalizeCoordinateForHash,
  sha256Bytes,
  sha256DirectionNeutralGeometryHash,
  sha256GeometryHash,
} from "./hashing.ts";
import type {
  Coordinate,
  GpxNormalizationFlag,
  NormalizedGpxGeometry,
  NormalizedServerGpx,
  NormalizedTrackGeometry,
  ParsedGpxSegment,
} from "./types.ts";
import type { ServerParsedGpx } from "./parserContract.ts";

const EARTH_RADIUS_M = 6_371_008.8;
export const ELEVATION_GAIN_JITTER_THRESHOLD_M = 3;
export const GPX_NORMALIZED_SCHEMA_VERSION =
  "mountain-tracker/external-gpx/v1" as const;
export const GPX_NORMALIZATION_VERSION =
  "mountain-tracker/gpx-normalization/v1" as const;
export const GPX_ELEVATION_ALGORITHM_VERSION = "positive-delta-3m/v1" as const;

export interface NormalizeGeometryOptions {
  minimumTrackPoints: number;
  maximumTrackPoints: number;
  maximumSegments: number;
}

export const DEFAULT_NORMALIZE_GEOMETRY_OPTIONS: NormalizeGeometryOptions = {
  minimumTrackPoints: 2,
  maximumTrackPoints: 250_000,
  maximumSegments: 10_000,
};

export interface NormalizeResult {
  geometry: NormalizedGpxGeometry;
  rawContentHash: string | null;
}

export type GpxNormalizationErrorCode =
  | "NO_SEGMENTS"
  | "TOO_FEW_POINTS"
  | "POINT_LIMIT_EXCEEDED"
  | "SEGMENT_LIMIT_EXCEEDED"
  | "INVALID_COORDINATE"
  | "INVALID_ELEVATION";

export class GpxNormalizationError extends Error {
  readonly code: GpxNormalizationErrorCode;

  constructor(code: GpxNormalizationErrorCode, message: string) {
    super(message);
    this.name = "GpxNormalizationError";
    this.code = code;
  }
}

export class GpxGeometryTooShortError extends GpxNormalizationError {
  readonly pointCount: number;

  constructor(pointCount: number, minimumTrackPoints: number) {
    super(
      "TOO_FEW_POINTS",
      `Track has ${pointCount} points; below the minimum of ${minimumTrackPoints}.`,
    );
    this.name = "GpxGeometryTooShortError";
    this.pointCount = pointCount;
  }
}

export function calculateCoordinateDistanceMeters(
  a: Coordinate,
  b: Coordinate,
): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const latitudeDifference = toRadians(b[1] - a[1]);
  const longitudeDifference = toRadians(b[0] - a[0]);
  const firstLatitude = toRadians(a[1]);
  const secondLatitude = toRadians(b[1]);
  const haversine =
    Math.sin(latitudeDifference / 2) ** 2 +
    Math.cos(firstLatitude) *
      Math.cos(secondLatitude) *
      Math.sin(longitudeDifference / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

/** Compatibility helper for a single segment without timestamps. */
export function normalizeGpxGeometry(
  coordinates: readonly Coordinate[],
  options: Partial<NormalizeGeometryOptions> = {},
): NormalizeResult {
  return normalizeGpxSegments(
    [{ points: coordinates.map((coordinate) => ({ coordinate, time: null })) }],
    null,
    options,
  );
}

export function normalizeGpxSegments(
  inputSegments: readonly ParsedGpxSegment[],
  rawBytes: Uint8Array | null,
  optionOverrides: Partial<NormalizeGeometryOptions> = {},
): NormalizeResult {
  const options = { ...DEFAULT_NORMALIZE_GEOMETRY_OPTIONS, ...optionOverrides };
  if (
    !Number.isSafeInteger(options.minimumTrackPoints) ||
    !Number.isSafeInteger(options.maximumTrackPoints) ||
    !Number.isSafeInteger(options.maximumSegments) ||
    options.minimumTrackPoints < 2 ||
    options.maximumTrackPoints < options.minimumTrackPoints ||
    options.maximumSegments < 1
  ) {
    throw new Error("Invalid GPX normalization limits.");
  }
  if (inputSegments.length === 0) {
    throw new GpxNormalizationError("NO_SEGMENTS", "GPX contains no track segments.");
  }
  if (inputSegments.length > options.maximumSegments) {
    throw new GpxNormalizationError(
      "SEGMENT_LIMIT_EXCEEDED",
      `GPX contains more than ${options.maximumSegments} segments.`,
    );
  }

  const inputPointCount = inputSegments.reduce(
    (count, segment) => count + segment.points.length,
    0,
  );
  if (inputPointCount < options.minimumTrackPoints) {
    throw new GpxGeometryTooShortError(
      inputPointCount,
      options.minimumTrackPoints,
    );
  }
  if (inputPointCount > options.maximumTrackPoints) {
    throw new GpxNormalizationError(
      "POINT_LIMIT_EXCEEDED",
      `GPX contains more than ${options.maximumTrackPoints} points.`,
    );
  }

  const segments = inputSegments
    .filter((segment) => segment.points.length > 0)
    .map((segment) =>
      segment.points.map((point) => ({
        coordinate: validateAndNormalizeCoordinate(point.coordinate),
        time: normalizeTime(point.time),
      })),
    );
  const pointCount = segments.reduce((count, segment) => count + segment.length, 0);
  if (segments.some((segment) => segment.length < 2)) {
    throw new GpxNormalizationError(
      "TOO_FEW_POINTS",
      "Every non-empty GPX track segment must contain at least two points.",
    );
  }

  let distanceM = 0;
  let elevationGainM = 0;
  let elevationPairCount = 0;
  let minimumElevationM: number | null = null;
  let maximumElevationM: number | null = null;
  let minimumLongitude = Infinity;
  let minimumLatitude = Infinity;
  let maximumLongitude = -Infinity;
  let maximumLatitude = -Infinity;
  const times: string[] = [];

  for (const segment of segments) {
    for (let pointIndex = 0; pointIndex < segment.length; pointIndex += 1) {
      const point = segment[pointIndex];
      const coordinate = point.coordinate;
      minimumLongitude = Math.min(minimumLongitude, coordinate[0]);
      maximumLongitude = Math.max(maximumLongitude, coordinate[0]);
      minimumLatitude = Math.min(minimumLatitude, coordinate[1]);
      maximumLatitude = Math.max(maximumLatitude, coordinate[1]);
      if (coordinate.length === 3) {
        minimumElevationM =
          minimumElevationM === null
            ? coordinate[2]
            : Math.min(minimumElevationM, coordinate[2]);
        maximumElevationM =
          maximumElevationM === null
            ? coordinate[2]
            : Math.max(maximumElevationM, coordinate[2]);
      }
      if (point.time !== null) times.push(point.time);
      if (pointIndex === 0) continue;

      const previousCoordinate = segment[pointIndex - 1].coordinate;
      distanceM += calculateCoordinateDistanceMeters(previousCoordinate, coordinate);
      if (previousCoordinate.length === 3 && coordinate.length === 3) {
        elevationPairCount += 1;
        const rise = coordinate[2] - previousCoordinate[2];
        if (rise >= ELEVATION_GAIN_JITTER_THRESHOLD_M) elevationGainM += rise;
      }
    }
  }

  const coordinateSegments = segments.map((segment) =>
    segment.map((point) => point.coordinate),
  );
  const geometry: NormalizedTrackGeometry =
    coordinateSegments.length === 1
      ? { type: "LineString", coordinates: coordinateSegments[0] }
      : { type: "MultiLineString", coordinates: coordinateSegments };
  const firstSegment = coordinateSegments[0];
  const lastSegment = coordinateSegments[coordinateSegments.length - 1];
  const startedAt = times[0] ?? null;
  const finishedAt = times[times.length - 1] ?? null;
  const durationSeconds =
    startedAt !== null && finishedAt !== null
      ? nonNegativeDurationSeconds(startedAt, finishedAt)
      : null;

  return {
    geometry: {
      geometry,
      normalizedGeometryHash: sha256GeometryHash(geometry),
      directionNeutralGeometryHash: sha256DirectionNeutralGeometryHash(geometry),
      distanceM: round(distanceM, 3),
      minimumElevationM,
      maximumElevationM,
      elevationGainM: elevationPairCount === 0 ? null : round(elevationGainM, 3),
      pointCount,
      startedAt,
      finishedAt,
      durationSeconds,
      boundingBox: {
        minimumLongitude,
        minimumLatitude,
        maximumLongitude,
        maximumLatitude,
      },
      startCoordinate: firstSegment[0],
      endCoordinate: lastSegment[lastSegment.length - 1],
    },
    rawContentHash: rawBytes === null ? null : sha256Bytes(rawBytes),
  };
}

export function normalizeServerGpx(
  rawBytes: Uint8Array,
  parsed: ServerParsedGpx,
  optionOverrides: Partial<NormalizeGeometryOptions> = {},
): NormalizedServerGpx {
  const normalized = normalizeGpxSegments(
    parsed.segments,
    rawBytes,
    optionOverrides,
  );
  if (normalized.rawContentHash === null) {
    throw new Error("Server GPX normalization requires original bytes.");
  }
  const points = parsed.segments.flatMap((segment) => segment.points);
  const elevationCount = points.filter(
    (point) => point.coordinate.length === 3,
  ).length;
  const timestampCount = points.filter((point) => point.time !== null).length;
  const flags = new Set<GpxNormalizationFlag>(parsed.flags);
  if (elevationCount === 0) flags.add("MISSING_ELEVATION");
  else if (elevationCount !== points.length) flags.add("PARTIAL_ELEVATION");
  if (timestampCount === 0) flags.add("MISSING_TIMESTAMPS");
  else if (timestampCount !== points.length) flags.add("PARTIAL_TIMESTAMPS");
  if (
    timestampCount >= 2 &&
    normalized.geometry.durationSeconds === null
  ) {
    flags.add("NON_MONOTONIC_TIME_RANGE");
  }

  return {
    schemaVersion: GPX_NORMALIZED_SCHEMA_VERSION,
    normalizationVersion: GPX_NORMALIZATION_VERSION,
    elevationAlgorithmVersion: GPX_ELEVATION_ALGORITHM_VERSION,
    rawContentHash: normalized.rawContentHash,
    normalizedGeometryHash: normalized.geometry.normalizedGeometryHash,
    directionNeutralGeometryHash:
      normalized.geometry.directionNeutralGeometryHash,
    geometry: normalized.geometry.geometry,
    pointCount: normalized.geometry.pointCount,
    segmentCount: parsed.segments.length,
    distanceM: normalized.geometry.distanceM,
    elevationGainM: normalized.geometry.elevationGainM,
    minimumElevationM: normalized.geometry.minimumElevationM,
    maximumElevationM: normalized.geometry.maximumElevationM,
    startedAt: normalized.geometry.startedAt,
    finishedAt: normalized.geometry.finishedAt,
    durationSeconds: normalized.geometry.durationSeconds,
    startCoordinate: normalized.geometry.startCoordinate,
    endCoordinate: normalized.geometry.endCoordinate,
    boundingBox: normalized.geometry.boundingBox,
    displayMetadata: { name: parsed.trackName },
    normalizationFlags: [...flags].sort(),
  };
}

function validateAndNormalizeCoordinate(coordinate: Coordinate): Coordinate {
  const longitude = coordinate[0];
  const latitude = coordinate[1];
  if (
    !Number.isFinite(longitude) ||
    !Number.isFinite(latitude) ||
    longitude < -180 ||
    longitude > 180 ||
    latitude < -90 ||
    latitude > 90
  ) {
    throw new GpxNormalizationError(
      "INVALID_COORDINATE",
      "GPX contains a non-finite or out-of-range coordinate.",
    );
  }
  if (coordinate.length === 3 && !Number.isFinite(coordinate[2])) {
    throw new GpxNormalizationError(
      "INVALID_ELEVATION",
      "GPX contains a non-finite elevation.",
    );
  }
  return normalizeCoordinateForHash(coordinate);
}

function normalizeTime(value: string | null): string | null {
  if (value === null) return null;
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
}

function nonNegativeDurationSeconds(startedAt: string, finishedAt: string): number | null {
  const duration = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  return duration < 0 ? null : Math.round(duration / 1000);
}

function round(value: number, digits: number): number {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}
